import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La dashboard raggiunge l'API locale tramite proxy: nessuna chiamata
// verso reti esterne. Il backend resta bindato su 127.0.0.1 (§14).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});