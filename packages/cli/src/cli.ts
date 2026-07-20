#!/usr/bin/env node
import { run } from './index';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`openbounce: ${message}\n`);
    process.exitCode = 2;
  });
