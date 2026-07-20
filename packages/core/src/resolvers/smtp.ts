// SMTP probers (impure adapters — allowed I/O; outside the pure core).
//
// - NetSmtpProber: the real prober. Opens a TCP socket to the MX on port 25, wraps it in a line
//   transport, and runs the pure RCPT-TO dialog (see core/smtp-dialog.ts). Good-citizen per CLAUDE.md
//   rule #3: per-step timeouts + an overall dialog deadline, null-capable MAIL FROM, never DATA, QUIT.
//   Greylist retry + catch-all live in the pipeline (they need the injected Clock/Rng). preflight is
//   memoized — outbound :25 reachability is a per-process property, not a per-address one.
// - UnavailableSmtpProber: forces the "port 25 unavailable → degrade to unknown" path (tests / opt-out).

import net from 'node:net';
import { runRcptProbe, type SmtpTransport } from '../core/smtp-dialog';
import type { SmtpProbeInput, SmtpProbeResult, SmtpProber } from '../types';

// Cap the un-newlined buffer so a hostile server streaming one enormous line can't exhaust memory
// (RFC 5321 caps reply lines far lower; this is a lenient safety ceiling).
const MAX_LINE_BYTES = 8192;

export type ConnectFn = (
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<net.Socket>;

/** Open a TCP connection with a bounded connect timeout; rejects on error/timeout/abort. */
const connectTcp: ConnectFn = (host, port, timeoutMs, signal) =>
  new Promise<net.Socket>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(
      () => fail(new Error(`connect timeout to ${host}:${port}`)),
      timeoutMs,
    );
    const onConnect = (): void => {
      cleanup();
      resolve(socket);
    };
    function fail(err: Error): void {
      cleanup();
      socket.destroy();
      reject(err);
    }
    const onAbort = (): void =>
      fail(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', fail);
      signal?.removeEventListener('abort', onAbort);
    }
    socket.once('connect', onConnect);
    socket.once('error', fail);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** A line-oriented transport over a connected socket, with a per-read timeout AND an overall deadline. */
class SocketTransport implements SmtpTransport {
  private buffer = '';
  private readonly queue: string[] = [];
  private waiter: { resolve: (line: string) => void; reject: (err: Error) => void } | undefined;
  private waiterTimer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;
  private closed = false;
  private readonly overallTimer: ReturnType<typeof setTimeout>;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;

  constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.signal = signal;
    this.onAbort = (): void =>
      this.fail(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err: Error) => this.fail(err));
    socket.on('close', () => this.fail(new Error('connection closed')));
    // The per-read timeout re-arms per line, so a server that drip-feeds one line just under it could
    // hold the socket open forever. This absolute deadline bounds the whole dialog.
    this.overallTimer = setTimeout(
      () => this.fail(new Error('SMTP dialog deadline exceeded')),
      timeoutMs * 3,
    );
    if (signal) {
      if (signal.aborted) this.onAbort();
      else signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.queue.push(line);
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.fail(new Error('SMTP reply line too long'));
      return;
    }
    this.deliver();
  }

  private deliver(): void {
    if (this.waiter && this.queue.length > 0) {
      const line = this.queue.shift() as string;
      const { resolve } = this.waiter;
      this.clearWaiter();
      resolve(line);
    }
  }

  private clearWaiter(): void {
    if (this.waiterTimer) clearTimeout(this.waiterTimer);
    this.waiterTimer = undefined;
    this.waiter = undefined;
  }

  private teardown(): void {
    clearTimeout(this.overallTimer);
    if (this.waiterTimer) clearTimeout(this.waiterTimer);
    this.waiterTimer = undefined;
    this.signal?.removeEventListener('abort', this.onAbort);
  }

  private fail(err: Error): void {
    if (this.failure || this.closed) return;
    this.failure = err;
    this.teardown();
    this.socket.destroy();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(err);
  }

  readLine(): Promise<string> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as string);
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('transport closed'));
    return new Promise<string>((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.waiterTimer = setTimeout(() => {
        this.clearWaiter();
        reject(new Error('SMTP read timeout'));
      }, this.timeoutMs);
    });
  }

  writeLine(command: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket.write(`${command}\r\n`, (err) => (err ? reject(err) : resolve()));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(new Error('transport closed'));
    this.socket.destroy();
  }
}

export interface NetSmtpProberOptions {
  /** SMTP port. Default 25. */
  readonly port?: number;
  /** Host used by preflight to test outbound :25 reachability. Default a stable public MX. */
  readonly preflightHost?: string;
  /** Connection factory — injectable for tests. Default is a real TCP connect. */
  readonly connect?: ConnectFn;
}

export class NetSmtpProber implements SmtpProber {
  private readonly port: number;
  private readonly preflightHost: string;
  private readonly connect: ConnectFn;
  private preflightResult: Promise<boolean> | undefined;

  constructor(options: NetSmtpProberOptions = {}) {
    this.port = options.port ?? 25;
    this.preflightHost = options.preflightHost ?? 'gmail-smtp-in.l.google.com';
    this.connect = options.connect ?? connectTcp;
  }

  /**
   * Can we open an outbound :25 connection at all in this environment? Memoized so a batch does ONE
   * connect rather than one per address. A transient failure is not cached (so a later call retries).
   */
  preflight(timeoutMs: number): Promise<boolean> {
    return (this.preflightResult ??= this.runPreflight(timeoutMs));
  }

  private async runPreflight(timeoutMs: number): Promise<boolean> {
    try {
      const socket = await this.connect(this.preflightHost, this.port, timeoutMs);
      socket.destroy();
      return true;
    } catch {
      this.preflightResult = undefined; // don't cache a transient failure
      return false;
    }
  }

  /** One RCPT-TO probe against `input.mxHost`. Opens a connection, runs the dialog, closes. */
  async probe(input: SmtpProbeInput): Promise<SmtpProbeResult> {
    const socket = await this.connect(input.mxHost, this.port, input.timeoutMs, input.signal);
    const transport = new SocketTransport(socket, input.timeoutMs, input.signal);
    try {
      const r = await runRcptProbe(transport, {
        email: input.email,
        heloHost: input.heloHost,
        fromAddress: input.fromAddress,
      });
      return {
        code: r.code,
        accepted: r.outcome === 'accepted',
        outcome: r.outcome,
        message: r.message,
      };
    } finally {
      transport.close();
    }
  }
}

/** Stub that forces the "port 25 unavailable → degrade to unknown" path (tests / explicit opt-out). */
export class UnavailableSmtpProber implements SmtpProber {
  preflight(): Promise<boolean> {
    return Promise.resolve(false);
  }

  probe(): Promise<never> {
    return Promise.reject(new Error('SMTP probing is disabled (port 25 unavailable).'));
  }
}
