import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In production the API serves the built web app (one URL). In dev, Vite proxies to the API.
const API = `http://localhost:${process.env['PORT'] ?? '3000'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/health', '/demo', '/runs', '/exceptions', '/proposals', '/records'].map((p) => [p, API]),
    ),
  },
});
