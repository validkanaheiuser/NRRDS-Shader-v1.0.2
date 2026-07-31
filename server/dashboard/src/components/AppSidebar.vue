<template>
  <aside class="sidebar">
    <div class="sb-logo">
      <span class="logo-mark">ab</span>
      <span class="logo-name">audio bridge</span>
      <span :class="['sb-dot', ws.connClass]" :title="connLabel"></span>
    </div>

    <div class="sb-section">
      <div class="sb-label">Thiết bị</div>
      <div v-if="!ws.devices.length" class="sb-empty">
        Chưa có thiết bị<br>
        <span>Kết nối daemon để bắt đầu</span>
      </div>
      <div
        v-for="d in ws.devices" :key="d.id"
        :class="['dev-card', { sel: d.id === ws.selectedId }]"
        @click="ws.selectedId = d.id"
      >
        <div class="dev-avatar">{{ (d.name || d.id || '?')[0].toUpperCase() }}</div>
        <div class="dev-body">
          <div class="dev-name">{{ d.name || d.id }}</div>
          <div class="dev-sub">{{ [d.brand, d.android ? 'A'+d.android : ''].filter(Boolean).join(' · ') }}</div>
          <span :class="['dev-state', stateClass(d)]">{{ stateLabel(d) }}</span>
        </div>
      </div>
    </div>

    <div class="sb-footer">
      <div class="sb-user">
        <span class="sb-username">{{ auth.user?.username }}</span>
        <span v-if="auth.isAdmin" class="sb-role">admin</span>
        <button class="btn-ghost sb-logout" @click="doLogout" title="Đăng xuất">↩</button>
      </div>
      <RouterLink v-if="auth.isAdmin" to="/admin" class="sb-admin-link">Quản trị</RouterLink>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth.js';
import { useWsStore } from '@/stores/ws.js';

const auth   = useAuthStore();
const ws     = useWsStore();
const router = useRouter();

const connLabel = computed(() => {
  if (ws.authFailed) return 'Xác thực thất bại';
  return ws.connected ? 'Trực tuyến' : 'Ngoại tuyến';
});

function stateLabel(d) {
  const s = d.call?.state || 'IDLE';
  const map = { IDLE:'Rảnh', DIALING:'Đang gọi', RINGING:'Đổ chuông', ACTIVE:'Đang nói' };
  return map[s] || s;
}
function stateClass(d) {
  const s = (d.call?.state || '').toLowerCase();
  return { ringing: s === 'ringing', active: s === 'active', dialing: s === 'dialing' };
}

async function doLogout() {
  ws.disconnect();
  await auth.logout();
  router.push('/login');
}
</script>

<style scoped>
.sidebar {
  width: 220px; flex-shrink: 0;
  background: var(--sb); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; overflow: hidden;
}

.sb-logo {
  padding: 1rem .9rem .8rem;
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; gap: .5rem;
}
.logo-mark {
  font: 600 13px var(--mono); color: var(--accent);
  background: var(--accent-lo); border: 1px solid var(--accent-md);
  border-radius: 5px; padding: .14rem .4rem; letter-spacing: .04em;
}
.logo-name { font-size: .75rem; font-weight: 500; letter-spacing: .06em; color: var(--dim); text-transform: uppercase; }
.sb-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--muted);
  margin-left: auto; flex-shrink: 0; transition: background .3s;
}
.sb-dot.online   { background: var(--good); box-shadow: 0 0 5px var(--good); }
.sb-dot.authfail { background: var(--danger); }
.sb-dot.offline  { background: var(--muted); }

.sb-section { padding: .6rem .5rem .4rem; flex: 1; overflow-y: auto; }
.sb-label { font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); padding: .15rem .4rem .5rem; }
.sb-empty { padding: .7rem .65rem; font-size: .73rem; color: var(--muted); line-height: 1.7; }
.sb-empty span { font-size: .67rem; }

.dev-card {
  padding: .55rem .65rem; border-radius: 7px; cursor: pointer;
  border: 1px solid transparent; margin-bottom: .28rem;
  display: flex; align-items: center; gap: .55rem;
  transition: background .15s, border-color .15s;
}
.dev-card:hover { background: var(--surface); }
.dev-card.sel   { background: var(--accent-lo); border-color: var(--accent-md); }
.dev-avatar {
  width: 30px; height: 30px; border-radius: 6px;
  background: var(--surface2); color: var(--dim);
  display: flex; align-items: center; justify-content: center;
  font: 600 12px var(--mono); flex-shrink: 0;
}
.dev-card.sel .dev-avatar { background: var(--accent-md); color: var(--accent); }
.dev-body { min-width: 0; }
.dev-name { font-size: .77rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dev-sub  { font-size: .65rem; color: var(--dim); margin-top: .04rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dev-state {
  display: inline-block; margin-top: .16rem;
  font: 500 .6rem var(--mono); padding: .05rem .28rem;
  border-radius: 3px; background: var(--surface2); color: var(--dim);
}
.dev-state.ringing { background: rgba(212,135,10,.15); color: var(--warn); }
.dev-state.active  { background: rgba(86,184,112,.15); color: var(--good); }
.dev-state.dialing { background: rgba(200,131,10,.1);  color: var(--accent); }

.sb-footer {
  padding: .65rem .8rem; border-top: 1px solid var(--border);
}
.sb-user { display: flex; align-items: center; gap: .4rem; margin-bottom: .4rem; }
.sb-username { font-size: .78rem; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-role { font: 600 .6rem var(--mono); color: var(--accent); background: var(--accent-lo); border: 1px solid var(--accent-md); border-radius: 3px; padding: .04rem .3rem; flex-shrink: 0; }
.sb-logout { padding: .25rem .5rem; font-size: .72rem; }
.sb-admin-link {
  display: block; width: 100%; text-align: center;
  padding: .38rem; font-size: .73rem; color: var(--dim);
  border: 1px solid var(--border); border-radius: var(--radius);
  text-decoration: none; transition: all .15s;
}
.sb-admin-link:hover { color: var(--accent); border-color: var(--accent-md); }

@media (max-width: 600px) {
  .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border); }
  .sb-section { display: flex; flex-direction: row; overflow-x: auto; padding: .4rem; gap: .3rem; }
  .dev-card { flex-shrink: 0; flex-direction: column; text-align: center; width: 90px; padding: .4rem; }
  .dev-sub, .sb-empty span, .sb-admin-link { display: none; }
}
</style>
