<template>
  <canvas ref="canvas" class="waveform-canvas" :width="width" :height="height"></canvas>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  samples: { type: Float32Array, default: () => new Float32Array(0) },
  width:   { type: Number, default: 300 },
  height:  { type: Number, default: 48 },
  color:   { type: String, default: '#c8830a' },
  active:  { type: Boolean, default: false },
});

const canvas = ref(null);
let raf = null;

function draw() {
  const c = canvas.value;
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;

  ctx.clearRect(0, 0, W, H);

  const samples = props.samples;
  const n = samples.length;

  if (!n || !props.active) {
    // Flat line
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.strokeStyle = 'rgba(200,131,10,.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  const step = n / W;
  for (let x = 0; x < W; x++) {
    const idx = Math.floor(x * step);
    const y   = ((1 - samples[idx]) / 2) * H;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = props.color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

watch(() => props.samples, draw, { deep: false });
watch(() => props.active, draw);

function loop() { draw(); raf = requestAnimationFrame(loop); }
onMounted(() => { loop(); });
onUnmounted(() => { if (raf) cancelAnimationFrame(raf); });
</script>

<style scoped>
.waveform-canvas {
  display: block;
  width: 100%; height: 48px;
  border-radius: 6px;
  background: rgba(0,0,0,.3);
}
</style>
