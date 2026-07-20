// Combine the pipeline's signals into a final verdict. Pure. `confidence` is our confidence in the
// returned `status` (0–100) — so `unknown` is inherently low-confidence, and we never emit a confident
// `valid` where the truth is unknowable (see docs/guide/how-it-works.md — the honesty principle).

import type { Reachability, Status, SubStatus } from '../types';

export interface Signals {
  readonly syntaxOk: boolean;
  /** true = MX (or fallback A) found; false = none; undefined = DNS lookup failed. */
  readonly hasMx: boolean | undefined;
  readonly disposable: boolean;
  readonly role: boolean;
  /** Was outbound port 25 usable? (from the preflight) */
  readonly smtpAvailable: boolean;
  /** SMTP `RCPT TO` accepted the mailbox — undefined when SMTP didn't run. */
  readonly smtpAccepted?: boolean | undefined;
  /** Domain accepts every address — undefined when the catch-all probe didn't run. */
  readonly catchAll?: boolean | undefined;
  /** Provider whose SMTP results are accept-all-prone (Gmail/M365/Yahoo) — never a confident `valid`. */
  readonly unreliableProvider?: boolean | undefined;
  /** The mailbox probe was greylisted (4xx) even after retries — deliverability undetermined. */
  readonly greylisted?: boolean | undefined;
}

export interface Verdict {
  readonly status: Status;
  readonly subStatus: SubStatus;
  readonly reachable: Reachability;
  readonly confidence: number;
}

export function score(s: Signals): Verdict {
  if (!s.syntaxOk) {
    return { status: 'invalid', subStatus: 'invalid_syntax', reachable: 'invalid', confidence: 99 };
  }
  if (s.hasMx === false) {
    return { status: 'invalid', subStatus: 'no_mx', reachable: 'invalid', confidence: 96 };
  }
  // Disposable is known offline with certainty — decide it before a transient DNS error can mask it
  // (and regardless of the mailbox check).
  if (s.disposable) {
    return { status: 'disposable', subStatus: 'disposable', reachable: 'risky', confidence: 95 };
  }
  if (s.hasMx === undefined) {
    return { status: 'unknown', subStatus: 'dns_error', reachable: 'unknown', confidence: 20 };
  }

  // Honesty invariant: an accept-all-prone provider (Gmail/M365/Yahoo) can never yield a confident
  // `valid` — a `250` there means nothing — so the verdict is `provider_unverifiable` whether or not a
  // probe ran. Deciding it here (rather than inside the probe branch) lets the pipeline SKIP the probe
  // entirely for these providers: it is uninformative and needlessly hammers their servers.
  if (s.unreliableProvider === true) {
    return {
      status: 'unknown',
      subStatus: 'provider_unverifiable',
      reachable: 'risky',
      confidence: 40,
    };
  }

  // SMTP-derived verdicts (Phase 3 — only when the probe actually ran).
  if (s.smtpAvailable && s.smtpAccepted === true && s.catchAll !== true) {
    return { status: 'valid', subStatus: 'ok', reachable: 'safe', confidence: 90 };
  }
  if (s.smtpAvailable && s.smtpAccepted === false) {
    return {
      status: 'invalid',
      subStatus: 'mailbox_not_found',
      reachable: 'invalid',
      confidence: 90,
    };
  }
  if (s.greylisted === true) {
    return { status: 'unknown', subStatus: 'greylisted', reachable: 'unknown', confidence: 25 };
  }
  if (s.catchAll === true) {
    return { status: 'catch_all', subStatus: 'catch_all', reachable: 'risky', confidence: 60 };
  }

  // No decisive mailbox signal.
  if (s.role) {
    return { status: 'role', subStatus: 'role_account', reachable: 'risky', confidence: 70 };
  }

  // Deliverable domain, mailbox unverified (SMTP not run / unavailable) — the honest default.
  return { status: 'unknown', subStatus: 'smtp_unavailable', reachable: 'unknown', confidence: 30 };
}
