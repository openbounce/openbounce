/**
 * openbounce engine — public entry point (the composition root: allowed I/O + time; wires the real
 * DNS resolver, the bundled datasets, and the system clock/rng). Pure logic lives under `core/`, real
 * network adapters under `resolvers/`. See docs/guide/how-it-works.md.
 */

import os from 'node:os';
import type {
  BatchOptions,
  Clock,
  DnsResolver,
  MxRecord,
  Result,
  Rng,
  ValidateOptions,
} from './types';
import { type EngineDeps, runPipeline } from './core/pipeline';
import { runPool } from './core/pool';
import { defaultData } from './data';
import { NodeDnsResolver } from './resolvers/node-dns';
import { NetSmtpProber } from './resolvers/smtp';
import { normalizeEmail } from './core/syntax';

export type * from './types';
export { isValidSyntax, normalizeEmail, parseEmail } from './core/syntax';

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
        },
        { once: true },
      );
    }),
};
const systemRng: Rng = { next: () => Math.random() };
const defaultDns = new NodeDnsResolver();
const defaultProber = new NetSmtpProber();
// A best-effort default EHLO/HELO name for real probes. Callers SHOULD override with a hostname whose
// rDNS matches their sending IP (see ValidateOptions.heloHost) for good deliverability/reputation.
const systemHelo = os.hostname() || 'localhost';

/**
 * Public-API defaults. **SMTP is off by default** (offline): a bare `validate(email)` does no
 * third-party network I/O, so it is safe to call on a hot path. Opt in with `smtp: 'auto'` (probe when a
 * port-25 preflight succeeds) or `smtp: true`. Also fills a best-effort EHLO/HELO name (override via
 * `heloHost`). Runtime-cost note: probing is seconds/domain and network-bound — see docs/guide/performance.
 */
function applyDefaults(options: ValidateOptions): ValidateOptions {
  return {
    ...options,
    smtp: options.smtp ?? false,
    heloHost: options.heloHost ?? systemHelo,
  };
}

function resolveDeps(options: ValidateOptions): EngineDeps {
  return {
    data: options.data ?? defaultData,
    // Honor a custom per-call DNS timeout by building a resolver for it; else reuse the singleton.
    dns:
      options.dns ??
      (options.timeoutMs === undefined
        ? defaultDns
        : new NodeDnsResolver({ timeoutMs: options.timeoutMs })),
    prober: options.prober ?? defaultProber,
    clock: options.clock ?? systemClock,
    rng: options.rng ?? systemRng,
  };
}

/** Wrap a resolver so DNS is looked up once per domain across a batch (a failure is not cached). */
function cachingDns(dns: DnsResolver): DnsResolver {
  const mx = new Map<string, Promise<MxRecord[]>>();
  const addr = new Map<string, Promise<string[]>>();
  return {
    resolveMx: (domain) => {
      const hit = mx.get(domain);
      if (hit) return hit;
      const p = dns.resolveMx(domain).catch((err: unknown) => {
        mx.delete(domain);
        throw err;
      });
      mx.set(domain, p);
      return p;
    },
    resolve: (domain, type) => {
      const cacheKey = `${type} ${domain}`;
      const hit = addr.get(cacheKey);
      if (hit) return hit;
      const p = dns.resolve(domain, type).catch((err: unknown) => {
        addr.delete(cacheKey);
        throw err;
      });
      addr.set(cacheKey, p);
      return p;
    },
  };
}

/**
 * The MX domain of an address — the per-domain serialization key for the batch pool. Must match how the
 * pipeline normalizes the domain (`normalizeEmail` trims then lowercases), or two spellings of one domain
 * would be treated as different keys and open concurrent connections to the same MX (good-citizen bug).
 */
function domainKey(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  return (at === -1 ? trimmed : trimmed.slice(at + 1)).toLowerCase();
}

function clampConcurrency(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

async function runSafe(email: string, options: ValidateOptions, deps: EngineDeps): Promise<Result> {
  try {
    return await runPipeline(email, options, deps);
  } catch {
    // A batch must never abort on one bad row — degrade a hard failure to a typed `unknown` result.
    return {
      email: normalizeEmail(email),
      status: 'unknown',
      subStatus: 'dns_error',
      reachable: 'unknown',
      confidence: 0,
      free: false,
      role: false,
      disposable: false,
      smtp: { attempted: false, available: false },
      checks: [],
      durationMs: 0,
    };
  }
}

/**
 * Validate an email address. Runs the full pipeline: syntax → typo → disposable/role/free → MX/DNS +
 * provider fingerprint → (only if SMTP is enabled and port 25 is available) an SMTP `RCPT TO` mailbox
 * probe + catch-all detection → scoring. **SMTP is off by default** (offline) — pass `smtp: 'auto'` (or
 * `true`) to enable the probe. Where the mailbox is unconfirmable — SMTP off, no port 25, a catch-all, or
 * an accept-all-prone provider — the result is an honest `risky`/`unknown`, never a guessed `valid`. See
 * docs/guide/how-it-works.md.
 */
export function validate(email: string, options: ValidateOptions = {}): Promise<Result> {
  const opts = applyDefaults(options);
  return runPipeline(email, opts, resolveDeps(opts));
}

/**
 * Validate many addresses with a streaming worker-pool: at most `concurrency` in flight globally
 * (default 10) and `perDomainConcurrency` per MX domain (default 1) — so a bulk run overlaps across
 * domains without hammering any one server (good-citizen; CLAUDE.md #3). DNS is looked up once per
 * domain across the batch (unless `cache: false`). Results are yielded **as they complete** (not input
 * order) — each `Result` carries its `email`. Memory-bounded: the source is pulled lazily, so a
 * huge/streaming input never fully materializes. A per-row failure degrades to a typed `unknown`, never
 * aborting the batch.
 *
 * For maximum throughput the source should interleave domains; a list fully grouped by domain limits how
 * many distinct domains the pool sees at once (see `runPool`). The DNS cache grows with the number of
 * distinct domains in the batch — pass `cache: false` to disable it.
 *
 * Not yet: a per-domain catch-all/mailbox cache and a resumable checkpoint (tracked for a follow-up).
 */
export function validateMany(
  emails: Iterable<string> | AsyncIterable<string>,
  options: BatchOptions = {},
): AsyncIterable<Result> {
  const opts = applyDefaults(options);
  const base = resolveDeps(opts);
  // Cache DNS per domain across the batch by default; `cache: false` opts out (e.g. to bound memory on a
  // batch with millions of distinct domains, or for a long-lived resolver that already caches).
  const deps: EngineDeps = options.cache === false ? base : { ...base, dns: cachingDns(base.dns) };
  return runPool(emails, (email) => runSafe(email, opts, deps), {
    concurrency: clampConcurrency(options.concurrency, 10),
    perKeyConcurrency: clampConcurrency(options.perDomainConcurrency, 1),
    key: domainKey,
  });
}
