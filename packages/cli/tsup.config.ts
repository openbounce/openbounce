import { defineConfig } from 'tsup';

export default defineConfig({
  // `cli` = the `openbounce` bin (shebang preserved). `lib` = the flagship library entry, which just
  // re-exports @openbounce/core so `import { validate } from 'openbounce'` works (ADR-016). The CLI's own
  // internals (`run`, `toCsvRow`) are bundled into `cli` and tested from source — not a public API.
  // @openbounce/core is a dependency and stays external (resolved at runtime), never bundled in.
  entry: { cli: 'src/cli.ts', lib: 'src/lib.ts' },
  format: ['esm'],
  // Build-only tsconfig (no `@/` path alias); see packages/cli/tsconfig.build.json.
  tsconfig: 'tsconfig.build.json',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
