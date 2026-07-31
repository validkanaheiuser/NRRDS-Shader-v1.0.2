<template>
  <div class="layout">
    <AppSidebar />

    <div class="main" :class="{ 'call-active': ws.callPanel === 'active' }">
      <!-- Tab bar -->
      <nav class="tab-bar">
        <button v-for="t in TABS" :key="t.id" :class="['tab', { active: tab === t.id }]" @click="tab = t.id">
          {{ t.label }}
          <span v-if="t.id === 'call' && ws.callPanel !== 'idle'" class="tab-badge">●</span>
          <span v-if="t.id === 'messages' && ws.smsFeed.length" class="tab-badge">{{ ws.smsFeed.length }}</span>
        </button>
      </nav>

      <div class="tab-content">

        <!-- ═══ TỔNG QUAN ════════════════════════════════════ -->
        <div v-show="tab === 'overview'" class="tab-pane">
          <div v-if="!ws.selectedDevice" class="empty-state">
            <div class="empty-icon">◎</div>
            <div>Chọn thiết bị ở thanh bên</div>
          </div>
          <template v-else>
            <div class="card">
              <div class="card-title">Thiết bị</div>
              <div class="kv"><span class="kv-k">Tên</span><span class="kv-v">{{ ws.selectedDevice.name || '—' }}</span></div>
              <div class="kv"><span class="kv-k">Hãng</span><span class="kv-v">{{ ws.selectedDevice.brand || '—' }}</span></div>
              <div class="kv"><span class="kv-k">Android</span><span class="kv-v">{{ ws.selectedDevice.android || '—' }}</span></div>
              <div class="kv"><span class="kv-k">ID</span><span class="kv-v" style="font-size:.7rem">{{ ws.selectedId }}</span></div>
            </div>

            <div class="card">
              <div class="card-title">Cuộc gọi</div>
              <div class="kv">
                <span class="kv-k">Trạng thái</span>
                <span :class="['kv-v', callStateClass]">{{ callStateLabel }}</span>
              </div>
              <div class="kv" v-if="ws.selectedDevice.call?.number">
                <span class="kv-k">Số</span>
                <span class="kv-v">{{ ws.selectedDevice.call.number }}</span>
              </div>
              <div class="kv" v-if="ws.callPanel === 'active'">
                <span class="kv-k">Thời gian</span>
                <span class="kv-v">{{ ws.timerDisplay }}</span>
              </div>
            </div>

            <!-- Waveform (overview — shows RX if audio active) -->
            <div class="card">
              <div class="card-title" style="display:flex;align-items:center;gap:.5rem;">
                Sóng âm thanh
                <span v-if="!ws.audioActive" style="font-size:.67rem;color:var(--muted);">(chỉ hiển thị khi nghe)</span>
              </div>
              <WaveformMeter :samples="ws.waveformRx" :active="ws.audioActive" :width="500" :height="60" />
              <div v-if="ws.audioActive" style="margin-top:.5rem;">
                <div class="meter-row"><span class="meter-lbl">RX</span><div class="meter-track"><div class="meter-fill" :style="{width:ws.meterRx+'%'}"></div></div></div>
                <div class="meter-row"><span class="meter-lbl">TX</span><div class="meter-track"><div class="meter-fill" :style="{width:ws.meterTx+'%'}"></div></div></div>
              </div>
            </div>
          </template>
        </div>

        <!-- ═══ CUỘC GỌI ════════════════════════════════════ -->
        <div v-show="tab === 'call'" class="tab-pane call-pane">
          <div v-if="!ws.selectedId" class="empty-state">
            <div class="empty-icon">☎</div>
            <div>Chọn thiết bị trước</div>
          </div>
          <div v-else class="call-layout">

            <!-- Left -->
            <div class="call-left">

              <!-- Quick contacts (horizontal scroll) -->
              <div class="quick-contacts-bar">
                <button class="btn-ghost qc-open-btn" @click="showContacts = !showContacts">
                  {{ showContacts ? '✕' : '☆' }} Danh bạ nhanh
                </button>
                <div v-if="ws.contacts.length" class="qc-scroll">
                  <button
                    v-for="c in ws.contacts" :key="c.number"
                    class="qc-chip"
                    @click="dialContact(c)"
                    :title="c.number"
                  >
                    <span class="qc-name">{{ c.name }}</span>
                    <span class="qc-num">{{ c.number }}</span>
                  </button>
                </div>
                <div v-else class="qc-empty">Thêm liên hệ trong Cài đặt</div>
              </div>

              <!-- IDLE: dialpad -->
              <template v-if="ws.callPanel === 'idle'">
                <div :class="['num-display', { ph: !phoneNum }]">{{ phoneNum || 'Nhập số...' }}</div>
                <div class="dialpad-actions-top">
                  <button class="btn-icon" @click="phoneNum = phoneNum.slice(0,-1)">⌫</button>
                  <button v-if="ws.callHistory.length" class="btn-ghost" @click="dialNumber(ws.callHistory[0].number)" style="font-size:.72rem;">
                    Gọi lại
                  </button>
                </div>
                <div class="dialpad">
                  <div v-for="k in KEYS" :key="k.d" class="key" @click="phoneNum += k.d">
                    <span class="key-d">{{ k.d }}</span>
                    <span class="key-l">{{ k.l }}</span>
                  </div>
                </div>
                <button class="btn btn-p call-btn" :disabled="!phoneNum" @click="dial">Gọi</button>
              </template>

              <!-- DIALING -->
              <template v-else-if="ws.callPanel === 'dialing'">
                <div class="cs-center">
                  <div class="cs-state">Đang kết nối</div>
                  <div class="cs-number">{{ ws.selectedDevice?.call?.number || phoneNum }}</div>
                  <div class="cs-sub warn">Đang đặt cuộc gọi…</div>
                  <div class="cs-actions"><button class="btn btn-d" @click="hangup">Hủy</button></div>
                </div>
              </template>

              <!-- RINGING OUT -->
              <template v-else-if="ws.callPanel === 'ringing-out'">
                <div class="cs-center">
                  <div class="cs-state">Đổ chuông</div>
                  <div class="cs-number">{{ ws.selectedDevice?.call?.number }}</div>
                  <div class="cs-sub warn">Chờ người nhận…</div>
                  <div class="cs-actions"><button class="btn btn-d" @click="hangup">Hủy</button></div>
                </div>
              </template>

              <!-- ACTIVE -->
              <template v-else-if="ws.callPanel === 'active'">
                <div class="active-header">
                  <div class="active-timer">{{ ws.timerDisplay }}</div>
                  <div class="active-num mono">{{ ws.selectedDevice?.call?.number }}</div>
                </div>

                <!-- Waveform during call -->
                <div class="call-waveform">
                  <WaveformMeter :samples="ws.waveformRx" :active="ws.audioActive" :height="44" />
                </div>

                <div class="call-ctrl-row">
                  <button :class="['btn-icon', { active: ws.selectedDevice?.call?.muted }]" @click="toggleMute" title="Tắt mic">🎙</button>
                  <button :class="['btn-icon', { active: ws.speakerOn }]" @click="toggleSpeaker" title="Loa ngoài">🔊</button>
                  <button class="btn btn-d" @click="hangup" style="flex:1;">Kết thúc</button>
                </div>

                <div class="vol-row">
                  <span class="dim" style="font-size:.67rem;">Âm lượng</span>
                  <input type="range" min="0" max="15" v-model.number="ws.callVolume" @change="applyVolume">
                  <span class="mono" style="font-size:.72rem;">{{ ws.callVolume }}</span>
                </div>

                <!-- Audio controls -->
                <div class="audio-btns">
                  <template v-if="!ws.audioActive">
                    <button class="btn-ghost" @click="ws.startAudio(false)" style="flex:1;">Nghe</button>
                    <button class="btn-ghost" @click="ws.startAudio(true)" style="flex:1;">Nói</button>
                  </template>
                  <template v-else>
                    <div class="meters">
                      <div class="meter-row"><span class="meter-lbl">RX</span><div class="meter-track"><div class="meter-fill" :style="{width:ws.meterRx+'%'}"></div></div></div>
                      <div class="meter-row"><span class="meter-lbl">TX</span><div class="meter-track"><div class="meter-fill" :style="{width:ws.meterTx+'%'}"></div></div></div>
                    </div>
                    <button class="btn-ghost" @click="ws.stopAudio()" style="color:var(--danger);margin-top:.3rem;">Dừng âm thanh</button>
                  </template>
                </div>

                <!-- DTMF collapsible -->
                <button class="section-toggle" @click="showDtmf = !showDtmf">
                  DTMF <span :class="['toggle-chevron', { open: showDtmf }]">▾</span>
                </button>
                <div v-if="showDtmf" class="dialpad dialpad-sm">
                  <div v-for="k in KEYS" :key="'dt'+k.d" class="key key-sm" @click="sendDtmf(k.d)">
                    <span class="key-d" style="font-size:14px">{{ k.d }}</span>
                  </div>
                </div>

                <!-- Notes -->
                <button class="section-toggle" @click="showNotes = !showNotes">
                  Ghi chú <span :class="['toggle-chevron', { open: showNotes }]">▾</span>
                </button>
                <textarea v-if="showNotes" class="ta call-note-ta" v-model="ws.callNote" placeholder="Ghi chú về cuộc gọi này…"></textarea>
              </template>

            </div>

            <!-- Right: history -->
            <div class="call-right">
              <div class="hist-header">
                <h3>Lịch sử gọi</h3>
                <button v-if="ws.callHistory.length" class="btn-ghost" @click="ws.clearHistory()" style="font-size:.68rem;">Xóa</button>
              </div>
              <div v-if="!ws.callHistory.length" class="inbox-empty">Chưa có lịch sử</div>
              <div v-for="(h, i) in ws.callHistory" :key="h.ts" class="hist-item">
                <div class="hist-row" @click="ws.expandedHist = ws.expandedHist === i ? null : i">
                  <span :class="['hist-dir', h.dir === 'incoming' ? 'in' : 'out']">{{ h.dir === 'incoming' ? '↓' : '↑' }}</span>
                  <span class="hist-num mono">{{ h.number || 'Ẩn số' }}</span>
                  <span class="hist-ts">{{ fmtRelTime(h.ts) }}</span>
                  <span class="hist-dur mono">{{ fmtDur(h.dur) }}</span>
                </div>
                <div v-if="ws.expandedHist === i" class="hist-expanded">
                  <div v-if="h.notes" class="hist-notes">{{ h.notes }}</div>
                  <div v-else class="hist-notes-em">Không có ghi chú</div>
                  <button class="btn-ghost" @click="dialNumber(h.number)" style="font-size:.7rem;">Gọi lại</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ═══ TIN NHẮN ════════════════════════════════════ -->
        <div v-show="tab === 'messages'" class="tab-pane msg-pane">
          <div v-if="!ws.selectedId" class="empty-state">
            <div class="empty-icon">✉</div>
            <div>Chọn thiết bị trước</div>
          </div>
          <template v-else>
            <div class="msg-compose">
              <div class="msg-to-row">
                <input class="inp" v-model="smsTo" placeholder="Số điện thoại người nhận">
              </div>
              <div style="display:flex;gap:.5rem;align-items:flex-end;">
                <textarea class="ta" v-model="smsBody" placeholder="Nội dung tin nhắn…" @keydown.ctrl.enter="sendSms" @keydown.meta.enter="sendSms" style="flex:1;min-height:64px;"></textarea>
                <button class="btn btn-p" :disabled="!smsTo || !smsBody" @click="sendSms" style="padding:.45rem 1rem;">Gửi</button>
              </div>
            </div>
            <div class="msg-inbox">
              <div class="msg-inbox-hdr">
                Hộp thư
                <span v-if="ws.smsFeed.length" class="dim">({{ ws.smsFeed.length }})</span>
                <button v-if="ws.smsFeed.length" class="btn-ghost" @click="ws.smsFeed = []" style="margin-left:auto;font-size:.68rem;">Xóa</button>
              </div>
              <div v-if="!ws.smsFeed.length" class="inbox-empty">Chưa có tin nhắn</div>
              <div v-for="(m, i) in ws.smsFeed" :key="i" class="sms-item">
                <div class="sms-hdr">
                  <span class="sms-sim">{{ m.simLabel }}</span>
                  <span class="sms-from">{{ m.from }}</span>
                  <span class="sms-ts mono">{{ fmtClock(m.ts) }}</span>
                </div>
                <div class="sms-body">{{ m.body }}</div>
              </div>
            </div>
          </template>
        </div>

        <!-- ═══ NHẬT KÝ ════════════════════════════════════ -->
        <div v-show="tab === 'log'" class="tab-pane log-pane">
          <div ref="logEl" class="log-box">
            <div v-if="!ws.eventLog.length" class="dim" style="padding:.5rem;font-size:.78rem;">Chưa có sự kiện</div>
            <div v-for="(e,i) in ws.eventLog" :key="i" :class="['log-line', e.cls]">
              <span class="log-ts mono">{{ e.ts }}</span>
              <span class="log-msg">{{ e.msg }}</span>
            </div>
          </div>
        </div>

        <!-- ═══ CÀI ĐẶT ════════════════════════════════════ -->
        <div v-show="tab === 'settings'" class="tab-pane settings-pane">

          <!-- Server -->
          <div class="settings-section">
            <div class="settings-hdr" @click="openSec.server = !openSec.server">
              Kết nối server
              <span :class="['toggle-chevron', { open: openSec.server }]">▾</span>
            </div>
            <div v-if="openSec.server" class="settings-body">
              <div class="field"><label>Host</label><input class="inp" v-model="cfg.host" placeholder="192.168.x.x"></div>
              <div class="field"><label>Port</label><input class="inp" type="number" v-model.number="cfg.port"></div>
              <label class="check-row"><input type="checkbox" v-model="cfg.use_tls"> Dùng TLS</label>
              <div v-if="cfg.use_tls" class="field" style="margin-top:.5rem;">
                <label>SHA-256 cert server</label>
                <input class="inp" style="font-family:var(--mono);font-size:11px;" v-model="cfg.server_cert_sha256" placeholder="hex fingerprint">
              </div>
              <div class="settings-actions">
                <button class="btn btn-p" @click="saveConfig">Lưu</button>
              </div>
            </div>
          </div>

          <!-- Audio -->
          <div class="settings-section">
            <div class="settings-hdr" @click="openSec.audio = !openSec.audio">
              Cấu hình âm thanh (PCM)
              <span :class="['toggle-chevron', { open: openSec.audio }]">▾</span>
            </div>
            <div v-if="openSec.audio" class="settings-body">
              <div class="field"><label>PCM card</label><input class="inp" type="number" v-model.number="cfg.pcm_card"></div>
              <div class="field"><label>TX injection device</label><input class="inp" type="number" v-model.number="cfg.pcm_tx_injection_device"></div>
              <div class="field"><label>TX rate (Hz)</label><input class="inp" type="number" v-model.number="cfg.pcm_tx_rate" placeholder="8000"></div>
              <div class="field"><label>RX capture device</label><input class="inp" type="number" v-model.number="cfg.pcm_rx_capture_device"></div>
              <div class="field"><label>RX capture rate (Hz)</label><input class="inp" type="number" v-model.number="cfg.pcm_rx_rate"></div>
              <div class="settings-actions">
                <button class="btn btn-p" @click="saveConfig">Lưu</button>
              </div>
            </div>
          </div>

          <!-- Contacts -->
          <div class="settings-section">
            <div class="settings-hdr" @click="openSec.contacts = !openSec.contacts">
              Danh bạ nhanh
              <span :class="['toggle-chevron', { open: openSec.contacts }]">▾</span>
            </div>
            <div v-if="openSec.contacts" class="settings-body">
              <div v-if="!ws.contacts.length" class="inbox-empty">Chưa có liên hệ</div>
              <div v-for="(c, i) in ws.contacts" :key="i" class="contact-item">
                <span class="contact-name">{{ c.name }}</span>
                <span class="contact-num mono">{{ c.number }}</span>
                <button class="btn-icon" @click="dialContact(c)" title="Gọi" style="width:28px;height:28px;font-size:.8rem;">☎</button>
                <button class="btn-icon" @click="ws.removeContact(i)" style="width:28px;height:28px;font-size:.8rem;color:var(--danger);">✕</button>
              </div>
              <div class="add-contact-row">
                <input class="inp" v-model="newCName" placeholder="Tên" style="max-width:100px;">
                <input class="inp" v-model="newCNum" placeholder="Số điện thoại">
                <button class="btn btn-p" @click="addContact" :disabled="!newCName||!newCNum" style="padding:.4rem .7rem;">+</button>
              </div>
            </div>
          </div>

        </div>

      </div>
    </div>
  </div>

  <!-- Incoming call modal -->
  <IncomingModal
    :show="ws.callPanel === 'ringing-in'"
    :number="ws.selectedDevice?.call?.number"
    :via="ws.selectedDevice?.name || ws.selectedId || ''"
    @answer="answer"
    @reject="hangup"
  />

  <!-- Quick contacts modal -->
  <Teleport to="body">
    <div v-if="showContacts" class="modal-overlay" @click.self="showContacts = false">
      <div class="modal-box">
        <div class="modal-hdr">Danh bạ nhanh <button class="btn-ghost" @click="showContacts=false" style="margin-left:auto">✕</button></div>
        <div v-if="!ws.contacts.length" class="inbox-empty">Thêm liên hệ trong Cài đặt</div>
        <div v-for="c in ws.contacts" :key="c.number" class="contact-item">
          <span class="contact-name">{{ c.name }}</span>
          <span class="contact-num mono">{{ c.number }}</span>
          <button class="btn btn-p" @click="dialContact(c); showContacts=false" style="padding:.3rem .7rem;font-size:.72rem;">Gọi</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useWsStore } from '@/stores/ws.js';
