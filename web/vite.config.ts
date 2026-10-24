import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// .env lives at the repo root (VITE_SPACETIMEDB_URI, VITE_SPACETIMEDB_MODULE).
export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { port: 5173 },
  // maplibre-gl 6 loads its worker relative to its own file; pre-bundling breaks that.
  optimizeDeps: { exclude: ['maplibre-gl'] },
});
