import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Real-network integration tests (SMTP over port 25). Run explicitly and only from a port-25-capable
// box: `OPENBOUNCE_INTEGRATION=1 pnpm --filter @openbounce/core test:integration`. The default `test`
// config excludes tests/integration/** so these never run in the normal gate / CI.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 30_000,
    passWithNoTests: true,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
