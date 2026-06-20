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
      if (this._q.length >= 100) this._q.shift(); // drop oldest to bound latency
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
      if (this._upQ.length >= 50) this._upQ.shift();
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
    this.uiClients = new Set();   // WebSocket
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

  connectUI(ws) {
    this.uiClients.add(ws);
    ws.send(JSON.stringify(this._state()), err => {
      if (err) warn('connectUI send error:', err.message);
    });
  }

  disconnectUI(ws) { this.uiClients.delete(ws); }

  _wsend(ws, s) {
    try { ws.send(s); } catch (_) { this.uiClients.delete(ws); }
  }

  broadcastState() {
    const s = JSON.stringify(this._state());
    for (const ws of this.uiClients) this._wsend(ws, s);
  }

  broadcastEvent(ev) {
    const s = JSON.stringify(ev);
    for (const ws of this.uiClients) this._wsend(ws, s);
  }

  _state() {
    return {
      type:    'state_update',
      devices: [...this.devices.values()].map(d => ({
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
    })();

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
          mgr.broadcastEvent({ type: 'event', kind: sms.event || 'sms_event', device_id: device.id, data: sms });
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
function handleUI(ws) {
  mgr.connectUI(ws);

  // Cloudflare drops idle WebSocket connections after 100s. Ping every 45s.
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
    })();
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

// ── HTTP server ───────────────────────────────────────────────────────────────
const dashboardPath = path.join(__dirname, 'dashboard.html');

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'GET' || req.url.split('?')[0] !== '/') {
    res.writeHead(404); res.end('not found'); return;
  }
  fs.readFile(dashboardPath, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Audio Bridge</h1><p>dashboard.html missing next to server.js</p>');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  });
});

// Route WebSocket upgrades
const wss = new WebSocket.Server({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url      = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/ws/ui') {
    wss.handleUpgrade(req, socket, head, ws => handleUI(ws));
    return;
  }

  if (pathname.startsWith('/ws/audio/')) {
    const deviceId = pathname.slice('/ws/audio/'.length);
    const rate     = Math.max(8000, Math.min(96000, parseInt(url.searchParams.get('rate') || '48000', 10)));
    const dirParam = url.searchParams.get('dir') || 'both';
    const dir      = ['listen', 'speak', 'both'].includes(dirParam) ? dirParam : 'both';
    wss.handleUpgrade(req, socket, head, ws => handleAudio(ws, deviceId, rate, dir));
    return;
  }

  socket.destroy();
});

// ── Start ─────────────────────────────────────────────────────────────────────
const tcpServer = net.createServer(socket => {
  handleDevice(socket).catch(e => warn('handleDevice:', e.message));
});

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  info(`TCP on :${TCP_PORT} (HMAC auth, Opus@48k)`);
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  info(`HTTP on :${HTTP_PORT}`);
  info(`Dashboard: http://localhost:${HTTP_PORT}/`);
});

process.on('SIGTERM', () => { tcpServer.close(); httpServer.close(); });
process.on('SIGINT',  () => { tcpServer.close(); httpServer.close(); process.exit(0); });
