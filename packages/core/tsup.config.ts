import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // Build-only tsconfig (no `@/` path alias) so the .d.ts program doesn't synthesize the deprecated
  // `baseUrl`; see packages/core/tsconfig.build.json.
  tsconfig: 'tsconfig.build.json',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
});
