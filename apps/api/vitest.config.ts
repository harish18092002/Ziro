import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Each DB test file boots an in-memory Postgres (WASM) and applies every migration.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
