import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { useAuthStore } from './auth.js';

const NATIVE_RATE   = 48000;
const FRAME_SAMPLES = 960;
const WAVEFORM_LEN  = 2048; // ring buffer size for waveform display

export const useWsStore = defineStore('ws', () => {
  const auth = useAuthStore();

  // ── State ──────────────────────────────────────────────────
  const connected   = ref(false);
  const authFailed  = ref(false);
  const devices     = ref([]);
  const selectedId  = ref(null);
  const smsFeed     = ref([]);
  const eventLog    = ref([]);
  const toasts      = ref([]);

  // Audio
  const audioActive = ref(false);
  const meterRx     = ref(0);
  const meterTx     = ref(0);
  const waveformRx  = ref(new Float32Array(WAVEFORM_LEN)); // ring buffer
  const waveformTx  = ref(new Float32Array(WAVEFORM_LEN));
  let   waveHead    = 0;

  // Call state
  const timerDisplay = ref('00:00');
  const speakerOn    = ref(false);
  const callVolume   = ref(7);
  const callNote     = ref('');
  const callHistory  = ref(JSON.parse(localStorage.getItem('ab-callhist') || '[]'));
  const expandedHist = ref(null);
  let   _callNum = '', _callDir = '', _callStart = 0;
  let   timerHandle = null;

  // Contacts
  const contacts = ref(JSON.parse(localStorage.getItem('ab-contacts') || '[]'));

  // ── Computed ───────────────────────────────────────────────
  const selectedDevice = computed(() => devices.value.find(d => d.id === selectedId.value) || null);

  const callPanel = computed(() => {
    const s   = selectedDevice.value?.call?.state || 'IDLE';
    const dir = selectedDevice.value?.call?.direction;
    if (s === 'DIALING') return 'dialing';
    if (s === 'RINGING' && dir === 'incoming')  return 'ringing-in';
    if (s === 'RINGING') return 'ringing-out';
    if (s === 'ACTIVE')  return 'active';
    return 'idle';
  });

  const connClass = computed(() => {
    if (authFailed.value) return 'authfail';
    return connected.value ? 'online' : 'offline';
  });

  // ── WebSocket ──────────────────────────────────────────────
  let ws = null, reconnectTimer = null, failCount = 0;

  function connect() {
    if (!auth.token) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    authFailed.value = false;
    let opened = false;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws/ui?session=${auth.token}`);

    ws.onopen  = () => { opened = true; failCount = 0; connected.value = true; authFailed.value = false; addLog('Đã kết nối', 'ev'); };
    ws.onclose = (ev) => {
      connected.value = false;
      // 4401 = server explicitly rejected auth. Everything else — including 1006
      // (abnormal close on a server restart / network blip) — must reconnect.
      if (ev.code === 4401) {
        authFailed.value = true;
        addLog('Xác thực thất bại', 'er');
        return;
      }
      if (opened) {
        // Was connected then dropped (server restart / network) → reconnect fast.
        authFailed.value = false;
        addLog('Mất kết nối — thử lại...', 'er');
        reconnectTimer = setTimeout(connect, 2000);
      } else {
        // Never established: server still coming up, or bad token. Keep retrying
        // with backoff; only hint at an auth problem after a few failures.
        failCount++;
        if (failCount >= 4) { authFailed.value = true; addLog('Không kết nối được — kiểm tra đăng nhập/server', 'er'); }
        else addLog('Chưa kết nối được — thử lại...', 'er');
        reconnectTimer = setTimeout(connect, Math.min(2000 * failCount, 10000));
      }
    };
    ws.onerror = () => {};
    ws.onmessage = ev => {
      let d; try { d = JSON.parse(ev.data); } catch (_) { return; }
      if (d.type === 'state_update') {
        devices.value = d.devices || [];
        if (!selectedId.value && devices.value.length) selectedId.value = devices.value[0].id;
        if (selectedId.value && !devices.value.find(x => x.id === selectedId.value))
          selectedId.value = devices.value[0]?.id || null;
        const sel = devices.value.find(x => x.id === selectedId.value);
        if (sel?.call?.state === 'ACTIVE' && !timerHandle) startTimer(sel.call.started_at || Date.now());
      } else if (d.type === 'event') {
        handleEvent(d.kind, d.device_id, d.data || {});
      }
    };
  }

  function disconnect() {
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connected.value = false;
    devices.value = [];
  }

  function cmd(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  // ── Events ─────────────────────────────────────────────────
  function handleEvent(kind, deviceId, payload) {
    switch (kind) {
      case 'call': {
        const s = payload.state || 'IDLE', n = payload.number || '', d = payload.direction || '';
        addLog(`Cuộc gọi · ${s}${d ? ' ('+d+')' : ''}${n ? ' · '+n : ''}`, 'ev');
        if (s === 'ACTIVE') {
          _callNum = n; _callDir = d; _callStart = payload.started_at || Date.now();
          startTimer(_callStart);
        } else if (s === 'IDLE') {
          if (_callNum) recordCall(_callNum, _callDir, _callStart > 0 ? Date.now() - _callStart : 0);
          _callNum = ''; _callDir = ''; _callStart = 0;
          stopTimer(); stopAudio(); speakerOn.value = false;
        } else if (s === 'RINGING' && d === 'incoming') {
          if (deviceId !== selectedId.value)
            showToast('ev', 'Cuộc gọi đến', `${n || 'Ẩn số'} · ${deviceId}`);
          if (Notification.permission === 'granted')
            new Notification('Cuộc gọi đến', { body: `${n || 'Ẩn số'} · ${deviceId}`, tag: 'ab-ring' });
        }
        break;
      }
      case 'sms': {
        const from = payload.from || payload.sender || 'Ẩn số';
        const body = payload.body || payload.message || '';
        addSmsToFeed(payload);
        addLog(`SMS · ${from}: ${body.slice(0, 60)}`, 'sm');
        if (deviceId === selectedId.value)
          showToast('sm', `SMS từ ${from}`, body.length > 80 ? body.slice(0, 80) + '…' : body);
        break;
      }
      case 'sms_sent':    addLog('SMS đã gửi', 'sm'); break;
      case 'sms_delivered': addLog('SMS đã giao', 'sm'); break;
      case 'error': {
        const msg = `${payload.op || 'lỗi'} · ${payload.code || ''}: ${payload.message || ''}`;
        addLog(msg, 'er');
        showToast('er', payload.op || 'Lỗi', payload.message || payload.code || '');
        break;
      }
      default: addLog(`${kind}: ${JSON.stringify(payload).slice(0, 80)}`, '');
    }
  }

  // ── Log ────────────────────────────────────────────────────
  const logEl = ref(null);
  function addLog(msg, cls = '') {
    const ts = new Date().toLocaleTimeString('vi-VN');
    eventLog.value.push({ ts, msg, cls });
    if (eventLog.value.length > 300) eventLog.value.shift();
  }

  // ── Toasts ─────────────────────────────────────────────────
  let toastSeq = 0;
  function showToast(kind, title, body) {
    const id = ++toastSeq;
    toasts.value.push({ id, kind, title, body });
    setTimeout(() => removeToast(id), 6000);
  }
  function removeToast(id) { toasts.value = toasts.value.filter(t => t.id !== id); }

  // ── Timer ──────────────────────────────────────────────────
  function startTimer(startMs) {
    stopTimer();
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      timerDisplay.value = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    };
    tick(); timerHandle = setInterval(tick, 500);
  }
  function stopTimer() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    timerDisplay.value = '00:00';
  }

  // ── Call history ───────────────────────────────────────────
  function recordCall(number, dir, dur) {
    callHistory.value.unshift({ number, dir, ts: Date.now(), dur, notes: callNote.value.trim() });
    callNote.value = '';
    if (callHistory.value.length > 50) callHistory.value.length = 50;
    localStorage.setItem('ab-callhist', JSON.stringify(callHistory.value));
  }
  function clearHistory() { callHistory.value = []; localStorage.removeItem('ab-callhist'); }

  // ── SMS ────────────────────────────────────────────────────
  function addSmsToFeed(payload) {
    const from     = payload.from || payload.sender || 'Ẩn số';
    const body     = payload.body || payload.message || '';
    const slot     = payload.sim_slot != null ? payload.sim_slot : null;
    const carrier  = payload.sim_carrier || '';
    const ts       = payload.timestamp ? payload.timestamp * (payload.timestamp < 1e11 ? 1000 : 1) : Date.now();
    const simLabel = slot != null ? `SIM${slot + 1}${carrier ? ' · ' + carrier : ''}` : (carrier || 'SIM?');
    smsFeed.value.unshift({ from, simLabel, body, ts });
    if (smsFeed.value.length > 50) smsFeed.value.length = 50;
  }

  // ── Contacts ───────────────────────────────────────────────
  function saveContacts() { localStorage.setItem('ab-contacts', JSON.stringify(contacts.value)); }
  function addContact(name, number) { contacts.value.push({ name: name.trim(), number: number.trim() }); saveContacts(); }
  function removeContact(i) { contacts.value.splice(i, 1); saveContacts(); }

  // ── Audio ──────────────────────────────────────────────────
  let audioWs = null, audioCtx = null, playNode = null, micStream = null, micNode = null, playHead = 0;

  function updateWaveform(which, pcm16) {
    let peak = 0;
    const buf = which === 'rx' ? waveformRx.value : waveformTx.value;
    for (let i = 0; i < pcm16.length; i++) {
      const f = pcm16[i] / 32768;
      buf[waveHead % WAVEFORM_LEN] = f;
      waveHead++;
      const abs = Math.abs(pcm16[i]);
      if (abs > peak) peak = abs;
    }
    // Trigger reactivity by re-assigning (Float32Array mutations aren't reactive)
    if (which === 'rx') waveformRx.value = new Float32Array(buf);
    else                waveformTx.value = new Float32Array(buf);
    const pct = Math.min(100, (peak / 32768) * 200);
    if (which === 'rx') meterRx.value = pct; else meterTx.value = pct;
  }

  function schedPCM(pcm16) {
    if (!audioCtx) return;
    const buf = audioCtx.createBuffer(1, pcm16.length, NATIVE_RATE);
    const ch  = buf.getChannelData(0);
    for (let i = 0; i < pcm16.length; i++) ch[i] = pcm16[i] / 32768;
    const s = audioCtx.createBufferSource();
    s.buffer = buf; s.connect(playNode);
    const now = audioCtx.currentTime;
    if (playHead < now + 0.05) playHead = now + 0.05;
    s.start(playHead); playHead += buf.duration;
  }

  async function startAudio(withMic) {
    if (!selectedId.value) return;
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: NATIVE_RATE });
      playNode = audioCtx.createGain(); playNode.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const dir   = withMic ? 'both' : 'listen';
    audioWs = new WebSocket(`${proto}://${location.host}/ws/audio/${selectedId.value}?rate=${NATIVE_RATE}&dir=${dir}&session=${auth.token}`);
    audioWs.binaryType = 'arraybuffer';
    audioWs.onopen    = () => { audioActive.value = true; addLog(`Âm thanh mở @ ${NATIVE_RATE}Hz · ${dir}`, 'au'); };
    audioWs.onclose   = () => { addLog('Âm thanh đóng', 'au'); _cleanAudio(); };
    audioWs.onerror   = () => addLog('Lỗi WebSocket âm thanh', 'er');
    audioWs.onmessage = ev => {
      const pcm = new Int16Array(ev.data);
      updateWaveform('rx', pcm);
      schedPCM(pcm);
    };

    if (withMic) {
      try {
        if (audioCtx.audioWorklet) {
          const src = `class P extends AudioWorkletProcessor{process(i){const c=i[0][0];if(!c)return true;const o=new Int16Array(c.length);for(let j=0;j<c.length;j++){let s=Math.max(-1,Math.min(1,c[j]));o[j]=s<0?s*0x8000:s*0x7fff;}this.port.postMessage(o.buffer,[o.buffer]);return true;}}registerProcessor('mp',P);`;
          await audioCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
        }
        micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: NATIVE_RATE, channelCount: 1 } });
        const msrc = audioCtx.createMediaStreamSource(micStream);
        micNode = new AudioWorkletNode(audioCtx, 'mp');
        micNode.port.onmessage = ev => {
          const pcm = new Int16Array(ev.data);
          updateWaveform('tx', pcm);
          if (audioWs && audioWs.readyState === 1) audioWs.send(ev.data);
        };
        msrc.connect(micNode);
      } catch (e) { addLog('Mic thất bại: ' + e.message, 'er'); }
    }
  }

  function stopAudio() {
    if (audioWs) { try { audioWs.close(); } catch (_) {} audioWs = null; }
    _cleanAudio();
  }

  function _cleanAudio() {
    if (micNode)   { try { micNode.disconnect(); } catch (_) {} micNode = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    playHead = 0; audioActive.value = false; meterRx.value = 0; meterTx.value = 0;
  }

  // ── Expose ─────────────────────────────────────────────────
  return {
    connected, authFailed, connClass, devices, selectedId, selectedDevice, callPanel,
    smsFeed, eventLog, logEl, toasts, timerDisplay, speakerOn, callVolume,
    callNote, callHistory, expandedHist, contacts,
    audioActive, meterRx, meterTx, waveformRx, waveformTx,
    connect, disconnect, cmd, addLog, showToast, removeToast,
    recordCall, clearHistory, addSmsToFeed, addContact, removeContact,
    startAudio, stopAudio,
  };
});
