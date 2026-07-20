# openbounce

**The honest email verifier you run yourself — the whole pipeline on your machine, not someone else's cloud.**

Validate email addresses end-to-end on infrastructure **you** control: syntax, typo / did-you-mean,
disposable / role / free classification, and domain (MX/DNS) — all **offline, zero infra, no API key** —
plus proper **catch-all detection** and an optional good-citizen SMTP mailbox probe. Every verdict is a
**calibrated 0–100 confidence with a per-signal trace** (why, not just what). It stores nothing, phones
home to nobody, and costs nothing per check. Use it from the **CLI** (any stack — and any AI agent can
call it) or as a **library** (TypeScript first — `@openbounce/core`; more language bindings to follow).
MIT-licensed — a local-first alternative to ZeroBounce / NeverBounce you run instead of pay for.

openbounce validate is the **first module of a planned open email-ops platform** — next up:
ground-truth bounce / suppression tooling that learns from your real sends. Same ethos throughout:
open, honest, bring-your-own infrastructure.

> **Status — early (v0), not yet published.** Feature-complete: the offline path (syntax, typo,
> disposable/free/role, MX/DNS with RFC 5321 implicit-MX and RFC 7505 null-MX) **plus** a real SMTP
> `RCPT TO` mailbox probe with catch-all detection, greylist retry, and port-25 preflight gating, **plus**
> a streaming bulk CLI (`--input` → CSV/JSONL, per-domain-serialized, memory-bounded). SMTP is optional
> and degrades to an honest `unknown` where port 25 is blocked. Next: publish v0.1 with published
> benchmarks. See the [roadmap](docs/ROADMAP.md).

## Table of contents

