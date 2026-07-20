import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { validate, validateMany, type BatchOptions, type Result } from '@openbounce/core';

const USAGE = `openbounce — local-first email verification

Usage:
  openbounce <email> [--json]              Validate one address
  openbounce --input <file> [options]      Bulk-validate a list (one address per line, or CSV column 1)

Options:
  --json                 (single) print the full result as JSON
  -i, --input <file>     (bulk) read addresses from a file
  -o, --output <file>    (bulk) write results here (default: stdout)
  --format <csv|jsonl>   (bulk) output format (default: csv)
  --concurrency <n>      (bulk) max validations in flight (default: 10)
  --per-domain <n>       (bulk) max concurrent probes per MX domain (default: 1)
  --smtp                 enable the SMTP mailbox probe (default: offline checks only; needs port 25)
  -h, --help             show this help

Exit codes: 0 = ok · 1 = invalid (single) / usage or I/O error · 2 = unexpected
`;

/** Injectable engine — tests pass fakes so the CLI is exercised without the network. */
export interface CliDeps {
  validate: typeof validate;
  validateMany: typeof validateMany;
}

/**
 * Run the CLI. Returns the intended process exit code (so it is trivially testable). Writing to
 * stdout/stderr (and, in bulk mode, files) is the only side effect.
 */
export async function run(
  argv: string[],
  deps: CliDeps = { validate, validateMany },
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        input: { type: 'string', short: 'i' },
        output: { type: 'string', short: 'o' },
        format: { type: 'string' },
        concurrency: { type: 'string' },
        'per-domain': { type: 'string' },
        smtp: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`openbounce: ${message}\n${USAGE}`);
    return 1;
  }
  const { positionals, values } = parsed;

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (values.input !== undefined) return runBulk(values, deps);

  const [email] = positionals;
  if (email === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  // Offline by default (SMTP is opt-in via --smtp), mirroring bulk mode and the offline-first stance —
  // `openbounce user@x.com` must not fire an unsolicited live probe just because port 25 happens to be open.
  const result = await deps.validate(email, { smtp: values.smtp === true ? 'auto' : false });
  const output = values.json === true ? JSON.stringify(result, null, 2) : formatHuman(result);
  process.stdout.write(`${output}\n`);
  return result.status === 'invalid' ? 1 : 0;
}

interface BulkValues {
  input?: string | undefined;
  output?: string | undefined;
  format?: string | undefined;
  concurrency?: string | undefined;
  'per-domain'?: string | undefined;
  smtp?: boolean | undefined;
}

