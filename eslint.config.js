import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PURE =
  'core/ is pure — reach the network via an injected DnsResolver/SmtpProber (see CLAUDE.md rule 1).';
const CLOCK =
  'core/ must take time via an injected Clock, never ambient timers/Date (see CLAUDE.md rule 1).';
const RNG =
  'core/ must take randomness via an injected Rng, never Math.random (see CLAUDE.md rule 1).';

// Node built-ins that would make the pure core do I/O, read the clock, or pull entropy. We match by
// pattern (bare + node: + every submodule) so a `/promises` or prefixed variant can't slip past.
const IO_MODULES = [
  'dns',
  'net',
  'dgram',
  'tls',
  'http',
  'https',
  'http2',
  'fs',
  'crypto',
  'timers',
  'child_process',
  'process',
  'perf_hooks',
  'os',
  'worker_threads',
  'v8',
  'vm',
  'inspector',
  'async_hooks',
  'cluster',
];
const IO_PATTERNS = IO_MODULES.flatMap((m) => [m, `${m}/*`, `node:${m}`, `node:${m}/*`]);

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Pure-core network/determinism seam (CLAUDE.md project rule 1): everything under
    // packages/core/src/core and .../data must be free of I/O, time and randomness — network comes
    // via injected DnsResolver/SmtpProber, time/rng via injected Clock/Rng. This keeps the whole
    // scoring pipeline deterministically unit-testable with fakes.
    files: ['packages/core/src/core/**/*.ts', 'packages/core/src/data/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: IO_PATTERNS, message: PURE }] }],
      'no-restricted-globals': [
        'error',
        { name: 'setTimeout', message: CLOCK },
        { name: 'setInterval', message: CLOCK },
        { name: 'setImmediate', message: CLOCK },
        { name: 'queueMicrotask', message: CLOCK },
        { name: 'performance', message: CLOCK },
        { name: 'Date', message: CLOCK },
        { name: 'fetch', message: PURE },
        {
          name: 'process',
          message: 'core/ must not read ambient process/env; inject config (see CLAUDE.md rule 1).',
        },
        { name: 'crypto', message: RNG },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: RNG },
        { object: 'Date', property: 'now', message: CLOCK },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Build/CI scripts run under plain Node ESM (not typechecked); declare the runtime globals used.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Benchmarks run under plain Node ESM (not typechecked); declare the runtime globals they use.
    files: ['bench/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        performance: 'readonly',
        global: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
