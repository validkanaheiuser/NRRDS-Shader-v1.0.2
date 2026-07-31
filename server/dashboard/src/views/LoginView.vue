<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-logo">
        <span class="logo-mark">ab</span>
        <span class="logo-name">audio bridge</span>
      </div>

      <form class="login-form" @submit.prevent="submit">
        <div class="field">
          <label>Tên đăng nhập</label>
          <input class="inp" v-model="username" autocomplete="username" placeholder="admin" autofocus>
        </div>
        <div class="field">
          <label>Mật khẩu</label>
          <input class="inp" v-model="password" type="password" autocomplete="current-password" placeholder="••••••••">
        </div>
        <div v-if="errMsg" class="login-err">{{ errMsg }}</div>
        <button class="btn btn-p login-btn" type="submit" :disabled="loading">
          {{ loading ? 'Đang đăng nhập...' : 'Đăng nhập' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth.js';
import { useWsStore } from '@/stores/ws.js';

const auth   = useAuthStore();
const ws     = useWsStore();
const router = useRouter();

const username = ref('');
const password = ref('');
const errMsg   = ref('');
const loading  = ref(false);

async function submit() {
  errMsg.value = '';
  loading.value = true;
  try {
    await auth.login(username.value.trim(), password.value);
    ws.connect();
    router.push('/');
  } catch (e) {
    errMsg.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg);
  padding: 1rem;
}
.login-card {
  width: 100%; max-width: 360px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px; padding: 2.5rem 2rem;
}
.login-logo {
  display: flex; align-items: center; gap: .6rem;
  margin-bottom: 2rem; justify-content: center;
}
.logo-mark {
  font: 600 14px var(--mono);
  color: var(--accent); background: var(--accent-lo);
  border: 1px solid var(--accent-md); border-radius: 6px;
  padding: .18rem .5rem; letter-spacing: .04em;
}
.logo-name { font-size: .85rem; font-weight: 500; letter-spacing: .08em; color: var(--dim); }
.login-form { display: flex; flex-direction: column; gap: .1rem; }
.login-err {
  font-size: .75rem; color: var(--danger);
  padding: .4rem .6rem; background: rgba(224,80,80,.08);
  border: 1px solid rgba(224,80,80,.2); border-radius: var(--radius);
  margin-bottom: .3rem;
}
.login-btn { width: 100%; padding: .65rem; margin-top: .5rem; font-size: .85rem; }
</style>
