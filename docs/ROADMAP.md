# Roadmap

openbounce is an honest, local-first email verifier — a TypeScript library and CLI that runs the
whole verification pipeline on your own machine, with no paid API. Its guiding principle is honesty:
when a mailbox genuinely can't be confirmed, it returns `unknown` rather than a confident but fake
`valid`.

This page is a high-level view of what works today and what we're thinking about next. It's a
living document, not a promise — see the note at the bottom.

## Table of contents

- [Shipped (v0.1)](#shipped-v01)
- [Planned / exploring](#planned--exploring)
- [A note on priorities](#a-note-on-priorities)

## Shipped (v0.1)

Everything below is implemented and covered by tests today.

### Offline checks (no network required)

- **Syntax & normalization** — RFC-aware parsing; the domain is lowercased and surrounding
  whitespace trimmed on the returned address.
- **Typo / did-you-mean** — Levenshtein-based suggestions for likely-misspelled provider domains
  (e.g. `user@gmial.com` → `user@gmail.com`). Advisory only: a suggestion never changes the verdict.
- **Disposable / free / role classification** — bundled datasets flag disposable domains
  (thousands of entries), free-mail providers, and role accounts (`info@`, `support@`, …).

### DNS & provider fingerprinting

- **MX / DNS resolution** with RFC 7505 null-MX handling and RFC 5321 implicit-MX fallback
  (A → AAAA).
- **Provider fingerprinting** from the MX records — recognizes `google`, `microsoft`, `yahoo`,
  `apple`, `proton`, `zoho`, and reports `custom` for a deliverable but unrecognized provider.

### SMTP mailbox probe (optional)

A good-citizen `RCPT TO` probe that stays deliberately conservative:

- Null sender (`MAIL FROM:<>`), and it **never sends `DATA`**.
- Per-step timeouts plus an overall deadline; `EHLO` with `HELO` fallback.
- Greylist-aware: a `4xx` triggers a bounded retry.
- **Off by default.** Both the CLI and the library are offline unless you opt in — `--smtp` on the CLI,
  `smtp: 'auto'` (or `true`) in the library. Once enabled it still preflights port 25 and degrades to
  `unknown` when unavailable.
- **Port-25 preflight.** openbounce checks whether outbound port 25 is usable and degrades to `unknown`
  when it isn't (most consumer ISPs and cloud hosts block it) — it never hard-requires the network.
- **Honest to the last mile.** A big consumer provider that accepts every `RCPT` stays
  `provider_unverifiable`, and an unconfirmable catch-all domain stays `unknown` — never a
  fabricated `valid`.

### Catch-all detection

Catch-all domains are probed with a random-address check and reported as `catch_all` / `risky`
rather than being reported as deliverable.

### Streaming bulk verification

- `validateMany` is a streaming worker-pool: bounded global concurrency (default `10`) and
  per-domain concurrency (default `1`, for good-citizen serialization).
- Results are yielded **as they complete**, and each `Result` carries its own `email`.
- Memory-bounded: the input is pulled lazily, so a huge or streaming list never fully materializes.
- Per-domain DNS caching across the batch (default on; `cache: false` opts out).
- A per-row failure degrades to a typed `unknown` — one bad address never aborts the batch.

### CLI

A single `openbounce` binary for one-off checks and bulk lists:

| Flag                  | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `--json`              | (single) print the full `Result` as JSON                            |
| `-i, --input <file>`  | (bulk) read addresses from a file (one per line, or CSV column 1)   |
| `-o, --output <file>` | (bulk) write results here (default: stdout)                         |
| `--format <csv\|jsonl>` | (bulk) output format (default: `csv`)                             |
| `--concurrency <n>`   | (bulk) max validations in flight (default: `10`)                    |
| `--per-domain <n>`    | (bulk) max concurrent probes per MX domain (default: `1`)           |
| `--smtp`              | enable the SMTP probe (default: offline checks only; needs port 25) |
| `-h, --help`          | show usage                                                          |

Exit codes: `0` = ok · `1` = invalid (single) / usage or I/O error · `2` = unexpected error.
Bulk CSV output guards against spreadsheet formula injection and strips control / bidi characters.

### Dual-package distribution

- `@openbounce/core` — the engine, published as both ESM and CommonJS.
- `openbounce` — the flagship package that bundles the library re-export and the CLI binary.
- Requires Node.js `>=22`. MIT-licensed.

### The `Result` schema

Every check returns one typed, documented `Result` — `status`, `subStatus`, `reachable`, a
calibrated `confidence` (0–100), optional `didYouMean` and `provider`, `free` / `role` /
`disposable` flags, MX records, an `smtp` info block, and a per-stage `checks` trace that explains
how the verdict was reached. Only codes the engine actually emits are declared — no aspirational
statuses.

## Planned / exploring

None of these are committed and none have dates — they're the directions we find interesting. If one
matters to you, open an issue and say so.

- **More and fresher datasets** — larger, regularly refreshed disposable / free / role lists.
- **Richer provider fingerprinting** — recognizing more providers, with the MX → provider mapping
  maintained as data so it's easy to extend.
- **Sharper confidence calibration** — continuing to tune the 0–100 score so it reflects real
  per-provider reliability, and exploring a public-signals-only deliverability hint (built from
  MX / DNS / provider behavior, clearly labeled, never from collected user data).
- **Engine refinements** already scoped:
  - **IDN / punycode** — full internationalized-domain normalization before DNS (today an `xn--`
    domain is rejected as invalid syntax).
  - **Role sub-addressing** — detecting role accounts through `+tag` / plus-addressing.
  - **Typo precision** — tightening the did-you-mean guard so real look-alike domains aren't
    "corrected."
- **Bulk ergonomics** — a resumable checkpoint for long runs and a per-domain catch-all / mailbox
  cache.
- **A process-wide SMTP concurrency guard** — a shared cap on concurrent probes (and per-MX
  serialization) across all `validate` / `validateMany` calls, so even code that enables SMTP on a hot
  path can't accidentally open thousands of connections or get its IP blocklisted — it just runs slower.
- **A self-hostable HTTP service** — a small REST wrapper around the engine that *you* run, for
  teams that want verification behind an internal endpoint.
- **Additional language bindings** — TypeScript is the first binding; someday there could be others
  (Go / Rust / Java), with the `Result` taxonomy and a shared known-answers set acting as a
  cross-language conformance spec so every binding behaves identically.

## A note on priorities

openbounce is a volunteer, spare-time project, so priorities can and will shift, and nothing here is
a commitment or a schedule. The best way to influence what gets built next is to
[open an issue](https://github.com/openbounce/openbounce/issues) to discuss an idea, report a bug,
or tell us a check got something wrong. Contributions are welcome — see
[`CONTRIBUTING.md`](../CONTRIBUTING.md).