import { useAuthStore } from '@/stores/auth.js';
import AppSidebar from '@/components/AppSidebar.vue';
import WaveformMeter from '@/components/WaveformMeter.vue';
import IncomingModal from '@/components/IncomingModal.vue';

const ws   = useWsStore();
const auth = useAuthStore();

const tab         = ref('overview');
const phoneNum    = ref('');
const smsTo       = ref('');
const smsBody     = ref('');
const showDtmf    = ref(false);
const showNotes   = ref(true);
const showContacts= ref(false);
const newCName    = ref('');
const newCNum     = ref('');
const logEl       = ref(null);

const openSec = ref({ server: false, audio: false, contacts: false });
const cfg     = ref({ host:'', port:59100, use_tls:false, server_cert_sha256:'', pcm_card:0, pcm_tx_injection_device:27, pcm_tx_rate:8000, pcm_rx_capture_device:0, pcm_rx_rate:16000 });

const TABS = [
  { id:'overview',  label:'Tổng quan' },
  { id:'call',      label:'Cuộc gọi' },
  { id:'messages',  label:'Tin nhắn' },
  { id:'log',       label:'Nhật ký' },
  { id:'settings',  label:'Cài đặt' },
];

const KEYS = [
  {d:'1',l:''},{d:'2',l:'ABC'},{d:'3',l:'DEF'},
  {d:'4',l:'GHI'},{d:'5',l:'JKL'},{d:'6',l:'MNO'},
  {d:'7',l:'PQRS'},{d:'8',l:'TUV'},{d:'9',l:'WXYZ'},
  {d:'*',l:''},{d:'0',l:'+'},{d:'#',l:''},
];