- [Why](#why)
- [Honest by design](#honest-by-design)
- [Install](#install)
- [Use — library](#use--library)
- [Use — CLI](#use--cli)
- [Results at a glance](#results-at-a-glance)
- [Architecture](#architecture)
- [How a check flows](#how-a-check-flows)
- [Packages](#packages)
- [Development](#development)
- [License](#license)

## Why

Services like ZeroBounce/NeverBounce charge per validation **and** require you to upload your list — your
customers' personal data — to their servers. openbounce runs the same core checks on your own machine, at
$0 per check, with the list never leaving your infrastructure.

And unlike the existing open-source options, it's built **for the JavaScript ecosystem**: a typed,
in-process `npm i` library — no Rust service to run, no HTTP wrapper to a hosted API — with catch-all
handled properly and a transparent, calibrated verdict instead of a coarse label. The offline checks work
anywhere (serverless included); the SMTP mailbox probe is optional and needs outbound port 25 (a box that
can reach the internet on :25), so the tool is useful even where port 25 is blocked.

## Honest by design

Email verification has a real accuracy ceiling that **no tool can beat without proprietary data**.
Microsoft 365 / Outlook, Gmail, Yahoo and catch-all domains deliberately make per-mailbox verification
unreliable — Gmail, for one, returns "OK" for every address you probe. The **paid** services paper over
this and report a confident (often wrong) `valid`; their headline "99%" is computed only over the
addresses they can actually classify. openbounce instead fingerprints the provider and returns a
**calibrated 0–100 confidence** with a `risky` / `unknown` reachability — and a per-signal `checks[]`
trace so you can see *why* — whenever the truth is genuinely unknowable.

**What it's great at:** catching `invalid` / `disposable` / role / bad-syntax / dead-domain / typo'd
addresses, catch-all detection, and confirming mailboxes on domains that run their **own honest-rejection
mail server** — self-hosted, Exchange, Zoho, Proton, and the like (with port 25 open). **What it can't do
(and says so):** confirm a specific mailbox at Gmail / Yahoo / Microsoft 365 — *including* business
domains hosted on **Google Workspace or Microsoft 365**, which share the same accept-all MX — or run the
SMTP probe where outbound port 25 is blocked (most clouds and home ISPs). It returns an honest `unknown`
there, never a guess. openbounce is also **not** a spam-trap detector (that
needs proprietary threat-intel data — out of scope). We measure all of this: the
[benchmarks](bench/) define the methodology, and the published numbers — counting `unknown` as unknown,
not as a win — land with v0.1.

**Why so much of a consumer list comes back `unknown`** — two things no tool controls: (1) Gmail / Yahoo /
default Microsoft 365 reply `250 OK` to *every* address (anti-harvesting), so mailbox existence is
unknowable over SMTP; and (2) outbound port 25, which the probe needs, is blocked on most clouds and home
ISPs. So a typical consumer list splits like this:

```
  ████████████████████████████░░  ~80–90%  Gmail/Yahoo/M365 + Workspace/M365-hosted + catch-all → unknowable by ANYONE
  ████                             ~10–20%  domains on their own honest-rejection mail server    → we verify
  ▏all of it: syntax · typo · disposable · role · dead-domain (MX)                                → 100% knowable, offline
```

(A lot of "corporate" domains are on Google Workspace or Microsoft 365 — same accept-all MX as consumer
Gmail/Outlook — so they land in the top band, not the verifiable one. We don't pretend otherwise.)

The paid services *guess* on the grey band — their headline "99%" hides it (independent tests put them
around 60–70% there). openbounce says `unknown`: not because it knows less, but because it won't fake it.
More on the accuracy ceiling in the [FAQ](docs/guide/faq.md).

## Install

> Not yet published — coming with `v0.1`.

```sh
npm install openbounce        # the whole tool: library API + the `openbounce` CLI
npx openbounce user@x.com     # …or run the CLI without installing

npm install @openbounce/core  # lean engine only (no CLI) — for embedding in your own app
```

`openbounce` is the flagship (library + CLI); `@openbounce/core` is the lean, zero-dep engine it's built
on. Details: [getting-started](docs/guide/getting-started.md#install).

## Use — library

```ts
import { validate, validateMany } from 'openbounce'; // or '@openbounce/core' for the lean engine

const r = await validate('name@company.com');
// r → { email, status, subStatus, reachable, confidence, provider?,
//       free, role, disposable, mx?, checks[], durationMs, ... }
if (r.status === 'invalid') reject(r.subStatus); // 'invalid_syntax' | 'no_mx' | ...

// Clean a list — results stream back as they complete (not input order; each carries its `email`),
// memory-bounded, DNS cached per domain, and serialized per MX (good-citizen):
for await (const result of validateMany(emails, { concurrency: 10 })) {
  save(result); // key by result.email — completion order ≠ input order
}
```

## Use — CLI

```sh
openbounce user@example.com                 # human-readable
openbounce user@example.com --json          # machine-readable (exit 1 if invalid)

# Bulk-clean a list (one address per line, or CSV column 1) — offline by default:
openbounce --input list.csv --output clean.csv
openbounce --input list.csv --format jsonl                   # JSONL to stdout
openbounce --input list.csv --smtp                           # also run the SMTP probe (needs port 25)
openbounce --input list.csv --concurrency 20 --per-domain 1  # good-citizen bulk defaults
```

## Results at a glance

`validate()` returns a `Result`. The headline is `status`; `reachable` is the "should I send?" summary;
`confidence` (0–100) is how sure we are of that `status`; `subStatus` is the machine-readable reason.

| `status`      | Means                                                                | Typical `reachable` |
| ------------- | -------------------------------------------------------------------- | ------------------- |
| `valid`       | Mailbox confirmed to exist (SMTP, on a provider we trust)  | `safe`              |
| `invalid`     | Bad syntax, dead domain (no MX / A / AAAA), or the mailbox was rejected | `invalid`        |
| `disposable`  | Throwaway-inbox domain (mailinator & friends)                        | `risky`             |
| `role`        | Shared / role mailbox (`info@`, `sales@`, `support@`…)               | `risky`             |
| `catch_all`   | Domain accepts everything — the mailbox can't be confirmed | `risky`             |
| `unknown`     | Undetermined: no port 25, a DNS error, or an accept-all-prone provider (Gmail/M365/Yahoo) | `unknown` / `risky` |

The honesty rule in one line: a `250 OK` from an accept-all-prone provider is **never** promoted to a
confident `valid` — it degrades to `unknown` (`subStatus: provider_unverifiable`).

## Architecture

The whole verdict logic is a **pure core** — no I/O, no clock, no randomness (enforced by an ESLint
rule) — so it's deterministic and unit-testable with fakes. Anything impure (DNS, and SMTP over port 25)
is reached only through a small injected interface (a *seam*). `index.ts` is the one place that wires the
real adapters in as defaults; tests wire fakes.

```
                 validate() · validateMany()        ← index.ts (composition root)
                          │  wires real adapters + system clock/rng as defaults
                          ▼
     ┌──────────────── the seams — interfaces in types.ts ────────────────┐
     │   DnsResolver · SmtpProber · Clock · Rng · DataProvider             │
     └─────────────────────────────────────────────────────────────────────┘
            ▲ consumes                                   ▲ implements
   ┌──────── PURE CORE (core/, data/) ──────────┐   ┌──── IMPURE ADAPTERS (resolvers/) ────┐
   │  pipeline  — the orchestrator              │   │  NodeDnsResolver — node:dns           │
   │  syntax · typo · fingerprint · score       │   │  NetSmtpProber   — node:net socket    │
   │  smtp-dialog — pure RCPT-TO state machine  │   └───────────────────────────────────────┘
   │  data/ — bundled lists (Set-backed O(1))   │
   │  no I/O · no time · no rng (lint-enforced)  │
   └─────────────────────────────────────────────┘
```

**Inside `@openbounce/core`:**

- `core/syntax.ts` — normalize + parse + RFC-flavored, ReDoS-safe validation.
- `core/typo.ts` — Levenshtein did-you-mean (guarded against look-alike false corrections).
- `core/fingerprint.ts` — provider from MX by DNS-label suffix (spoof-resistant); flags accept-all-prone providers.
- `core/score.ts` — the honesty state machine: `Signals → Verdict`.
- `core/pipeline.ts` — the orchestrator; owns the MX branch (null-MX vs. implicit A→AAAA) and the SMTP probe / greylist / catch-all steps.
- `core/pool.ts` — the pure streaming worker-pool behind `validateMany`: bounded global + per-domain concurrency, yields as-completed, memory-bounded.
- `core/smtp-dialog.ts` — the pure SMTP `RCPT TO` state machine (drives an injected line transport; never sends DATA).
- `data/` — the default `DataProvider`: lists inlined at build — the disposable set (~8k domains, CC0), plus curated free / role / typo lists.
- `resolvers/` — real `NodeDnsResolver` (node:dns) + `NetSmtpProber` (node:net socket, per-step timeouts).

Full design walkthrough: [how it works](docs/guide/how-it-works.md).

## How a check flows

Cheapest / most-certain checks first, network last, degrading gracefully; each stage appends to a
`checks[]` trace so any verdict can be explained:

**syntax → typo → disposable / role / free → MX/DNS + provider fingerprint → port-25 preflight → SMTP
mailbox probe → catch-all → scoring.**

The DNS stage decides deliverability: a real MX is fingerprinted; an RFC 7505 null MX (`0 .`) is reported
`no_mx` (no A fallback); no MX falls back to an A — then AAAA — record (RFC 5321 implicit MX); a lookup
failure degrades to `unknown`, never a guess. If port 25 is unavailable, the SMTP-dependent stages are
skipped and reported as `unknown` rather than guessed.

## Packages

| Package | What |
|---|---|
| [`openbounce`](packages/cli) | **The flagship** — the library API (re-exports the engine) **+** the `openbounce` CLI. `npm i openbounce`. |
| [`@openbounce/core`](packages/core) | The lean, zero-dep engine: pure validation core + default DNS/SMTP resolvers + bundled datasets. For embedding without the CLI. |

See the [getting-started guide](docs/guide/getting-started.md#install) for how they relate + which to install.

## Development

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build && pnpm smoke
```

Requires Node ≥ 22 and pnpm. A fresh clone passes the full gate with no manual setup. `pnpm typecheck`
runs a dual TypeScript gate — the TS 6 toolchain plus a TS 7 `--noEmit` forward-compat pass. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for how to set up, test, and submit changes.

## License

[MIT](LICENSE) © Sharvil Kadam
