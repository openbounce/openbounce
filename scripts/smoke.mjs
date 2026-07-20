// ESM-first package smoke test — loads the built packages by name the way a consumer would.
// Loads the BUILT @openbounce/core BY NAME under both the ESM `import` and the CJS `require`
// resolution paths, so a broken `exports` map or a CJS-interop bug fails CI instead of shipping.
// Run after `pnpm build` (the built dist must exist).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

// ESM path → the "import" export condition → dist/index.js
const esm = await import('@openbounce/core');
assert.equal(typeof esm.validate, 'function', 'ESM import: `validate` should be a function');

// CJS path → the "require" export condition → dist/index.cjs
const cjs = require('@openbounce/core');
assert.equal(typeof cjs.validate, 'function', 'CJS require: `validate` should be a function');

// The flagship `openbounce` package re-exports the engine API — verify it resolves
// by name and re-exports through the built dist/lib.js + its exports map.
const flagship = await import('openbounce');
assert.equal(
  typeof flagship.validate,
  'function',
  'openbounce (flagship): should re-export validate()',
);

// And the engine actually runs through the built artifact.
const result = await esm.validate('user@example.com');
assert.equal(result.email, 'user@example.com', 'validate() should return a normalized result');

// The CLI's shipped entry point is the `bin` (dist/cli.js) — exercise it end-to-end (the run() logic is
// unit-tested from source with fakes; this catches a broken build / bin shim / core-resolution regression).
const bin = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const invalid = spawnSync(process.execPath, [bin, 'not-an-email', '--json'], { encoding: 'utf8' });
assert.equal(invalid.status, 1, 'CLI bin: an invalid address should exit 1');
assert.ok(
  invalid.stdout.includes('"status": "invalid"'),
  'CLI bin: --json should print the result',
);
const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
assert.equal(help.status, 0, 'CLI bin: --help should exit 0');

console.log(
  'smoke ✓  @openbounce/core loads (ESM + CJS); the openbounce flagship re-exports the API; the openbounce CLI bin runs (exit 1 on invalid, 0 on --help)',
);