// State labels
const callStateLabel = computed(() => {
  const map = { idle:'Rảnh', dialing:'Đang gọi', 'ringing-in':'Cuộc gọi đến', 'ringing-out':'Đổ chuông', active:'Đang nói' };
  return map[ws.callPanel] || ws.callPanel;
});
const callStateClass = computed(() => {
  const p = ws.callPanel;
  if (p === 'active') return 'good';
  if (p.startsWith('ringing')) return 'warn';
  return '';
});

// Call actions
function dial() {
  const num = phoneNum.value.trim();
  if (!num || !ws.selectedId) return;
  ws.cmd({ command:'dial', device_id:ws.selectedId, number:num });
}
function hangup()       { ws.cmd({ command:'hangup',  device_id:ws.selectedId }); }
function answer()       { ws.cmd({ command:'answer',  device_id:ws.selectedId }); }
function toggleMute()   { ws.cmd({ command:'mute',    device_id:ws.selectedId, on:!ws.selectedDevice?.call?.muted }); }
function toggleSpeaker(){ ws.speakerOn = !ws.speakerOn; ws.cmd({ command:'audio_route', device_id:ws.selectedId, route:ws.speakerOn?'speaker':'earpiece' }); }
function applyVolume()  { ws.cmd({ command:'volume',  device_id:ws.selectedId, level:ws.callVolume }); }
function sendDtmf(d)    { ws.cmd({ command:'dtmf',    device_id:ws.selectedId, digit:d }); }
function sendSms()      { const to=smsTo.value.trim(),b=smsBody.value.trim(); if(!to||!b||!ws.selectedId)return; ws.cmd({command:'send_sms',device_id:ws.selectedId,number:to,message:b}); smsBody.value=''; }
function dialNumber(n)  { phoneNum.value=n; tab.value='call'; if(ws.selectedId) dial(); }
function dialContact(c) { dialNumber(c.number); showContacts.value=false; }
function addContact()   { if(!newCName.value||!newCNum.value)return; ws.addContact(newCName.value,newCNum.value); newCName.value=''; newCNum.value=''; }
function saveConfig()   { if(!ws.selectedId)return; ws.cmd({command:'save_config',device_id:ws.selectedId,config:{...cfg.value}}); ws.showToast('ev','Đã lưu cấu hình','Khởi động lại thiết bị để áp dụng'); }

