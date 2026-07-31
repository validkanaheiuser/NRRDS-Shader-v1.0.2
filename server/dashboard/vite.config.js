import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api':      { target: 'http://localhost:8090', changeOrigin: true },
      '/ws/ui':    { target: 'ws://localhost:8090',   ws: true },
      '/ws/audio': { target: 'ws://localhost:8090',   ws: true },
    },
  },
});
