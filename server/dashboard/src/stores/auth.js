import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

export const useAuthStore = defineStore('auth', () => {
  const user  = ref(null);
  const token = ref(localStorage.getItem('ab-session') || '');
  const ready = ref(false);

  const isAdmin = computed(() => user.value?.role === 'admin');

  async function init() {
    if (!token.value) { ready.value = true; return; }
    try {
      const r = await apiFetch('GET', '/api/me');
      if (r.ok) user.value = await r.json();
      else       { token.value = ''; localStorage.removeItem('ab-session'); }
    } catch(_) {}
    ready.value = true;
  }

  async function login(username, password) {
    const r = await apiFetch('POST', '/api/login', { username, password });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'Đăng nhập thất bại');
    }
    const data = await r.json();
    token.value = data.token;
    user.value  = data.user;
    localStorage.setItem('ab-session', data.token);
  }

  async function logout() {
    try { await apiFetch('POST', '/api/logout'); } catch(_) {}
    token.value = ''; user.value = null;
    localStorage.removeItem('ab-session');
  }

  function apiFetch(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token.value) headers['Authorization'] = 'Bearer ' + token.value;
    return fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  }

  return { user, token, ready, isAdmin, init, login, logout, apiFetch };
});
