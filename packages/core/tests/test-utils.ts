// Shared test fakes — deterministic seams so the pure pipeline is tested without touching the network,
// the clock, or randomness.
import type { Clock, DnsResolver, ProbeOutcome, Rng, SmtpProber } from '@/types';

export interface DnsFixture {
  mx?: string[];
  a?: string[];
  aaaa?: string[];
  error?: boolean;
}

/** A DnsResolver backed by a fixed map of domain → records. Unknown domains resolve to nothing. */
export function fakeDns(map: Record<string, DnsFixture>): DnsResolver {
  return {
    resolveMx: (domain) => {
      const entry = map[domain];
      if (entry?.error === true) return Promise.reject(new Error('dns SERVFAIL'));
      return Promise.resolve(
        (entry?.mx ?? []).map((host, i) => ({ host, priority: (i + 1) * 10 })),
      );
    },
    resolve: (domain, type) => {
      const entry = map[domain];
      if (entry?.error === true) return Promise.reject(new Error('dns SERVFAIL'));
      return Promise.resolve((type === 'AAAA' ? entry?.aaaa : entry?.a) ?? []);
    },
  };
}

/** Prober whose port 25 is never available (degrade-to-unknown path). */
export const unavailableProber: SmtpProber = {
  preflight: () => Promise.resolve(false),
  probe: () => Promise.reject(new Error('n/a')),
};

export interface FakeProberReply {
  code: number;
  accepted: boolean;
  /** Override the derived outcome — e.g. a pre-RCPT 5xx that is `inconclusive`, not a `rejected`. */
  outcome?: ProbeOutcome;
}

function deriveOutcome(r: FakeProberReply): ProbeOutcome {
  if (r.outcome) return r.outcome;
  if (r.accepted) return 'accepted';
  if (r.code >= 500) return 'rejected';
  if (r.code >= 400) return 'greylisted';
  return 'inconclusive';
}

export interface FakeProberOptions {
  /** preflight() result — default true (port 25 reachable). */
  available?: boolean;
  /** per-recipient replies, keyed by the exact email. */
  replies?: Record<string, FakeProberReply>;
  /** reply for any address not in `replies` (e.g. the random catch-all probe). Default 550 / rejected. */
  fallback?: FakeProberReply;
}

/** A scriptable SMTP prober for pipeline tests — no sockets, fully deterministic. */
export function fakeProber(options: FakeProberOptions = {}): SmtpProber {
  const available = options.available ?? true;
  const fallback = options.fallback ?? { code: 550, accepted: false };
  return {
    preflight: () => Promise.resolve(available),
    probe: (input) => {
      const r = options.replies?.[input.email] ?? fallback;
      return Promise.resolve({ code: r.code, accepted: r.accepted, outcome: deriveOutcome(r) });
    },
  };
}

/** A prober that returns each reply in sequence (repeating the last) — for greylist-retry tests. */
export function sequenceProber(replies: FakeProberReply[]): SmtpProber {
  let i = 0;
  return {
    preflight: () => Promise.resolve(true),
    probe: () => {
      const r = replies[Math.min(i, replies.length - 1)] ?? { code: 0, accepted: false };
      i += 1;
      return Promise.resolve({ code: r.code, accepted: r.accepted, outcome: deriveOutcome(r) });
    },
  };
}

/** A clock whose sleeps resolve immediately but are recorded — to assert greylist backoff happened. */
export function recordingClock(): Clock & { readonly sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    now: () => 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    sleeps,
  };
}

export const fixedClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };
export const fixedRng: Rng = { next: () => 0.42 };
