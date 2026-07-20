# How openbounce works

openbounce is a local-first email verifier. It runs a sequence of cheap, offline checks first and only
reaches out to the network last — and when the truth about a mailbox is genuinely unknowable, it says so.
It returns an honest `unknown` rather than a confident-looking `valid` it can't stand behind.

This page explains the verification pipeline, the scoring model, the "honest unknown" principle, the
good-citizen SMTP behavior, and the local-first / pluggable design — so you can understand what the
engine does and trust its verdicts.

## Table of contents

- [The verification pipeline](#the-verification-pipeline)
- [The result](#the-result)
- [The "honest unknown" principle](#the-honest-unknown-principle)
- [Good-citizen SMTP behavior](#good-citizen-smtp-behavior)
- [Local-first: stores nothing](#local-first-stores-nothing)
- [Pluggable by design](#pluggable-by-design)

## The verification pipeline

Every call to `validate(email)` runs the same ordered pipeline. Offline checks run first so obvious
garbage never triggers a network round-trip; the network steps run last and always degrade gracefully.
Each stage appends a `CheckResult` to a per-check trace (`result.checks`), so you can always see exactly
which signals produced a verdict.

| # | Stage                     | What it does                                                                 | Runs |
| - | ------------------------- | ---------------------------------------------------------------------------- | ---- |
| 1 | **Syntax**                | Pragmatic RFC 5321/5322 validation + normalization                           | Offline |
| 2 | **Typo / did-you-mean**   | Levenshtein-distance suggestion against common domains                       | Offline |
| 3 | **Classify**              | Disposable / role / free-provider lookups against bundled datasets           | Offline |
| 4 | **MX / DNS + fingerprint**| Resolve MX (or implicit A/AAAA), identify the mailbox provider               | Network |
| 5 | **SMTP mailbox probe**    | Optional `RCPT TO` probe, gated on a port-25 preflight                       | Network |
| 6 | **Catch-all probe**       | A second `RCPT TO` to a random address, to detect accept-all domains         | Network |
| 7 | **Score**                 | Combine every signal into a calibrated `status` + `confidence`               | Pure |

### 1. Syntax

The address is first normalized — surrounding whitespace trimmed and the **domain lowercased** (the
local-part keeps its case, since some servers treat it as case-sensitive). It is then validated with a
pragmatic, conservative RFC 5321/5322 check: length limits (254 total, 64 local, 253 domain, 63 per
label), a legal local-part atom set, valid DNS labels, and a registrable domain with an alphabetic TLD
of 2+ characters. This deliberately rejects the garbage real-world lists contain rather than trying to
accept every exotic-but-legal quoted form. A syntax failure short-circuits the whole pipeline —
`status: invalid`, `subStatus: invalid_syntax` — before any network call.

### 2. Typo / did-you-mean

An offline Levenshtein-distance comparison against a list of common domains catches likely
mis-types (for example `gmial.com` → `gmail.com`). If a close, plausible correction is found it is
surfaced as `result.didYouMean`. The matcher is conservative: it uses a tighter edit-distance bound for
short domains and rejects "corrections" that would rewrite half or more of the name, so it won't turn
one real domain into a different real domain.

### 3. Classify (offline lookups)

Three O(1), Set-backed lookups run against datasets bundled inside the engine (no runtime fetch):

- **Disposable** — burner/throwaway domains (sourced from a public, permissively licensed list) →
  `disposable: true`, `status: disposable`.
- **Role** — role-account local-parts such as `info`, `support`, `admin` → `role: true`.
- **Free** — consumer/free-mail providers → `free: true` (informational; not itself a negative signal).

### 4. MX / DNS + provider fingerprint

The engine resolves the domain's MX records. Three cases are handled explicitly:

- **MX records present** → the domain accepts mail; the highest-priority host is used for any probe.
- **Null MX (RFC 7505, `0 .`)** → the domain explicitly accepts no mail → `status: invalid`,
  `subStatus: no_mx`. It does **not** fall back to A/AAAA.
- **No MX at all** → per RFC 5321 the engine falls back to an implicit MX: the domain is deliverable if
  it has an A or AAAA address.

If DNS itself fails (timeout, resolver error), that is **not** treated as "invalid" — it degrades to
`status: unknown`, `subStatus: dns_error`. From the MX hostnames, the engine fingerprints the mailbox
provider (`google`, `microsoft`, `yahoo`, `apple`, `proton`, `zoho`, or `custom` for a recognized-but-
unlisted host) by matching DNS-label suffixes — so a look-alike like `mail.snapple.com` is never
mistaken for Apple.

### 5. SMTP mailbox probe (optional, preflight-gated)

SMTP verification is optional and **off by default** — enable it with `smtp: 'auto'` (or `true`). Before probing, the engine runs a one-time
**port-25 preflight** — a single outbound connection test — to check whether SMTP verification is even
possible from the current environment (many networks and cloud hosts block outbound port 25). The
preflight result is memoized per process, so a batch does one preflight, not one per address.

- If port 25 is reachable, the engine opens a connection to the MX host and runs a minimal `RCPT TO`
  dialog (details [below](#good-citizen-smtp-behavior)) to ask whether the mailbox exists.
- If port 25 is unavailable, steps 5–6 are skipped and the mailbox-dependent verdict degrades to
  `unknown` / `smtp_unavailable` — you still get a useful offline result. You can also force this by
  passing `smtp: false`.

A temporary `4xx` reply is treated as greylisting and retried per the `greylist` policy (default: 1
retry after 5s) before giving up as `unknown` / `greylisted`. Only a `5xx` reply **at the `RCPT TO`
step** counts as "no such mailbox"; a `5xx` earlier in the dialog (an RBL block, a refused sender) is
inconclusive and never treated as a rejection.

### 6. Catch-all probe

Many domains accept mail for *every* address, so a `250` for the real mailbox proves nothing. When a
mailbox is accepted on a trustworthy provider, the engine probes a second, random, almost-certainly-
nonexistent address at the same domain:

- The random address is **rejected** → the domain is not catch-all → the original acceptance is real.
- The random address is **accepted** → the domain is catch-all → `catchAll: true`, verdict downgraded to
  `catch_all` / `risky`.
- **Anything else** (inconclusive, greylisted) → the acceptance can't be confirmed, so it is dropped to
  `unknown` rather than reported as a confident `valid`.

Set `checkCatchAll: false` to skip this probe.

### 7. Score

Finally, all signals are combined into the final `status`, `subStatus`, `reachable`, and a calibrated
`confidence` (0–100). `confidence` is the engine's confidence *in the status it returns* — so an
`unknown` is inherently low-confidence, and a clean `valid` is only ever emitted where the mailbox was
actually confirmed on a provider whose answer can be trusted. Representative outcomes:

| Situation                                          | status       | reachable | confidence |
| -------------------------------------------------- | ------------ | --------- | ---------- |
| Bad syntax                                         | `invalid`    | `invalid` | 99         |
| No MX / null MX                                    | `invalid`    | `invalid` | 96         |
| Disposable domain                                  | `disposable` | `risky`   | 95         |
| Mailbox confirmed (trustworthy provider)           | `valid`      | `safe`    | 90         |
| Mailbox rejected (`5xx` at RCPT)                   | `invalid`    | `invalid` | 90         |
| Role account, no decisive mailbox signal           | `role`       | `risky`   | 70         |
| Catch-all domain                                   | `catch_all`  | `risky`   | 60         |
| Big provider accepted (unverifiable)               | `unknown`    | `risky`   | 40         |
| Deliverable domain, mailbox unverified             | `unknown`    | `unknown` | 30         |
| Greylisted after retries                           | `unknown`    | `unknown` | 25         |
| DNS lookup failed                                  | `unknown`    | `unknown` | 20         |

## The result

`validate()` resolves to a `Result` — never throws for a network or probe failure (those degrade to
`unknown`; only invalid *options* throw). The most useful fields:

```ts
interface Result {
  email: string;          // normalized (domain lowercased, trimmed)
  status: 'valid' | 'invalid' | 'catch_all' | 'role' | 'disposable' | 'unknown';
  subStatus: string;      // e.g. 'ok' | 'no_mx' | 'mailbox_not_found' | 'smtp_unavailable' | ...
  reachable: 'safe' | 'risky' | 'invalid' | 'unknown';
  confidence: number;     // 0–100, calibrated by which checks fired
  didYouMean?: string;    // 'user@gmail.com'
  provider?: 'google' | 'microsoft' | 'yahoo' | 'apple' | 'proton' | 'zoho' | 'custom';
  free: boolean;
  role: boolean;
  disposable: boolean;
  catchAll?: boolean;     // present only when the catch-all probe ran
  mx?: { host: string; priority: number }[];
  smtp: { attempted: boolean; available: boolean; code?: number; message?: string };
  checks: { name: string; outcome: 'pass' | 'fail' | 'skip' | 'unknown'; detail?: string }[];
  durationMs: number;
}
```

The `checks` array is the per-stage trace: one entry per stage that ran, each with an outcome and an
optional human-readable detail. It's the fastest way to understand *why* a given address got the verdict
it did.

## The "honest unknown" principle

openbounce will not fake certainty. When a mailbox's real status is unknowable, the result is `unknown`
or `risky` — never a confident `valid`. Two cases matter most:

**Big consumer providers (Gmail, Microsoft/Outlook, Yahoo).** These providers routinely return `250` at
`RCPT TO` for addresses that don't exist, rate-limit probes, and otherwise make SMTP verification
unreliable. A `250` from them means nothing. So when one of these providers accepts a probe, openbounce
does **not** report `valid` — it reports `status: unknown`, `subStatus: provider_unverifiable`,
`reachable: risky`. This is deliberate: a green light we can't stand behind is worse than an honest
"we can't be sure."

**Catch-all domains.** A domain that accepts every recipient can't confirm that any particular mailbox
exists, so an accepted probe there is reported as `catch_all` / `risky`, not `valid`.

The upshot: a `valid` from openbounce is a genuine signal — it is only emitted when a mailbox was
actually confirmed on a provider whose answer can be trusted.

## Good-citizen SMTP behavior

Careless mailbox probing gets sending IPs onto blocklists. openbounce's SMTP dialog is designed to be a
polite, minimal, read-only interrogation that never sends mail:

- **Null sender by default.** It issues `MAIL FROM:<>` (the null sender), not a fake address. You can
  override with `fromAddress` if a server rejects the null sender.
- **Never sends `DATA`.** The dialog stops after `RCPT TO`, then sends `QUIT`. No message is ever
  transmitted — the mailbox is checked, not emailed.
- **EHLO → HELO fallback**, with an EHLO name you should configure. Set `heloHost` to a hostname whose
  reverse DNS matches your sending IP for the best reputation; the engine falls back to a system default
  otherwise.
- **Per-step timeouts and an overall dialog deadline.** Every command has its own timeout (default
  8000ms per network step) plus an absolute ceiling on the whole dialog, so a slow or hostile server
  can't hold a connection open indefinitely. Reply sizes are bounded, too.
- **Per-domain serialization.** In batch mode (`validateMany`) the engine caps global concurrency
  (default 10) and, crucially, serializes probes **per MX domain** (default 1 at a time) so it never
  hammers a single server.
- **Port-25 preflight + graceful offline degrade.** Rather than assuming SMTP works, it tests outbound
  port 25 once and, when unavailable, cleanly falls back to an offline verdict instead of failing.

## Local-first: stores nothing

Everything runs on your machine. The bundled datasets are compiled into the package, so classification
never makes a network request. DNS and SMTP lookups go directly from your host to the relevant servers —
there is no openbounce backend, no telemetry, and no phone-home. The engine holds data only in memory
for the duration of a call (a batch reuses a per-domain DNS cache while it runs) and **persists nothing**
to disk. Full addresses and other PII are not logged.

## Pluggable by design

The engine's logic is a pure core that talks to the network only through small, injectable interfaces.
Every network and non-determinism boundary is a seam you can replace:

| Seam          | Interface     | Default                          |
| ------------- | ------------- | -------------------------------- |
| DNS lookups   | `DnsResolver` | Node's `dns` resolver            |
| SMTP probes   | `SmtpProber`  | A `net`-based TCP prober         |
| Datasets      | `DataProvider`| The bundled disposable/role/free/typo data |
| Time          | `Clock`       | System clock                     |
| Randomness    | `Rng`         | System RNG                       |

Pass any of these into `validate()` or `validateMany()` to supply your own DNS resolver, point probes at
a test server, swap in a custom disposable-domain list, or make runs fully deterministic. You never have
to touch the core logic to change behavior at the edges.

```ts
import { validate } from '@openbounce/core';

// Bring your own DNS resolver; everything else uses the built-in defaults.
const result = await validate('user@example.com', {
  dns: myCustomResolver,
  heloHost: 'mail.mycompany.com',
});
```
