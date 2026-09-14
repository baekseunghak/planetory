import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    // Only the checked-in synthetic API fixtures may be imported outside this app.
    fs: {
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../docs/api/analysis/examples', import.meta.url)),
      ],
    },
  },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
