import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    passWithNoTests: false,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Resolve the workspace dep to core's source in tests (no build step needed).
      '@openbounce/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
});