async function runBulk(values: BulkValues, deps: CliDeps): Promise<number> {
  const inputPath = values.input as string;
  const format = values.format === 'jsonl' ? 'jsonl' : 'csv';
  const options: BatchOptions = {
    // Bulk defaults to offline — the SMTP probe is opt-in (`--smtp`) so a large list can't accidentally
    // hammer mail servers. Per-domain serialization (default 1) keeps it good-citizen when enabled.
    smtp: values.smtp === true ? 'auto' : false,
    ...(values.concurrency !== undefined ? { concurrency: Number(values.concurrency) } : {}),
    ...(values['per-domain'] !== undefined
      ? { perDomainConcurrency: Number(values['per-domain']) }
      : {}),
  };

  const toFile = values.output !== undefined;
  const out: NodeJS.WritableStream = toFile
    ? createWriteStream(values.output as string)
    : process.stdout;

  // Capture the first stream error (ENOSPC on a file, EPIPE on `openbounce … | head`) instead of
  // letting an unhandled 'error' event crash the process — and reject any in-flight write so a failed
  // write can't hang (the write() callback "may or may not" fire on error, per Node's docs).
  let streamErr: NodeJS.ErrnoException | undefined;
  let rejectInflight: ((err: Error) => void) | undefined;
  const onError = (err: NodeJS.ErrnoException): void => {
    streamErr ??= err;
    rejectInflight?.(err);
  };
  out.on('error', onError);

  const write = (chunk: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (streamErr) {
        reject(streamErr);
        return;
      }
      rejectInflight = reject;
      out.write(chunk, (err) => {
        rejectInflight = undefined;
        if (err) reject(err);
        else resolve();
      });
    });

  async function* addresses(): AsyncIterable<string> {
    // Create + iterate the reader lazily here: if it were created earlier, its `line` events would fire
    // (and be lost) during the header write below, before the async iterator attaches. The `finally`
    // runs even on early termination because runPool forwards `return()` to this generator.
    const input = createReadStream(inputPath);
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const email = line.split(',')[0]?.trim();
        if (email !== undefined && email.length > 0) yield email;
      }
    } finally {
      rl.close();
      input.destroy(); // rl.close() alone does not close the underlying fd
    }
  }

  let count = 0;
  try {
    if (format === 'csv') await write(`${CSV_HEADER}\n`);
    for await (const result of deps.validateMany(addresses(), options)) {
      await write(`${format === 'csv' ? toCsvRow(result) : JSON.stringify(result)}\n`);
      count += 1;
    }
  } catch (err) {
    // A closed downstream pipe (`| head`) is a normal, successful early exit — not a failure.
    if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') return 0;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`openbounce: ${message}\n`);
    return 1;
  } finally {
    out.off('error', onError);
    // End a file stream so its buffer flushes; never end process.stdout (that closes fd 1 process-wide).
    // Skip end() on an already-errored/destroyed stream — 'finish' would never fire and end() would hang.
    if (toFile) {
      const fileOut = out as ReturnType<typeof createWriteStream>;
      if (!fileOut.destroyed && streamErr === undefined) {
        await new Promise<void>((resolve) => fileOut.end(resolve));
      }
    }
  }
  process.stderr.write(`openbounce: validated ${count} address(es)\n`);
  return 0;
}

export const CSV_HEADER =
  'email,status,subStatus,reachable,confidence,provider,free,role,disposable,didYouMean';

export function toCsvRow(r: Result): string {
  return [
    r.email,
    r.status,
    r.subStatus,
    r.reachable,
    String(r.confidence),
    r.provider ?? '',
    String(r.free),
    String(r.role),
    String(r.disposable),
    r.didYouMean ?? '',
  ]
    .map(csvField)
    .join(',');
}

function csvField(value: string): string {
  const clean = stripControl(value);
  // Guard against spreadsheet formula injection (CWE-1236): a cell beginning with = + - @ is evaluated
  // as a formula by Excel/Sheets. Attacker-controlled fields (email, didYouMean) flow through verbatim,
  // so prefix a leading trigger char with a single quote. (Tab/CR triggers are already removed by
  // stripControl, which also removes newlines — so the quoting test below only needs `,` and `"`.)
  const guarded = /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
  return /[",]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function stripControl(value: string): string {
  // Strip control + format + line/paragraph-separator chars so an attacker-controlled address can't
  // inject terminal escape sequences OR bidi/zero-width "Trojan Source" display spoofs when echoed to a
  // TTY (Cc = control, Cf = format incl. bidi overrides, Zl/Zp = line/paragraph separators).
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

function formatHuman(r: Result): string {
  const lines = [
    stripControl(r.email),
    `  status:      ${r.status} (${r.subStatus})`,
    `  reachable:   ${r.reachable}`,
    `  confidence:  ${r.confidence}`,
  ];
  if (r.provider !== undefined) lines.push(`  provider:    ${r.provider}`);
  const flags = [
    r.disposable ? 'disposable' : undefined,
    r.role ? 'role' : undefined,
    r.free ? 'free' : undefined,
  ].filter((f): f is string => f !== undefined);
  if (flags.length > 0) lines.push(`  flags:       ${flags.join(', ')}`);
  if (r.didYouMean !== undefined) lines.push(`  did you mean: ${r.didYouMean}`);
  return lines.join('\n');
}