// Switch to call tab when call comes in on selected device
watch(() => ws.callPanel, (p) => {
  if ((p === 'active' || p === 'ringing-in') && ws.selectedId) tab.value = 'call';
});

// Log auto-scroll
watch(() => ws.eventLog.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight; });
});

// Keyboard
function onKey(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const p = ws.callPanel;
  if (p === 'idle' && tab.value === 'call') {
    if ('0123456789*#'.includes(e.key)) { e.preventDefault(); phoneNum.value += e.key; }
    if (e.key === 'Backspace')          { e.preventDefault(); phoneNum.value = phoneNum.value.slice(0,-1); }
    if (e.key === 'Enter')              { e.preventDefault(); dial(); }
    if (e.key === 'Escape')             { e.preventDefault(); phoneNum.value = ''; }
  } else if (p === 'active') {
    if ('0123456789*#'.includes(e.key)) { e.preventDefault(); sendDtmf(e.key); }
    if (e.key === 'm')   toggleMute();
    if (e.key === 'Escape') hangup();
  } else if (p === 'ringing-in') {
    if (e.key === 'Enter') answer();
    if (e.key === 'Escape') hangup();
  }
}

// Utils
function fmtClock(ts) { try { return new Date(ts).toLocaleTimeString('vi-VN'); } catch(_){ return ''; } }
function fmtDur(ms)   { if (!ms) return ''; const s=Math.floor(ms/1000); return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0'); }
function fmtRelTime(ts) {
  if (!ts) return '';
  const d=Date.now()-ts, m=Math.floor(d/60000), h=Math.floor(m/60), day=Math.floor(h/24);
  if (day>0) return day+'ng trước';
  if (h>0)   return h+'g trước';
  if (m>0)   return m+'ph trước';
  return 'vừa xong';
}

onMounted(() => {
  ws.connect();
  document.addEventListener('keydown', onKey);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKey);
  ws.stopAudio();
});
</script>

