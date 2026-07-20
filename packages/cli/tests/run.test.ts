import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BatchOptions, Result } from '@openbounce/core';
import { CSV_HEADER, type CliDeps, run, toCsvRow } from '@/index';

// Deterministic + offline: inject a fake engine so the CLI is tested for arg-parsing, bulk I/O, output
// formats, and exit codes without a real DNS/SMTP lookup.
function fakeResult(status: Result['status'], email = 'user@acme.example'): Result {
  return {
    email,
    status,
    subStatus: status === 'invalid' ? 'invalid_syntax' : 'smtp_unavailable',
    reachable: status === 'invalid' ? 'invalid' : 'unknown',
    confidence: 50,
    free: false,
    role: false,
    disposable: false,
    smtp: { attempted: false, available: false },
    checks: [],
    durationMs: 0,
  };
}

// single mode never iterates addresses
async function* emptyMany(): AsyncIterable<Result> {
  // no addresses to yield
}

const singleDeps = (status: Result['status']): CliDeps => ({
  validate: () => Promise.resolve(fakeResult(status)),
  validateMany: emptyMany,
});

describe('cli run — single', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('exits 1 when the verdict is invalid', async () => {
    expect(await run(['x@bad', '--json'], singleDeps('invalid'))).toBe(1);
  });
  it('exits 0 on a non-invalid verdict', async () => {
    expect(await run(['user@acme.example', '--json'], singleDeps('unknown'))).toBe(0);
  });
  it('exits 1 and prints usage with no arguments', async () => {
    expect(await run([], singleDeps('unknown'))).toBe(1);
  });
  it('exits 0 on --help', async () => {
    expect(await run(['--help'], singleDeps('unknown'))).toBe(0);
  });
  it('exits 1 on an unknown flag (usage error, not a crash)', async () => {
    expect(await run(['--bogus', 'a@b.com'], singleDeps('unknown'))).toBe(1);
  });
  it('emits parseable JSON with --json', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    await run(['user@acme.example', '--json'], singleDeps('unknown'));
    expect(() => JSON.parse(chunks.join('').trim())).not.toThrow();
  });

  it('single mode is offline by default (smtp:false)', async () => {
    let opts: unknown;
    await run(['user@acme.example'], {
      validate: (_email, o) => {
        opts = o;
        return Promise.resolve(fakeResult('unknown'));
      },
      validateMany: emptyMany,
    });
    expect(opts).toMatchObject({ smtp: false });
  });

  it('single mode honors --smtp (smtp:auto)', async () => {
    let opts: unknown;
    await run(['user@acme.example', '--smtp'], {
      validate: (_email, o) => {
        opts = o;
        return Promise.resolve(fakeResult('unknown'));
      },
      validateMany: emptyMany,
    });
    expect(opts).toMatchObject({ smtp: 'auto' });
  });
});

describe('cli run — bulk', () => {
  let dir: string;
  // Captured by the fake engine so tests can assert the CLI flags actually reach the engine options.
  let captured: { emails: string[]; options: BatchOptions | undefined } | undefined;

  beforeEach(async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Silence bulk-to-stdout output by default (and honor the write-callback so writeChunk resolves);
    // the stdout-capture test re-spies to collect the chunks.
    vi.spyOn(process.stdout, 'write').mockImplementation(((_chunk: unknown, ...rest: unknown[]) => {
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof process.stdout.write);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openbounce-cli-'));
    captured = undefined;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    // Cleanup in afterEach (not inline) so a mid-test assertion failure can't leak temp files.
    await fs.rm(dir, { recursive: true, force: true });
  });

  const p = (name: string): string => path.join(dir, name);

  async function* fakeMany(
    emails: Iterable<string> | AsyncIterable<string>,
    options?: BatchOptions,
  ): AsyncIterable<Result> {
    const collected: string[] = [];
    for await (const email of emails) {
      collected.push(email);
      yield fakeResult('unknown', email);
    }
    captured = { emails: collected, options };
  }
  const bulkDeps: CliDeps = {
    validate: () => Promise.resolve(fakeResult('unknown')),
    validateMany: fakeMany,
  };

  it('reads a list and writes a CSV file (header + one row per address)', async () => {
    const inPath = p('in.txt');
    const outPath = p('out.csv');
    await fs.writeFile(inPath, 'a@x.example\nb@y.example\n\n'); // trailing blank line ignored
    expect(await run(['--input', inPath, '--output', outPath], bulkDeps)).toBe(0);
    const lines = (await fs.readFile(outPath, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]?.startsWith('a@x.example,')).toBe(true);
  });

  it('writes JSONL with --format jsonl', async () => {
    const inPath = p('in2.txt');
    const outPath = p('out.jsonl');
    await fs.writeFile(inPath, 'a@x.example\n');
    await run(['--input', inPath, '--output', outPath, '--format', 'jsonl'], bulkDeps);
    const line = (await fs.readFile(outPath, 'utf8')).trim();
    expect(JSON.parse(line).email).toBe('a@x.example');
  });

  it('takes the first CSV column as the address', async () => {
    const inPath = p('in3.csv');
    const outPath = p('out3.csv');
    await fs.writeFile(inPath, 'a@x.example,Alice,extra\n');
    await run(['--input', inPath, '--output', outPath], bulkDeps);
    const lines = (await fs.readFile(outPath, 'utf8')).trim().split('\n');
    expect(lines[1]?.startsWith('a@x.example,')).toBe(true);
  });

  it('writes to stdout when no --output is given (header + one row per address)', async () => {
    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
      chunks.push(String(chunk));
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') (cb as () => void)(); // honor the write-callback so writeChunk resolves
      return true;
    }) as typeof process.stdout.write);
    const inPath = p('in.txt');
    await fs.writeFile(inPath, 'a@x.example\nb@y.example\n');
    expect(await run(['--input', inPath], bulkDeps)).toBe(0);
    const lines = chunks.join('').trim().split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines).toHaveLength(3);
  });

  it('wires --smtp / --concurrency / --per-domain through to the engine', async () => {
    const inPath = p('in.txt');
    const outPath = p('out.csv');
    await fs.writeFile(inPath, 'a@x.example\n');
    await run(
      [
        '--input',
        inPath,
        '--output',
        outPath,
        '--smtp',
        '--concurrency',
        '20',
        '--per-domain',
        '2',
      ],
      bulkDeps,
    );
    expect(captured?.options).toMatchObject({
      smtp: 'auto',
      concurrency: 20,
      perDomainConcurrency: 2,
    });
  });

  it('defaults to offline (smtp:false) in bulk mode', async () => {
    const inPath = p('in.txt');
    const outPath = p('out.csv');
    await fs.writeFile(inPath, 'a@x.example\n');
    await run(['--input', inPath, '--output', outPath], bulkDeps);
    expect(captured?.options).toMatchObject({ smtp: false });
  });

  it('returns 1 (not a crash) when the input file is missing', async () => {
    expect(await run(['--input', p('does-not-exist.txt')], bulkDeps)).toBe(1);
  });
});

describe('toCsvRow', () => {
  it('renders a result as a CSV row', () => {
    expect(toCsvRow(fakeResult('valid', 'a@b.com'))).toContain('a@b.com,valid,');
  });

  it('neutralizes spreadsheet formula injection in the email field', () => {
    // A leading = (or + - @) would be executed as a formula by Excel/Sheets — prefix it with a quote.
    expect(toCsvRow(fakeResult('invalid', '=1+2@x.com')).startsWith("'=1+2@x.com,")).toBe(true);
  });
});
