<template>
  <div class="layout">
    <AppSidebar />
    <div class="admin-main">
      <div class="admin-hdr">
        <RouterLink to="/" class="back-link">← Dashboard</RouterLink>
        <h1>Quản trị</h1>
      </div>

      <div class="admin-cols">

        <!-- Left: user list -->
        <div class="admin-col">
          <div class="col-title">Người dùng</div>
          <div v-if="loading" class="dim" style="font-size:.78rem;padding:.5rem 0;">Đang tải…</div>
          <div v-if="errMsg" class="err-banner">{{ errMsg }}</div>
          <div v-for="u in users" :key="u.id" :class="['user-card', { sel: u.id === selectedId }]" @click="selectUser(u)">
            <div class="user-left">
              <div class="user-av">{{ u.username[0].toUpperCase() }}</div>
              <div class="user-info">
                <div class="user-name">{{ u.username }}</div>
                <div class="user-meta">
                  <span :class="['role-badge', u.role]">{{ u.role === 'admin' ? 'Admin' : 'Người dùng' }}</span>
                  <span class="user-created">{{ fmtDate(u.created_at) }}</span>
                </div>
              </div>
            </div>
            <div class="user-actions" @click.stop>
              <button class="btn-icon" title="Xóa người dùng" @click="deleteUser(u)" :disabled="u.role === 'admin' && adminCount <= 1">✕</button>
            </div>
          </div>
          <div v-if="!users.length && !loading" class="inbox-empty">Chưa có người dùng</div>
        </div>

        <!-- Right: edit selected user -->
        <div class="admin-col detail-col">
          <div class="col-title">Tạo người dùng</div>
          <form class="create-form" @submit.prevent="createUser">
            <div class="field">
              <label>Tên đăng nhập</label>
              <input class="inp" v-model="newUser.username" placeholder="username" autocomplete="off">
            </div>
            <div class="field">
              <label>Mật khẩu</label>
              <input class="inp" type="password" v-model="newUser.password" placeholder="••••••••" autocomplete="new-password">
            </div>
            <div class="field">
              <label>Vai trò</label>
              <select class="inp" v-model="newUser.role">
                <option value="user">Người dùng</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div v-if="createErr" class="err-banner">{{ createErr }}</div>
            <div v-if="createOk" class="ok-banner">{{ createOk }}</div>
            <button class="btn btn-p" type="submit" :disabled="!newUser.username || !newUser.password || creating">
              {{ creating ? 'Đang tạo…' : 'Tạo tài khoản' }}
            </button>
          </form>

          <!-- Edit selected -->
          <template v-if="selectedId">
            <div class="col-title" style="margin-top:1.5rem;">Chỉnh sửa: {{ selectedUser?.username }}</div>
            <div v-if="editErr" class="err-banner">{{ editErr }}</div>
            <div v-if="editOk" class="ok-banner">{{ editOk }}</div>

            <div class="field">
              <label>Vai trò</label>
              <div style="display:flex;gap:.5rem;align-items:center;">
                <select class="inp" v-model="editRole">
                  <option value="user">Người dùng</option>
                  <option value="admin">Admin</option>
                </select>
                <button class="btn btn-p" @click="saveRole" style="white-space:nowrap;padding:.4rem .7rem;font-size:.74rem;">Lưu</button>
              </div>
            </div>

            <div class="field">
              <label>Đặt lại mật khẩu</label>
              <div style="display:flex;gap:.5rem;">
                <input class="inp" type="password" v-model="newPw" placeholder="Mật khẩu mới" autocomplete="new-password">
                <button class="btn btn-p" @click="savePassword" :disabled="!newPw" style="white-space:nowrap;padding:.4rem .7rem;font-size:.74rem;">Đặt lại</button>
              </div>
            </div>

            <div class="field">
              <label>Thiết bị được phép</label>
              <div v-if="!wsStore.devices.length" class="dim" style="font-size:.75rem;">
                Không có thiết bị nào đang kết nối
              </div>
              <div v-for="d in wsStore.devices" :key="d.id" class="device-row">
                <label class="check-row">
                  <input type="checkbox" :value="d.id" v-model="editDevices">
                  <span class="device-name">{{ d.name || d.id }}</span>
                  <span class="device-id mono">{{ d.id }}</span>
                </label>
              </div>
              <button class="btn btn-p" @click="saveDevices" style="margin-top:.5rem;">Lưu thiết bị</button>
            </div>
          </template>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useAuthStore } from '@/stores/auth.js';
import { useWsStore } from '@/stores/ws.js';
import AppSidebar from '@/components/AppSidebar.vue';

const authStore = useAuthStore();
const wsStore   = useWsStore();

const users      = ref([]);
const loading    = ref(false);
const errMsg     = ref('');
const selectedId = ref(null);
const editRole   = ref('user');
const editDevices= ref([]);
const newPw      = ref('');
const editErr    = ref('');
const editOk     = ref('');

const newUser  = ref({ username:'', password:'', role:'user' });
const creating = ref(false);
const createErr= ref('');
const createOk = ref('');

const selectedUser = computed(() => users.value.find(u => u.id === selectedId.value));
const adminCount   = computed(() => users.value.filter(u => u.role === 'admin').length);

