import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// .env lives at the repo root (VITE_SPACETIMEDB_URI, VITE_SPACETIMEDB_MODULE).
// /api/assistant proxies to services/assistant. A down service becomes
// "assistant offline" in the globe; the rest of the page still loads.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const assistantPort = env.ASSISTANT_PORT || '8787';
  return {
    plugins: [react()],
    envDir: '..',
    server: {
      port: 5173,
      proxy: {
        '/api/assistant': {
          target: `http://127.0.0.1:${assistantPort}`,
          rewrite: path => path.replace(/^\/api\/assistant/, '') || '/',
        },
      },
    },
    worker: { format: 'es' }, // satellite.js 7 ships module workers (top-level await)
  };
});
