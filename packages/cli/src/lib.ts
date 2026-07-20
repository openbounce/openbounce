// The flagship `openbounce` package's library entry — re-exports the engine so `import { validate }
// from 'openbounce'` works. The code lives in @openbounce/core; this is the batteries-included surface
// (core API here + the `openbounce` CLI bin in cli.ts). See docs/guide/getting-started.md.
export * from '@openbounce/core';
