// The SMTP RCPT-TO probe as a PURE state machine over an injected line transport — no sockets, no I/O,
// no time (enforced by the pure-core lint). The real socket lives in resolvers/smtp.ts; greylist delay
// + retry live in the pipeline (via the injected Clock). This is the good-citizen dialog from CLAUDE.md
// rule #3: EHLO→HELO fallback, a null-capable MAIL FROM, a single RCPT TO, **never DATA**, then QUIT.

import type { ProbeOutcome } from '../types';

// Defensive cap: a hostile/broken server that drip-feeds continuation lines can't grow the reply set
// without bound (the transport's per-read timeout + overall deadline are the other half of this guard).
const MAX_REPLY_LINES = 128;

export interface SmtpTransport {
  /** Read one line from the server (CRLF stripped). Rejects if the connection closes first. */
  readLine(): Promise<string>;
  /** Send one command line (the transport appends CRLF). */
  writeLine(command: string): Promise<void>;
}

export interface SmtpReply {
  /** The 3-digit status code, or 0 if the line was unparseable. */
  readonly code: number;
  readonly lines: readonly string[];
}

export interface DialogInput {
  readonly email: string;
  readonly heloHost: string;
  /** MAIL FROM value; '' → the null sender `<>`. */
  readonly fromAddress: string;
}

export interface DialogResult {
  readonly outcome: ProbeOutcome;
  readonly code: number;
  readonly message: string;
}

function is2xx(code: number): boolean {
  return code >= 200 && code < 300;
}

// Classify the RCPT reply — the ONLY step where a 5xx means "no such mailbox".
function classify(code: number): ProbeOutcome {
  if (is2xx(code)) return 'accepted';
  if (code >= 500) return 'rejected';
  if (code >= 400) return 'greylisted';
  return 'inconclusive';
}

// A non-2xx reply BEFORE RCPT (greeting / EHLO / MAIL FROM) is never a mailbox rejection: a 4xx is a
// reason to retry (greylist), anything else is inconclusive (RBL block, sender policy, service down).
function preRcptOutcome(code: number): ProbeOutcome {
  return code >= 400 && code < 500 ? 'greylisted' : 'inconclusive';
}

/**
 * Read one (possibly multiline) SMTP reply. Continuation lines are `250-…`; the final line is `250 …`
 * (a space in the 4th column). The status code is taken from the final line.
 */
export async function readReply(t: SmtpTransport): Promise<SmtpReply> {
  const lines: string[] = [];
  for (;;) {
    const line = await t.readLine();
    lines.push(line);
    if (line.length < 4 || line[3] !== '-') break; // not a continuation → reply complete
    if (lines.length >= MAX_REPLY_LINES) break; // defensive: a server drip-feeding continuations
  }
  const last = lines[lines.length - 1] ?? '';
  const code = Number.parseInt(last.slice(0, 3), 10);
  return { code: Number.isNaN(code) ? 0 : code, lines };
}

/**
 * Run one RCPT-TO probe over an already-connected transport and classify the mailbox verdict for
 * `input.email`. Sends QUIT best-effort; the caller still closes the socket. Never sends DATA.
 */
export async function runRcptProbe(t: SmtpTransport, input: DialogInput): Promise<DialogResult> {
  const greeting = await readReply(t);
  if (greeting.code !== 220) return result(preRcptOutcome(greeting.code), greeting);

  // EHLO, falling back to HELO for servers that don't speak ESMTP.
  await t.writeLine(`EHLO ${input.heloHost}`);
  let hello = await readReply(t);
  if (!is2xx(hello.code)) {
    await t.writeLine(`HELO ${input.heloHost}`);
    hello = await readReply(t);
    if (!is2xx(hello.code)) return result(preRcptOutcome(hello.code), hello);
  }

  await t.writeLine(`MAIL FROM:<${input.fromAddress}>`);
  const mailFrom = await readReply(t);
  if (!is2xx(mailFrom.code)) {
    await quit(t);
    // A non-2xx here is sender/policy (e.g. the null sender refused), NOT a mailbox rejection.
    return result(preRcptOutcome(mailFrom.code), mailFrom);
  }

  // The mailbox check. NEVER send DATA.
  await t.writeLine(`RCPT TO:<${input.email}>`);
  const rcpt = await readReply(t);
  await quit(t);
  return result(classify(rcpt.code), rcpt);
}

async function quit(t: SmtpTransport): Promise<void> {
  try {
    await t.writeLine('QUIT');
    await t.readLine();
  } catch {
    // best-effort — the transport owner closes the socket regardless
  }
}

function result(outcome: ProbeOutcome, reply: SmtpReply): DialogResult {
  return { outcome, code: reply.code, message: reply.lines[0] ?? '' };
}
