<template>
  <Teleport to="body">
    <div v-if="show" class="incall-overlay">
      <div class="incall-modal">
        <div class="incall-type">Cuộc gọi đến</div>
        <div class="incall-number">{{ number || 'Ẩn số' }}</div>
        <div class="incall-via">qua {{ via }}</div>
        <div class="incall-btns">
          <button class="btn btn-d" @click="$emit('reject')">Từ chối</button>
          <button class="btn btn-g" @click="$emit('answer')">Nghe máy</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
defineProps({
  show:   { type: Boolean, default: false },
  number: { type: String, default: '' },
  via:    { type: String, default: '' },
});
defineEmits(['answer', 'reject']);
</script>

<style scoped>
.incall-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,.8);
  z-index: 2000; display: flex; align-items: center; justify-content: center;
  animation: fadeIn .18s ease-out;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

.incall-modal {
  background: var(--surface); border: 1px solid rgba(200,131,10,.3);
  border-radius: 18px; padding: 2.2rem 2.4rem 1.8rem;
  min-width: 290px; text-align: center;
  box-shadow: 0 0 0 1px var(--accent-md), 0 28px 60px rgba(0,0,0,.7);
}
.incall-type   { font: 600 .68rem var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--danger); animation: pulse 1.2s ease-in-out infinite; margin-bottom: .7rem; }
.incall-number { font: 700 30px var(--mono); margin-bottom: .2rem; }
.incall-via    { font-size: .76rem; color: var(--dim); margin-bottom: 1.8rem; }
.incall-btns   { display: flex; gap: .8rem; justify-content: center; }
.incall-btns .btn { flex: 1; padding: .75rem; font-size: .85rem; }
@keyframes pulse { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
</style>
