import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In production the API serves the built web app (one URL). In dev, Vite proxies to the API.
const API = `http://localhost:${process.env['PORT'] ?? '3000'}`;

export default defineConfig({
  plugins: [react()],
  // Two pages: the console, and the test-payments helper, which is a separate page because it alone may
  // load Razorpay's Checkout (the API gives it its own narrow security policy).
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        pay: fileURLToPath(new URL('./pay.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      [
        '/health',
        '/demo',
        '/runs',
        '/exceptions',
        '/proposals',
        '/records',
        '/razorpay',
        '/auth',
        '/agent',
      ].map((p) => [p, API]),
    ),
  },
});
