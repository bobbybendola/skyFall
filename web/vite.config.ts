import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// .env lives at the repo root (VITE_SPACETIMEDB_URI, VITE_SPACETIMEDB_MODULE).
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { port: 5173 },
  worker: { format: 'es' }, // satellite.js 7 ships module workers (top-level await)
});