<style scoped>
/* ── Layout ─────────────────────────────────────────────────── */
.layout { display: flex; height: 100vh; overflow: hidden; }
.main {
  flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative;
}
.main::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
  background: transparent; z-index: 10; transition: background .4s;
}
.main.call-active::before {
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: callbar 2.4s ease-in-out infinite;
}
@keyframes callbar { 0%,100%{opacity:.3} 50%{opacity:1} }

/* ── Tab bar ─────────────────────────────────────────────────── */
.tab-bar { display: flex; border-bottom: 1px solid var(--border); padding: 0 .5rem; flex-shrink: 0; }
.tab {
  padding: .7rem .85rem; font-size: .75rem; font-weight: 500;
  letter-spacing: .04em; text-transform: uppercase;
  color: var(--dim); background: none; border: none; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px; position: relative;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-badge { position: absolute; top: .4rem; right: .3rem; font-size: .55rem; color: var(--accent); }

/* ── Tab content ─────────────────────────────────────────────── */
.tab-content { flex: 1; overflow: hidden; }
.tab-pane { height: 100%; overflow-y: auto; padding: 1.2rem 1.4rem; }

/* ── Call layout ─────────────────────────────────────────────── */
.call-pane { padding: 0; }
.call-layout { display: flex; height: 100%; }
.call-left  { flex: 0 0 320px; border-right: 1px solid var(--border); padding: 1rem; overflow-y: auto; }
.call-right { flex: 1; padding: 1rem; overflow-y: auto; }

/* ── Quick contacts ──────────────────────────────────────────── */
.quick-contacts-bar { margin-bottom: .8rem; }
.qc-open-btn { font-size: .7rem; margin-bottom: .4rem; }
.qc-scroll {
  display: flex; gap: .35rem; overflow-x: auto; padding-bottom: .3rem;
  scrollbar-width: thin;
}
.qc-chip {
  flex-shrink: 0; display: flex; flex-direction: column; align-items: center;
  padding: .35rem .6rem; background: var(--surface2);
  border: 1px solid var(--border); border-radius: 20px; cursor: pointer;
  transition: border-color .15s, background .15s;
}
.qc-chip:hover { background: var(--accent-lo); border-color: var(--accent-md); }
.qc-name { font-size: .68rem; font-weight: 500; white-space: nowrap; }
.qc-num  { font: .6rem var(--mono); color: var(--dim); white-space: nowrap; }
.qc-empty { font-size: .72rem; color: var(--muted); }

/* ── Dialpad ─────────────────────────────────────────────────── */
.num-display {
  font: 600 22px var(--mono); padding: .6rem .2rem .4rem;
  min-height: 2.8rem; border-bottom: 1px solid var(--border); margin-bottom: .6rem;
}
.num-display.ph { color: var(--muted); }
.dialpad-actions-top { display: flex; gap: .4rem; margin-bottom: .5rem; align-items: center; }
.dialpad { display: grid; grid-template-columns: repeat(3,1fr); gap: .3rem; margin: .5rem 0; }
.dialpad-sm { margin-top: .4rem; }
.key {
  padding: .6rem 0; text-align: center;
  background: var(--surface2); border: 1px solid var(--border); border-radius: 8px;
  cursor: pointer; user-select: none; transition: background .1s, border-color .1s;
}
.key:hover  { background: var(--surface); border-color: var(--border-hi); }
.key:active { background: var(--accent-lo); border-color: var(--accent-md); }
.key-sm { padding: .45rem 0; }
.key-d { font: 600 17px var(--mono); display: block; }
.key-l { font-size: .52rem; color: var(--muted); letter-spacing: .1em; display: block; }
.call-btn { width: 100%; padding: .6rem; margin-top: .3rem; }

/* ── Call states ─────────────────────────────────────────────── */
.cs-center { text-align: center; padding: 1.5rem 0; }
.cs-state  { font: 600 .7rem var(--mono); letter-spacing: .1em; text-transform: uppercase; color: var(--dim); }
.cs-number { font: 700 26px var(--mono); margin: .3rem 0; }
.cs-sub    { font-size: .76rem; color: var(--dim); }
.cs-sub.warn { color: var(--warn); }
.cs-actions { margin-top: 1rem; }

.active-header { border-bottom: 1px solid var(--border); padding-bottom: .7rem; margin-bottom: .7rem; }
.active-timer  { font: 700 28px var(--mono); }
.active-num    { font-size: 13px; color: var(--dim); }
.call-waveform { margin-bottom: .7rem; }

.call-ctrl-row { display: flex; gap: .35rem; margin-bottom: .6rem; align-items: center; }
.vol-row { display: flex; align-items: center; gap: .5rem; margin-bottom: .6rem; }
.vol-row input[type=range] { flex: 1; accent-color: var(--accent); }
.audio-btns { display: flex; gap: .35rem; flex-direction: column; margin-bottom: .3rem; }
.audio-btns > div { display: flex; gap: .35rem; }
.call-note-ta { width: 100%; min-height: 80px; margin-top: .4rem; }

/* ── History ─────────────────────────────────────────────────── */
.hist-header { display: flex; align-items: center; gap: .4rem; margin-bottom: .6rem; }
.hist-header h3 { font-size: .67rem; letter-spacing: .09em; text-transform: uppercase; color: var(--dim); }
.hist-item { border-bottom: 1px solid var(--border); }
.hist-row { display: flex; align-items: center; gap: .4rem; padding: .5rem .1rem; cursor: pointer; border-radius: 5px; }
.hist-row:hover { background: var(--surface2); }
.hist-dir { font: 600 13px var(--mono); width: 16px; flex-shrink: 0; color: var(--dim); }
.hist-dir.in  { color: var(--good); }
.hist-dir.out { color: var(--accent); }
.hist-num { flex: 1; font-size: 13px; }
.hist-ts  { font-size: .65rem; color: var(--muted); }
.hist-dur { font-size: 11px; min-width: 34px; text-align: right; color: var(--muted); }
.hist-expanded { padding: .4rem .1rem .7rem; }
.hist-notes    { font-size: .78rem; color: var(--dim); line-height: 1.6; white-space: pre-wrap; margin-bottom: .4rem; }
.hist-notes-em { font-size: .75rem; color: var(--muted); font-style: italic; margin-bottom: .4rem; }

/* ── Meters ──────────────────────────────────────────────────── */
.meters { display: flex; flex-direction: column; gap: .28rem; margin-bottom: .35rem; }
.meter-row { display: flex; align-items: center; gap: .5rem; }
.meter-lbl { font-size: .65rem; color: var(--dim); width: 18px; }
.meter-track { flex: 1; height: 4px; border-radius: 2px; background: var(--muted); overflow: hidden; }
.meter-fill  { height: 100%; border-radius: 2px; background: var(--accent); transition: width .08s; }

/* ── Messages ────────────────────────────────────────────────── */
.msg-pane { padding: 0; display: flex; flex-direction: column; height: 100%; }
.msg-compose { padding: 1rem 1.4rem; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.msg-to-row { margin-bottom: .5rem; }
.msg-inbox { flex: 1; overflow-y: auto; padding: .8rem 1.4rem; }
.msg-inbox-hdr { font-size: .67rem; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); margin-bottom: .65rem; display: flex; align-items: center; gap: .35rem; }
.sms-item { padding: .6rem .7rem; border: 1px solid var(--border); border-radius: 9px; margin-bottom: .4rem; background: var(--surface); }
.sms-hdr  { display: flex; align-items: center; gap: .4rem; margin-bottom: .25rem; flex-wrap: wrap; }
.sms-sim  { font: 600 .6rem var(--mono); padding: .05rem .32rem; border-radius: 3px; background: var(--accent-lo); border: 1px solid var(--accent-md); color: var(--accent); flex-shrink: 0; }
.sms-from { font-size: .76rem; font-weight: 600; }
.sms-ts   { font-size: .63rem; color: var(--muted); margin-left: auto; }
.sms-body { font-size: .78rem; color: var(--dim); line-height: 1.55; word-break: break-word; }
.inbox-empty { font-size: .78rem; color: var(--muted); padding: .6rem 0; }

/* ── Log ─────────────────────────────────────────────────────── */
.log-pane { padding: 0; height: 100%; }
.log-box  { height: 100%; overflow-y: auto; padding: .8rem 1.2rem; font: 12px var(--mono); }
.log-line { display: flex; gap: .8rem; padding: .1rem 0; border-bottom: 1px solid rgba(255,255,255,.025); }
.log-ts   { color: var(--muted); flex-shrink: 0; }
.log-msg  { color: var(--dim); }
.log-line.ev .log-msg { color: var(--text); }
.log-line.er .log-msg { color: var(--danger); }
.log-line.sm .log-msg { color: var(--warn); }
.log-line.au .log-msg { color: var(--accent); }

/* ── Settings ────────────────────────────────────────────────── */
.settings-pane { max-width: 520px; }
.settings-section { border: 1px solid var(--border); border-radius: 10px; margin-bottom: .65rem; overflow: hidden; }
.settings-hdr {
  display: flex; align-items: center; padding: .75rem 1rem;
  cursor: pointer; background: var(--surface); font-size: .78rem; font-weight: 500;
  transition: background .15s;
}
.settings-hdr:hover { background: var(--surface2); }
.settings-hdr .toggle-chevron { margin-left: auto; }
.settings-body { padding: 1rem; border-top: 1px solid var(--border); }
.settings-actions { margin-top: .7rem; }
.check-row { display: flex; align-items: center; gap: .5rem; font-size: .76rem; color: var(--dim); cursor: pointer; }
.contact-item { display: flex; align-items: center; gap: .5rem; padding: .32rem 0; border-bottom: 1px solid var(--border); }
.contact-item:last-child { border-bottom: none; }
.contact-name { font-size: .78rem; font-weight: 500; flex: 1; }
.contact-num  { font-size: 11px; color: var(--dim); }
.add-contact-row { display: flex; gap: .35rem; margin-top: .6rem; }

/* ── Modal ───────────────────────────────────────────────────── */
.modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.7); z-index: 1500; display: flex; align-items: center; justify-content: center; }
.modal-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.2rem; width: 320px; max-height: 80vh; overflow-y: auto; }
.modal-hdr { display: flex; align-items: center; font-size: .82rem; font-weight: 600; margin-bottom: .8rem; }

/* ── Responsive ──────────────────────────────────────────────── */
@media (max-width: 700px) {
  .call-layout { flex-direction: column; }
  .call-left   { flex: none; border-right: none; border-bottom: 1px solid var(--border); }
}
@media (max-width: 600px) {
  .layout      { flex-direction: column; }
  .tab-pane    { padding: .8rem; }
}
</style>
