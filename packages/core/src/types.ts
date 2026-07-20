/**
 * Public result + option types for the openbounce engine.
 *
 * The taxonomy models ZeroBounce's status set + Reacher's confidence field (see
 * docs/guide/how-it-works.md). `spamtrap`/`abuse` are intentionally
 * absent — they require proprietary threat-intel data and are out of the OSS core (ADR-006).
 */

export type Status = 'valid' | 'invalid' | 'catch_all' | 'role' | 'disposable' | 'unknown';

export type Reachability = 'safe' | 'risky' | 'invalid' | 'unknown';

/** Mailbox provider identified by MX fingerprint (`'custom'` = deliverable but unrecognized). */
export type Provider = 'google' | 'microsoft' | 'yahoo' | 'apple' | 'proton' | 'zoho' | 'custom';

// Every value here is actually emitted by `score.ts` — we don't declare aspirational codes (an honest,
// documented Result schema per ADR-015). New codes land with the code path that produces them.
export type SubStatus =
  | 'ok'
  | 'invalid_syntax'
  | 'no_mx'
  | 'dns_error'
  | 'mailbox_not_found'
  | 'greylisted'
  | 'catch_all'
  | 'role_account'
  | 'disposable'
  | 'smtp_unavailable'
  | 'provider_unverifiable';

export type CheckName =
  'syntax' | 'typo' | 'disposable' | 'role' | 'free' | 'mx' | 'smtp' | 'catch_all';

export interface CheckResult {
  readonly name: CheckName;
  readonly outcome: 'pass' | 'fail' | 'skip' | 'unknown';
  readonly detail?: string;
}

export interface MxRecord {
  readonly host: string;
  readonly priority: number;
}

export interface SmtpInfo {
  readonly attempted: boolean;
  /** Was outbound port 25 usable in this environment (per the preflight)? */
  readonly available: boolean;
  readonly code?: number;
  readonly message?: string;
}

export interface Result {
  /** Normalized address (domain lowercased, surrounding whitespace trimmed). */
  readonly email: string;
  readonly status: Status;
  readonly subStatus: SubStatus;
  readonly reachable: Reachability;
  /** 0–100, calibrated by which checks fired and per-provider reliability. */
  readonly confidence: number;
  readonly didYouMean?: string;
  /** Fingerprinted mailbox provider (present once MX is known). */
  readonly provider?: Provider;
  readonly free: boolean;
  readonly role: boolean;
  readonly disposable: boolean;
  /** Present only when an SMTP catch-all probe ran. */
  readonly catchAll?: boolean;
  readonly mx?: readonly MxRecord[];
  readonly smtp: SmtpInfo;
  /** Per-stage trace — great for debugging and explaining a verdict. */
  readonly checks: readonly CheckResult[];
  readonly durationMs: number;
}

// ---- Injectable seams (the engine provides real defaults; tests inject fakes) ----

export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
}

export interface DnsResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve(domain: string, type: 'A' | 'AAAA'): Promise<string[]>;
}

export interface SmtpProbeInput {
  readonly mxHost: string;
  readonly email: string;
  readonly heloHost: string;
  readonly fromAddress: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * The mailbox verdict from one probe: `accepted` (2xx at RCPT), `rejected` (5xx at RCPT — no such
 * mailbox), `greylisted` (4xx — retry), or `inconclusive` (a pre-RCPT failure, RBL block, or dropped
 * connection — the mailbox was never actually tested, so it must NEVER be treated as a rejection).
 */
export type ProbeOutcome = 'accepted' | 'rejected' | 'greylisted' | 'inconclusive';

export interface SmtpProbeResult {
  readonly code: number;
  readonly accepted: boolean;
  readonly outcome: ProbeOutcome;
  readonly message?: string;
}

export interface SmtpProber {
  /** Can we open an outbound connection on port 25 at all in this environment? */
  preflight(timeoutMs: number): Promise<boolean>;
  probe(input: SmtpProbeInput): Promise<SmtpProbeResult>;
}

export interface DataProvider {
  isDisposable(domain: string): boolean;
  isFreeProvider(domain: string): boolean;
  isRoleAccount(localPart: string): boolean;
  /** did-you-mean suggestion for a likely-typo'd address, or undefined. */
  suggest(email: string): string | undefined;
}

export interface GreylistPolicy {
  readonly retries: number;
  readonly delayMs: number;
}

export interface ValidateOptions {
  /**
   * SMTP mailbox probe. **Off by default** (offline) — a bare `validate()` does no third-party network
   * I/O, so it is safe on a hot path. `'auto'` (or `true`) probes when a port-25 preflight succeeds and
   * degrades to `unknown` otherwise; `false` (the default) forces offline. Probing is seconds per domain
   * and network-bound — reserve it for batch/background work, not a request hot path.
   */
  readonly smtp?: boolean | 'auto';
  readonly checkCatchAll?: boolean;
  readonly timeoutMs?: number;
  /** EHLO FQDN — set to a hostname whose rDNS matches your sending IP. */
  readonly heloHost?: string;
  /** MAIL FROM; defaults to '' (the null sender `<>`). */
  readonly fromAddress?: string;
  readonly greylist?: GreylistPolicy;
  readonly data?: DataProvider;
  readonly dns?: DnsResolver;
  readonly prober?: SmtpProber;
  readonly clock?: Clock;
  readonly rng?: Rng;
  readonly signal?: AbortSignal;
}

export interface BatchOptions extends ValidateOptions {
  /** Global concurrent-probe cap (default 10). */
  readonly concurrency?: number;
  /** Max concurrent probes to one MX domain (default 1 — good-citizen serialization). */
  readonly perDomainConcurrency?: number;
  /** Cache DNS lookups per domain across the batch (default `true`). `false` disables it. */
  readonly cache?: boolean;
}
