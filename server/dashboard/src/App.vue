<template>
  <RouterView />
  <div class="toasts">
    <div v-for="t in ws.toasts" :key="t.id" :class="['toast', t.kind]" @click="ws.removeToast(t.id)">
      <div class="toast-title">{{ t.title }}</div>
      <div class="toast-body">{{ t.body }}</div>
    </div>
  </div>
</template>

<script setup>
import { RouterView } from 'vue-router';
import { useWsStore } from '@/stores/ws.js';
const ws = useWsStore();
</script>
