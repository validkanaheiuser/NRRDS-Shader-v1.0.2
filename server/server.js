/**
 * Audio Bridge Server v4.0 - Node.js
 *
 * Wire protocol (port 59100):
 *   handshake: newline-terminated JSON + HMAC-SHA256
 *   binary frames: [1B type][4B len BE][data]
 *   types: 1=SPEAKER 2=VIRTUAL_MIC 3=CONTROL 4=CALL_STATUS 5=SMS 6=PING 7=PONG
 *
 * HTTP/WS (port 8000):
 *   GET /                      → dashboard.html
 *   WS  /ws/ui                 → control + state events
 *   WS  /ws/audio/{device_id}  → PCM audio
 *     ?rate=48000  (8000–96000)
 *     ?dir=listen|speak|both
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const net    = require('net');
const http   = require('http');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { URL } = require('url');
const WebSocket = require('ws');
const auth   = require('./auth');

// ── Protocol constants ────────────────────────────────────────────────────────
const T_SPEAKER     = 1;
const T_VIRTUAL_MIC = 2;
const T_CONTROL     = 3;
const T_CALL_STATUS = 4;
const T_SMS         = 5;
const T_PING        = 6;
const T_PONG        = 7;

const AUTH_TOKEN = process.env.AUDIO_BRIDGE_TOKEN;
if (!AUTH_TOKEN) throw new Error('AUDIO_BRIDGE_TOKEN environment variable is required');
const TCP_PORT   = parseInt(process.env.AUDIO_BRIDGE_TCP_PORT  || '59100', 10);
const HTTP_PORT  = parseInt(process.env.AUDIO_BRIDGE_HTTP_PORT || '8000',  10);

// Realtime audio jitter buffers (in 20ms frames). Smaller = lower latency but
// less tolerance for network jitter (dropped/late frames = brief audio gaps).
// Under backpressure we drop the OLDEST frame so latency never grows unbounded.
const LISTEN_Q_MAX = Math.max(2, parseInt(process.env.AUDIO_BRIDGE_LISTEN_Q || '10', 10)); // speaker→browser
const MIC_Q_MAX    = Math.max(2, parseInt(process.env.AUDIO_BRIDGE_MIC_Q    || '10', 10)); // browser→phone

const NATIVE_RATE   = 48000;
const FRAME_MS      = 20;
const FRAME_SAMPLES = NATIVE_RATE * FRAME_MS / 1000;  // 960
const FRAME_BYTES   = FRAME_SAMPLES * 2;               // 1920

// ── Optional Opus ─────────────────────────────────────────────────────────────
let _opusLib = null;

try {
  require('@discordjs/opus');
  _opusLib = 'discordjs';
  info('Opus: @discordjs/opus');
} catch (_) {
  try {
    require('opusscript');
    _opusLib = 'opusscript';
    info('Opus: opusscript');
  } catch (_2) {
    warn('No Opus library - audio bridging disabled');
    warn('  npm install @discordjs/opus   (requires build tools)');
    warn('  npm install opusscript        (WebAssembly, no build needed)');
  }
}

const HAS_OPUS = _opusLib !== null;

// ── Logging ───────────────────────────────────────────────────────────────────
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function info(...a)  { console.log( `${ts()} [INFO]`, ...a); }
function warn(...a)  { console.warn(`${ts()} [WARN]`, ...a); }

// ── Opus codec ────────────────────────────────────────────────────────────────
class OpusCodec {
  constructor(bitrate) {
    this._c = null;
    if (!HAS_OPUS) return;
    try {
      if (_opusLib === 'discordjs') {
        const { OpusEncoder } = require('@discordjs/opus');
        this._c = new OpusEncoder(NATIVE_RATE, 1);
        this._c.setBitrate(bitrate);
      } else {
        const OS = require('opusscript');
        this._c = new OS(NATIVE_RATE, 1, OS.Application.VOIP);
        this._c.setBitrate(bitrate);
      }
    } catch (e) {
      warn('OpusCodec init:', e.message);
    }
  }

  decode(pkt) {
    if (!this._c || !pkt || !pkt.length) return Buffer.alloc(FRAME_BYTES, 0);
    try {
      const pcm = _opusLib === 'opusscript'
        ? this._c.decode(pkt, FRAME_SAMPLES)
        : this._c.decode(pkt);
      return Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    } catch (_) {
      return Buffer.alloc(FRAME_BYTES, 0); // loss concealment: silence
    }
  }

  encode(pcm) {
    if (!this._c || !pcm || pcm.length < FRAME_BYTES) return null;
    try {
      const src = pcm.slice(0, FRAME_BYTES);
      const pkt = _opusLib === 'opusscript'
        ? this._c.encode(src, FRAME_SAMPLES)
        : this._c.encode(src);
      return Buffer.isBuffer(pkt) ? pkt : Buffer.from(pkt);
    } catch (_) {
      return null;
    }
  }
}

// ── Sample-rate conversion (linear interpolation) ─────────────────────────────
// Good enough for VoIP; the common case is 48kHz↔48kHz (pass-through).
function resample(pcm, inRate, outRate) {
  if (inRate === outRate) return pcm;
  const inSamples  = pcm.length >> 1;
  const outSamples = Math.round(inSamples * outRate / inRate);
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos  = i * inRate / outRate;
    const lo   = pos | 0;
    const hi   = Math.min(lo + 1, inSamples - 1);
    const frac = pos - lo;
    const a    = pcm.readInt16LE(lo * 2);
    const b    = pcm.readInt16LE(hi * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}

// ── Frame parser (TCP) ────────────────────────────────────────────────────────
// Accumulates raw bytes and resolves a promise per complete frame.
class FrameReader {
  constructor() {
    this._buf    = Buffer.alloc(0);
    this._frames = [];
    this._waiter = null; // { resolve, reject }
    this._dead   = false;
  }

  push(chunk) {
    if (this._dead) return;
    this._buf = Buffer.concat([this._buf, chunk]);
    while (this._buf.length >= 5) {
      const len = this._buf.readUInt32BE(1);
      if (this._buf.length < 5 + len) break;
      const frame = { type: this._buf[0], data: Buffer.from(this._buf.slice(5, 5 + len)) };
      this._buf = this._buf.slice(5 + len);
      if (this._waiter) {
        const { resolve } = this._waiter;
        this._waiter = null;
        resolve(frame);
      } else {
        this._frames.push(frame);
      }
    }
  }

  next() {
    if (this._dead)          return Promise.reject(new Error('closed'));
    if (this._frames.length) return Promise.resolve(this._frames.shift());
    return new Promise((resolve, reject) => { this._waiter = { resolve, reject }; });
  }

  abort(err) {
    this._dead = true;
    if (this._waiter) { this._waiter.reject(err || new Error('closed')); this._waiter = null; }
  }
}

// ── UIListener - one browser audio connection (speaker → client) ──────────────
class UIListener {
  constructor(rate) {
    this.rate    = rate;
    this._q      = [];
    this._waiter = null;
    this._dead   = false;
  }

  deliver(pcm48) {
    const pcm = resample(pcm48, NATIVE_RATE, this.rate);
    if (!pcm.length) return;
    if (this._waiter) {
      const res = this._waiter; this._waiter = null; res(pcm);
    } else {
      if (this._q.length >= LISTEN_Q_MAX) this._q.shift(); // drop oldest to bound latency
      this._q.push(pcm);
    }
  }

  next() {
    if (this._dead)    return Promise.resolve(null);
    if (this._q.length) return Promise.resolve(this._q.shift());
    return new Promise(res => { this._waiter = res; });
  }

  close() {
    this._dead = true;
    if (this._waiter) { this._waiter(null); this._waiter = null; }
  }
}

// ── MicUploader - accumulates browser PCM into 20ms frames for the phone ──────
class MicUploader {
  constructor(hub, srcRate) {
    this.hub     = hub;
    this.srcRate = srcRate;
    this._buf    = Buffer.alloc(0);
  }

  feed(raw) {
    const pcm48 = resample(raw instanceof Buffer ? raw : Buffer.from(raw), this.srcRate, NATIVE_RATE);
    this._buf = Buffer.concat([this._buf, pcm48]);
    while (this._buf.length >= FRAME_BYTES) {
      this.hub.queueMicFrame(Buffer.from(this._buf.slice(0, FRAME_BYTES)));
      this._buf = this._buf.slice(FRAME_BYTES);
    }
  }
}

// ── AudioHub - per-device fanout (speaker → listeners, mic → phone) ───────────
class AudioHub {
  constructor() {
    this._down     = new OpusCodec(64000); // decode phone speaker
    this._up       = new OpusCodec(32000); // encode browser mic
    this.listeners = new Set();
    this._upQ      = [];
    this._upWaiter = null;
    this._dead     = false;
  }

  addListener(l)    { this.listeners.add(l); }
  removeListener(l) { this.listeners.delete(l); }

  onSpeakerOpus(pkt) {
    const pcm = this._down.decode(pkt);
    if (!pcm.length) return;
    for (const l of this.listeners) l.deliver(pcm);
  }

  queueMicFrame(pcm48) {
    const pkt = this._up.encode(pcm48);
    if (!pkt) return;
    if (this._upWaiter) {
      const res = this._upWaiter; this._upWaiter = null; res(pkt);
    } else {
      if (this._upQ.length >= MIC_Q_MAX) this._upQ.shift();
      this._upQ.push(pkt);
    }
  }

  nextMicPacket() {
    if (this._dead)     return Promise.resolve(null);
    if (this._upQ.length) return Promise.resolve(this._upQ.shift());
    return new Promise(res => { this._upWaiter = res; });
  }

  close() {
    this._dead = true;
    if (this._upWaiter) { this._upWaiter(null); this._upWaiter = null; }
    for (const l of this.listeners) l.close();
  }
}

// ── Device ────────────────────────────────────────────────────────────────────
class Device {
  constructor(socket, info) {
    this.socket        = socket;
    this.id            = info.id      || 'unknown';
    this.name          = info.name    || 'Unknown';
    this.brand         = info.brand   || '';
    this.android       = info.android || '';
    this.callState     = 'IDLE';
    this.callDirection = 'unknown';
    this.activeNumber  = '';
    this.callStartedAt = 0;
    this.callMuted     = false;
    this.connected     = true;
    this.audio         = new AudioHub();
  }

  applyCallEvent(p) {
    this.callState     = p.state     || 'IDLE';
    this.callDirection = p.direction || 'unknown';
    this.activeNumber  = p.number    || '';
    this.callStartedAt = parseInt(p.started_at || 0, 10);
    this.callMuted     = !!p.muted;
    if (this.callState === 'IDLE') {
      this.callDirection = 'unknown';
      this.activeNumber  = '';
      this.callStartedAt = 0;
      this.callMuted     = false;
    }
  }

  sendFrame(type, data) {
    if (!this.connected) return;
    const hdr = Buffer.allocUnsafe(5);
    hdr.writeUInt8(type, 0);
    hdr.writeUInt32BE(data.length, 1);
    try {
      this.socket.write(Buffer.concat([hdr, data]));
    } catch (e) {
      warn('sendFrame', this.id, e.message);
      this.connected = false;
    }
  }

  sendControl(command, extra = {}) {
    this.sendFrame(T_CONTROL, Buffer.from(JSON.stringify({ command, ...extra })));
  }
}

// ── DeviceManager ─────────────────────────────────────────────────────────────
class DeviceManager {
  constructor() {
    this.devices   = new Map();   // id → Device
    this.uiClients = new Map();   // ws → session
  }

  add(d) {
    this.devices.set(d.id, d);
    info(`Device connected: ${d.name} (${d.id}) ${d.brand} Android ${d.android}`);
    this.broadcastState();
  }

  remove(d) {
    this.devices.delete(d.id);
    info('Device disconnected:', d.id);
    this.broadcastState();
  }

  connectUI(ws, session) {
    this.uiClients.set(ws, session);
    ws.send(JSON.stringify(this._stateFor(session)), err => {
      if (err) warn('connectUI send error:', err.message);
    });
  }

  disconnectUI(ws) { this.uiClients.delete(ws); }

  _wsend(ws, s) {
    try { ws.send(s); } catch (_) { this.uiClients.delete(ws); }
  }

  _allowedIds(session) {
    if (!session || session.role === 'admin') return null; // null = all
    return auth.getUserDevices(session.user_id);
  }

  broadcastState() {
    for (const [ws, session] of this.uiClients) {
      this._wsend(ws, JSON.stringify(this._stateFor(session)));
    }
  }

  broadcastEvent(ev) {
    const s = JSON.stringify(ev);
    for (const [ws, session] of this.uiClients) {
      const allowed = this._allowedIds(session);
      if (!allowed || allowed.includes(ev.device_id)) this._wsend(ws, s);
    }
  }

  _stateFor(session) {
    const allowed = this._allowedIds(session);
    return {
      type:    'state_update',
      devices: [...this.devices.values()]
        .filter(d => !allowed || allowed.includes(d.id))
        .map(d => ({
          id: d.id, name: d.name, brand: d.brand, android: d.android,
          call: {
            state:      d.callState,
            direction:  d.callDirection,
            number:     d.activeNumber,
            started_at: d.callStartedAt,
            muted:      d.callMuted,
          },
        })),
    };
  }
}

const mgr = new DeviceManager();

// ── TCP: handshake ────────────────────────────────────────────────────────────
function handshake(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('handshake timeout')), 10_000);
    let raw = Buffer.alloc(0);

    const onData = chunk => {
      raw = Buffer.concat([raw, chunk]);
      const nl = raw.indexOf(0x0a);
      if (nl === -1) return;

      clearTimeout(timer);
      socket.removeListener('data', onData);

      const line = raw.slice(0, nl).toString('utf8');
      const rest = raw.slice(nl + 1); // bytes after the handshake line

      let info;
      try { info = JSON.parse(line); } catch (e) { return reject(e); }

      const devId   = info.id    || '';
      const date    = info.date  || '';
      const nonce   = info.nonce || '';
      const recvMac = (info.hmac || '').toLowerCase();
      const wantMac = crypto.createHmac('sha256', AUTH_TOKEN)
        .update(`${devId}-${date}-${nonce}`).digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(recvMac), Buffer.from(wantMac))) {
        return reject(new Error('invalid hmac'));
      }
      resolve({ info, rest });
    };

    socket.on('data', onData);
    socket.once('error', e => { clearTimeout(timer); reject(e); });
    socket.once('close', () => { clearTimeout(timer); reject(new Error('closed during handshake')); });
  });
}

// ── TCP: device handler ───────────────────────────────────────────────────────
async function handleDevice(socket) {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  info('TCP connect from', addr);

  let device = null;
  const reader = new FrameReader();
  let uplinkAlive = true;

  try {
    let info, rest;
    try {
      ({ info, rest } = await handshake(socket));
    } catch (e) {
      warn('Handshake failed from', addr, '-', e.message);
      try { socket.write(`{"status":"error","msg":"${e.message}"}\n`); } catch (_) {}
      socket.destroy();
      return;
    }

    socket.write('{"status":"ok"}\n');

    // Attach frame reader now; feed any bytes that arrived after the handshake line
    socket.on('data',  chunk => reader.push(chunk));
    socket.on('close', ()    => reader.abort(new Error('socket closed')));
    socket.on('error', e     => reader.abort(e));
    if (rest.length) reader.push(rest);

    device = new Device(socket, info);
    mgr.add(device);

    // Uplink pump: mic packets → phone (runs concurrently with main loop)
    (async () => {
      while (uplinkAlive && device.connected) {
        const pkt = await device.audio.nextMicPacket();
        if (!pkt) break;
        device.sendFrame(T_VIRTUAL_MIC, pkt);
      }
    })().catch(e => warn('uplink pump', device && device.id, e && e.message));

    // Main receive loop
    while (device.connected) {
      const { type, data } = await reader.next();

      switch (type) {
        case T_SPEAKER:
          device.audio.onSpeakerOpus(data);
          break;

        case T_CALL_STATUS: {
          let payload;
          try { payload = JSON.parse(data.toString()); } catch (_) { break; }
          const ptype = payload.type || 'call';
          if (ptype === 'call') {
            device.applyCallEvent(payload);
            mgr.broadcastState();
            mgr.broadcastEvent({ type: 'event', kind: 'call', device_id: device.id, data: payload });
          } else if (ptype === 'error') {
            warn('device error', device.id, JSON.stringify(payload));
            mgr.broadcastEvent({ type: 'event', kind: 'error', device_id: device.id, data: payload });
          } else {
            mgr.broadcastEvent({ type: 'event', kind: ptype, device_id: device.id, data: payload });
          }
          break;
        }

        case T_SMS: {
          let sms;
          try { sms = JSON.parse(data.toString()); } catch (_) { break; }
          // received SMS: type='sms'; sent/delivered result: event='sms_sent'/'sms_delivered'
          const smsKind = sms.type === 'sms' ? 'sms' : (sms.event || 'sms');
          mgr.broadcastEvent({ type: 'event', kind: smsKind, device_id: device.id, data: sms });
          break;
        }

        case T_PING:
          device.sendFrame(T_PONG, Buffer.alloc(0));
          break;
        // T_PONG: silently ignored
      }
    }
  } catch (e) {
    if (e.message !== 'socket closed' && e.message !== 'closed') {
      warn(`Device ${addr}:`, e.message);
    }
  } finally {
    uplinkAlive = false;
    if (device) {
      device.connected = false;
      device.audio.close();
      mgr.remove(device);
    }
    reader.abort(new Error('cleanup'));
    try { socket.destroy(); } catch (_) {}
  }
}

// ── WS: /ws/ui ───────────────────────────────────────────────────────────────
function handleUI(ws, session) {
  mgr.connectUI(ws, session);

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 45_000);

  ws.on('pong', () => {});

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (_) { return; }

    const cmd = data.command;
    const did = data.device_id;
    if (!did || !mgr.devices.has(did)) return;

    // Authorization: non-admin can only control assigned devices
    if (session.role !== 'admin') {
      const allowed = auth.getUserDevices(session.user_id);
      if (!allowed.includes(did)) return;
    }

    const d = mgr.devices.get(did);
    try {
      switch (cmd) {
        case 'dial':        d.sendControl('dial',        { number: data.number }); break;
        case 'hangup':      d.sendControl('hangup'); break;
        case 'answer':      d.sendControl('answer'); break;
        case 'mute':        d.sendControl('mute',        { on: !!data.on }); break;
        case 'send_sms':    d.sendControl('send_sms',    { number: data.number, message: data.message }); break;
        case 'dtmf':        d.sendControl('dtmf',        { digit: String(data.digit || '') }); break;
        case 'audio_route': d.sendControl('audio_route', { route: String(data.route || 'earpiece') }); break;
        case 'volume':      d.sendControl('volume',      { level: parseInt(data.level || 7, 10) }); break;
        case 'set_sim_filter': d.sendControl('set_sim_filter', { allowed_sims: data.allowed_sims || [] }); break;
        default:            warn('unknown ui command:', cmd);
      }
    } catch (e) {
      warn(`send_control ${cmd} → ${did}: ${e.message}`);
    }
  });

  ws.on('close', () => { clearInterval(ping); mgr.disconnectUI(ws); });
  ws.on('error', e  => { clearInterval(ping); warn('ui ws:', e.message); });
}

// ── WS: /ws/audio/{device_id} ─────────────────────────────────────────────────
function handleAudio(ws, deviceId, rate, dir) {
  const device = mgr.devices.get(deviceId);
  if (!device) { ws.close(4404, 'device not found'); return; }

  const hub        = device.audio;
  const wantListen = dir === 'listen' || dir === 'both';
  const wantSpeak  = dir === 'speak'  || dir === 'both';

  const listener = wantListen ? new UIListener(rate) : null;
  const uploader = wantSpeak  ? new MicUploader(hub, rate) : null;

  if (listener) hub.addListener(listener);

  // Pump speaker frames → client
  let pumpAlive = true;
  if (listener) {
    (async () => {
      while (pumpAlive) {
        const pcm = await listener.next();
        if (!pcm) break;
        try { ws.send(pcm); } catch (_) { break; }
      }
    })().catch(e => warn('audio pump', deviceId, e && e.message));
  }

  ws.on('message', msg => {
    // Text: optional JSON rate-change control
    if (typeof msg === 'string') {
      try {
        const j = JSON.parse(msg);
        const nr = parseInt(j.rate, 10);
        if (nr && nr !== rate) {
          rate = nr;
          if (listener) listener.rate = nr;
          if (uploader) uploader.srcRate = nr;
        }
      } catch (_) {}
      return;
    }
    // Binary: PCM from browser mic
    if (uploader) uploader.feed(msg instanceof Buffer ? msg : Buffer.from(msg));
  });

  ws.on('close', () => {
    pumpAlive = false;
    if (listener) { listener.close(); hub.removeListener(listener); }
  });

  ws.on('error', e => warn('audio ws:', e.message));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

function sessionFromReq(req) {
  const auth_hdr = req.headers['authorization'] || '';
  const token = auth_hdr.startsWith('Bearer ') ? auth_hdr.slice(7) : null;
  return token ? auth.getSession(token) : null;
}

function requireAdmin(req, res) {
  const session = sessionFromReq(req);
  if (!session)                 { json(res, 401, { error: 'Chưa đăng nhập' }); return null; }
  if (session.role !== 'admin') { json(res, 403, { error: 'Chỉ admin' });      return null; }
  return session;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.woff2':'font/woff2',
};

const PUBLIC = path.join(__dirname, 'public');

function serveStatic(res, filePath) {
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const full = path.join(PUBLIC, filePath);
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── API ───────────────────────────────────────────────────────────────────────
async function handleAPI(req, res, url) {
  const p = url.pathname;

  res.setHeader('Access-Control-Allow-Origin',  req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/login
  if (p === '/api/login' && req.method === 'POST') {
    const { username, password } = await readBody(req);
    const user = auth.verifyUser(username || '', password || '');
    if (!user) return json(res, 401, { error: 'Sai tên đăng nhập hoặc mật khẩu' });
    const token = auth.createSession(user.id);
    return json(res, 200, { token, user: { id: user.id, username: user.username, role: user.role } });
  }

  // POST /api/logout
  if (p === '/api/logout' && req.method === 'POST') {
    const session = sessionFromReq(req);
    if (session) auth.deleteSession(session.token);
    return json(res, 200, { ok: true });
  }

  // GET /api/me
  if (p === '/api/me' && req.method === 'GET') {
    const session = sessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Chưa đăng nhập' });
    return json(res, 200, { id: session.user_id, username: session.username, role: session.role });
  }

  // GET /api/devices
  if (p === '/api/devices' && req.method === 'GET') {
    const session = sessionFromReq(req);
    if (!session) return json(res, 401, { error: 'Chưa đăng nhập' });
    const allowed = session.role === 'admin' ? null : auth.getUserDevices(session.user_id);
    const devs = [...mgr.devices.values()]
      .filter(d => !allowed || allowed.includes(d.id))
      .map(d => ({ id: d.id, name: d.name, brand: d.brand, android: d.android }));
    return json(res, 200, devs);
  }

  // ── Admin: users ──────────────────────────────────────────────────────────

  if (p === '/api/admin/users' && req.method === 'GET') {
    if (!requireAdmin(req, res)) return;
    const users = auth.getAllUsers().map(u => ({
      ...u, devices: auth.getUserDevices(u.id),
    }));
    return json(res, 200, users);
  }

  if (p === '/api/admin/users' && req.method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const { username, password, role } = await readBody(req);
    if (!username || !password) return json(res, 400, { error: 'username và password là bắt buộc' });
    try {
      auth.createUser(username, password, role === 'admin' ? 'admin' : 'user');
      return json(res, 201, { ok: true });
    } catch (e) {
      return json(res, 409, { error: 'Tên đăng nhập đã tồn tại' });
    }
  }

  const adminUserMatch = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (adminUserMatch) {
    const uid = parseInt(adminUserMatch[1], 10);
    if (!requireAdmin(req, res)) return;

    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.password) auth.updateUserPassword(uid, body.password);
      if (body.role)     auth.updateUserRole(uid, body.role === 'admin' ? 'admin' : 'user');
      if (body.devices !== undefined) auth.setUserDevices(uid, Array.isArray(body.devices) ? body.devices : []);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'DELETE') {
      auth.deleteUser(uid);
      return json(res, 200, { ok: true });
    }
  }

  json(res, 404, { error: 'not found' });
}

// ── HTTP server ───────────────────────────────────────────────────────────────
auth.ensureAdmin();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    await handleAPI(req, res, url);
    return;
  }
  // Serve Vue SPA static files
  const p = url.pathname === '/' ? '/index.html' : url.pathname;
  serveStatic(res, p);
});

// Route WebSocket upgrades
const wss = new WebSocket.Server({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const token    = url.searchParams.get('session');
  const session  = auth.getSession(token);

  if (pathname === '/ws/ui') {
    if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => handleUI(ws, session));
    return;
  }

  if (pathname.startsWith('/ws/audio/')) {
    if (!session) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const deviceId = pathname.slice('/ws/audio/'.length);
    if (session.role !== 'admin') {
      const allowed = auth.getUserDevices(session.user_id);
      if (!allowed.includes(deviceId)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    }
    const rate     = Math.max(8000, Math.min(96000, parseInt(url.searchParams.get('rate') || '48000', 10)));
    const dirParam = url.searchParams.get('dir') || 'both';
    const dir      = ['listen', 'speak', 'both'].includes(dirParam) ? dirParam : 'both';
    wss.handleUpgrade(req, socket, head, ws => handleAudio(ws, deviceId, rate, dir));
    return;
  }

  socket.destroy();
});

// ── Process-level safety net ──────────────────────────────────────────────────
// The server multiplexes many devices + UI clients. A single stray throw or
// rejected promise anywhere must NOT take the whole process down (that would
// drop EVERY device at once). Log and keep serving; per-connection handlers
// already isolate and clean up their own failures.
process.on('uncaughtException',  e => warn('uncaughtException:',  (e && e.stack) || e));
process.on('unhandledRejection', e => warn('unhandledRejection:', (e && e.stack) || e));

// ── Start ─────────────────────────────────────────────────────────────────────
const tcpServer = net.createServer(socket => {
  // Attach an error handler immediately: a socket RST during the handshake
  // window (before handleDevice wires its own listeners) would otherwise emit
  // an unhandled 'error' and crash the process.
  socket.on('error', e => warn('tcp socket:', e && e.message));
  handleDevice(socket).catch(e => warn('handleDevice:', e && e.message));
});

// A failed listen (esp. EADDRINUSE) must be LOUD and fatal — otherwise the
// process keeps running half-bound (e.g. HTTP up but the device port :59100
// dead), which looks "started" but silently accepts no devices.
function onListenError(name, port) {
  return (e) => {
    if (e && e.code === 'EADDRINUSE') {
      warn(`FATAL: ${name} port ${port} is already in use.`);
      warn(`  Another instance is still running, or another app owns the port.`);
      warn(`  Stop it (or change the port in .env) and start again. Exiting.`);
      process.exit(1);
    }
    warn(`${name} server error:`, e && e.message);
  };
}
tcpServer.on('error',  onListenError('TCP',  TCP_PORT));
httpServer.on('error', onListenError('HTTP', HTTP_PORT));

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  info(`TCP on :${TCP_PORT} (HMAC auth, Opus@48k)`);
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  info(`HTTP on :${HTTP_PORT}`);
  info(`Dashboard: http://localhost:${HTTP_PORT}/`);
});

process.on('SIGTERM', () => { tcpServer.close(); httpServer.close(); });
process.on('SIGINT',  () => { tcpServer.close(); httpServer.close(); process.exit(0); });