async function apiFetch(path, opts = {}) {
  const token = authStore.token;
  const r = await fetch(path, {
    headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function loadUsers() {
  loading.value = true; errMsg.value = '';
  try {
    const data = await apiFetch('/api/admin/users');
    users.value = data.users || [];
  } catch (e) { errMsg.value = e.message; }
  finally { loading.value = false; }
}

function selectUser(u) {
  selectedId.value = u.id;
  editRole.value   = u.role;
  editDevices.value= [];
  newPw.value      = '';
  editErr.value    = '';
  editOk.value     = '';
  loadUserDevices(u.id);
}

async function loadUserDevices(userId) {
  try {
    const data = await apiFetch(`/api/admin/users/${userId}`);
    editDevices.value = data.devices || [];
  } catch (_) {}
}

async function createUser() {
  if (!newUser.value.username || !newUser.value.password) return;
  creating.value = true; createErr.value = ''; createOk.value = '';
  try {
    await apiFetch('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(newUser.value),
    });
    createOk.value = `Đã tạo "${newUser.value.username}"`;
    newUser.value = { username:'', password:'', role:'user' };
    await loadUsers();
  } catch (e) { createErr.value = e.message; }
  finally { creating.value = false; }
}

async function deleteUser(u) {
  if (!confirm(`Xóa người dùng "${u.username}"?`)) return;
  try {
    await apiFetch(`/api/admin/users/${u.id}`, { method:'DELETE' });
    if (selectedId.value === u.id) selectedId.value = null;
    await loadUsers();
  } catch (e) { errMsg.value = e.message; }
}

async function saveRole() {
  editErr.value = ''; editOk.value = '';
  try {
    await apiFetch(`/api/admin/users/${selectedId.value}`, {
      method: 'PUT', body: JSON.stringify({ role: editRole.value }),
    });
    editOk.value = 'Đã cập nhật vai trò';
    await loadUsers();
  } catch (e) { editErr.value = e.message; }
}

async function savePassword() {
  if (!newPw.value) return;
  editErr.value = ''; editOk.value = '';
  try {
    await apiFetch(`/api/admin/users/${selectedId.value}`, {
      method: 'PUT', body: JSON.stringify({ password: newPw.value }),
    });
    newPw.value = '';
    editOk.value = 'Đã đặt lại mật khẩu';
  } catch (e) { editErr.value = e.message; }
}

async function saveDevices() {
  editErr.value = ''; editOk.value = '';
  try {
    await apiFetch(`/api/admin/users/${selectedId.value}`, {
      method: 'PUT', body: JSON.stringify({ devices: editDevices.value }),
    });
    editOk.value = 'Đã lưu danh sách thiết bị';
  } catch (e) { editErr.value = e.message; }
}

function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString('vi-VN'); } catch (_) { return ''; }
}

onMounted(() => { loadUsers(); wsStore.connect(); });
</script>

<style scoped>
.layout { display: flex; height: 100vh; overflow: hidden; }
.admin-main { flex: 1; overflow-y: auto; padding: 1.4rem 1.6rem; }
.admin-hdr { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.4rem; }
.admin-hdr h1 { font-size: 1.05rem; font-weight: 600; }
.back-link { font-size: .75rem; color: var(--dim); text-decoration: none; }
.back-link:hover { color: var(--accent); }

.admin-cols { display: flex; gap: 1.2rem; align-items: flex-start; }
.admin-col { flex: 1; min-width: 0; }
.detail-col { max-width: 400px; }
.col-title { font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: .65rem; }

.user-card {
  padding: .7rem .8rem; border: 1px solid var(--border); border-radius: 9px;
  margin-bottom: .4rem; cursor: pointer; display: flex; align-items: center;
  justify-content: space-between; transition: border-color .15s, background .15s;
}
.user-card:hover { background: var(--surface2); }
.user-card.sel { border-color: var(--accent-md); background: var(--accent-lo); }
.user-left { display: flex; align-items: center; gap: .7rem; }
.user-av {
  width: 34px; height: 34px; border-radius: 8px;
  background: var(--surface2); color: var(--dim);
  display: flex; align-items: center; justify-content: center;
  font: 600 13px var(--mono); flex-shrink: 0;
}
.user-card.sel .user-av { background: var(--accent-md); color: var(--accent); }
.user-name { font-size: .82rem; font-weight: 500; }
.user-meta { display: flex; align-items: center; gap: .4rem; margin-top: .12rem; }
.role-badge {
  font: 600 .58rem var(--mono); padding: .03rem .28rem; border-radius: 3px;
  background: var(--surface2); color: var(--muted);
}
.role-badge.admin { background: var(--accent-lo); color: var(--accent); border: 1px solid var(--accent-md); }
.user-created { font-size: .62rem; color: var(--muted); }

.create-form { display: flex; flex-direction: column; gap: 0; }
.device-row { padding: .28rem 0; border-bottom: 1px solid rgba(255,255,255,.04); }
.device-name { font-size: .78rem; font-weight: 500; }
.device-id { font-size: 11px; color: var(--muted); margin-left: .35rem; }

.err-banner { font-size: .75rem; color: var(--danger); background: rgba(224,80,80,.08); border: 1px solid rgba(224,80,80,.2); border-radius: var(--radius); padding: .35rem .6rem; margin-bottom: .5rem; }
.ok-banner  { font-size: .75rem; color: var(--good);   background: rgba(86,184,112,.08); border: 1px solid rgba(86,184,112,.2);  border-radius: var(--radius); padding: .35rem .6rem; margin-bottom: .5rem; }
.inbox-empty { font-size: .78rem; color: var(--muted); padding: .4rem 0; }

@media (max-width: 700px) {
  .admin-cols { flex-direction: column; }
  .detail-col { max-width: 100%; }
}
</style>
