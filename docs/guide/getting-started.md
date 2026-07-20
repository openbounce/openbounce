# Getting started

openbounce is an honest, local-first email verifier — a library and a CLI. It runs the whole
pipeline (syntax, typo / did-you-mean, disposable / role / free, MX/DNS, catch-all detection, and an
optional SMTP mailbox probe) on infrastructure you control. It stores nothing and needs no API key.

Its defining trait is honesty: where a mailbox is genuinely unverifiable — an accept-all-prone
provider (Gmail / Yahoo / Microsoft 365), a catch-all domain, or an environment with no outbound port
25 — it returns an honest `unknown` rather than a guessed `valid`.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Library quickstart](#library-quickstart)
  - [Validate one address](#validate-one-address)
  - [Validate many addresses](#validate-many-addresses)
  - [Key options](#key-options)
- [CLI quickstart](#cli-quickstart)
  - [A single address](#a-single-address)
  - [Bulk validation](#bulk-validation)
  - [CLI flags](#cli-flags)
  - [Exit codes](#exit-codes)
- [The `Result`](#the-result)
- [About the SMTP probe](#about-the-smtp-probe)

## Requirements

- **Node.js ≥ 22**
- The packages are **ESM-only** (`"type": "module"`). Use `import`, or `require()` on Node ≥ 22 via
  the CommonJS interop entry.

## Install

There are two packages. Pick based on whether you want the command-line tool.

```sh
npm install openbounce        # the flagship: the library API + the `openbounce` CLI
npx openbounce user@x.com     # …or run the CLI once without installing

npm install @openbounce/core  # the lean engine only (no CLI), for embedding in your own app
```

| Package            | What you get                                        | Install when…                             |
| ------------------ | --------------------------------------------------- | ----------------------------------------- |
| `openbounce`       | The library API (re-exports the engine) **+** CLI   | You want the `openbounce` command, or both |
| `@openbounce/core` | The lean, zero-dependency validation engine, no CLI | You only embed the API in your own code   |

The library API is identical in both — `openbounce` re-exports `@openbounce/core`. Everything in the
[Library quickstart](#library-quickstart) works with either import specifier.

## Library quickstart

### Validate one address

```ts
import { validate } from 'openbounce'; // or '@openbounce/core'

const r = await validate('name@company.com');

console.log(r.status); // 'valid' | 'invalid' | 'catch_all' | 'role' | 'disposable' | 'unknown'
console.log(r.reachable); // 'safe' | 'risky' | 'invalid' | 'unknown'
console.log(r.confidence); // 0–100

if (r.status === 'invalid') {
  // r.subStatus tells you why: 'invalid_syntax' | 'no_mx' | 'mailbox_not_found' | …
  console.error(`rejected: ${r.subStatus}`);
}
```

`validate(email, options?)` returns a `Promise<Result>`. It never throws on a network failure — a DNS
or SMTP error degrades to an honest `unknown` result. See [The `Result`](#the-result) for every field.

### Validate many addresses

`validateMany` is a streaming worker pool. Results are yielded **as they complete** — not in input
order — so key each one by its `email` field. It is memory-bounded (the source is pulled lazily), so a
huge or streaming input never fully materializes.

```ts
import { validateMany } from 'openbounce';

const emails = ['a@example.com', 'b@gmail.com', 'c@company.com'];

for await (const result of validateMany(emails, { concurrency: 10, perDomainConcurrency: 1 })) {
  // completion order ≠ input order — always key by result.email
  save(result.email, result.status, result.confidence);
}
```

The input may be a plain `Iterable<string>` or an `AsyncIterable<string>` (e.g. a file stream). Across a
batch, DNS is looked up once per domain, and probes to any single MX domain are serialized by default —
so a bulk run overlaps across domains without hammering any one mail server. A per-row failure degrades
to a typed `unknown` and never aborts the batch.

### Key options

Both `validate` and `validateMany` accept these (`validateMany` adds the batch-only options below).

| Option          | Type                  | Default          | Notes                                                     |
| --------------- | --------------------- | ---------------- | --------------------------------------------------------- |
| `smtp`          | `boolean \| 'auto'`   | `false`          | Off by default (offline). `'auto'` / `true`: probe over SMTP only if a port-25 preflight succeeds. |
| `checkCatchAll` | `boolean`             | —                | Run the catch-all detection probe.                        |
| `timeoutMs`     | `number`              | —                | Per-lookup DNS/SMTP timeout.                              |
| `heloHost`      | `string`              | system hostname  | EHLO/HELO FQDN — set to a host whose rDNS matches your sending IP for good deliverability. |
| `fromAddress`   | `string`              | `''` (null sender `<>`) | MAIL FROM used by the probe.                       |

Batch-only options for `validateMany` (`BatchOptions`):

| Option                 | Type      | Default | Notes                                                    |
| ---------------------- | --------- | ------- | -------------------------------------------------------- |
| `concurrency`          | `number`  | `10`    | Max validations in flight globally.                      |
| `perDomainConcurrency` | `number`  | `1`     | Max concurrent probes to one MX domain (good-citizen).   |
| `cache`                | `boolean` | `true`  | Cache DNS lookups per domain across the batch.           |

```ts
// Force the SMTP probe on (still gated by a port-25 preflight):
const r = await validate('name@company.com', { smtp: true });

// Explicitly offline — never probe, even if port 25 is open:
const offline = await validate('name@company.com', { smtp: false });
```

> **Both the library and the CLI are offline by default** — a bare `validate(email)` does no network
> probing. Enable it with `smtp: 'auto'` (or `true`) in the library, or `--smtp` on the CLI.

The engine also exports a few syntax helpers: `isValidSyntax`, `normalizeEmail`, and `parseEmail`.

## CLI quickstart

### A single address

The CLI is **offline by default** — a single `openbounce <email>` runs the offline checks (syntax, typo,
disposable / role / free, MX/DNS) and will not fire a live SMTP probe even if port 25 is open.

```sh
openbounce user@example.com          # human-readable summary
openbounce user@example.com --json   # full Result as JSON

openbounce user@example.com --smtp   # also run the SMTP mailbox probe (needs outbound port 25)
```

### Bulk validation

Pass `--input` to bulk-validate a list. The input is one address per line, or the first column of a CSV.
Results stream out as CSV (default) or JSONL. Bulk mode is also offline unless you add `--smtp`.

```sh
openbounce --input list.csv --output clean.csv          # CSV to a file
openbounce --input list.csv --format jsonl              # JSONL to stdout
openbounce --input list.csv --smtp                      # also run the SMTP probe (needs port 25)
openbounce --input list.csv --concurrency 20 --per-domain 1   # tune throughput / good-citizen limits
```

The CSV output has this header:

```
email,status,subStatus,reachable,confidence,provider,free,role,disposable,didYouMean
```

JSONL output emits one full `Result` object per line.

### CLI flags

| Flag                    | Mode   | Default        | Description                                             |
| ----------------------- | ------ | -------------- | ------------------------------------------------------- |
| `--json`                | single | off            | Print the full result as JSON.                          |
| `-i`, `--input <file>`  | bulk   | —              | Read addresses from a file.                             |
| `-o`, `--output <file>` | bulk   | stdout         | Write results here.                                     |
| `--format <csv\|jsonl>` | bulk   | `csv`          | Output format.                                          |
| `--concurrency <n>`     | bulk   | `10`           | Max validations in flight.                              |
| `--per-domain <n>`      | bulk   | `1`            | Max concurrent probes per MX domain.                    |
| `--smtp`                | both   | off (offline)  | Enable the SMTP mailbox probe (needs outbound port 25). |
| `-h`, `--help`          | —      | —              | Show usage.                                             |

### Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | OK.                                                            |
| `1`  | A usage error (bad flag, no address) or I/O error — and, in single mode, when the address is `invalid`. |
| `2`  | An unexpected error.                                           |

## The `Result`

Every validation returns a `Result`. The headline is `status`; `reachable` answers "should I send?";
`confidence` (0–100) is how sure the engine is of that `status`; `subStatus` is the machine-readable
reason.

| Field                          | Type                          | Meaning                                                                 |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `email`                        | `string`                      | Normalized address (domain lowercased, whitespace trimmed).             |
| `status`                       | `Status`                      | `valid` \| `invalid` \| `catch_all` \| `role` \| `disposable` \| `unknown`. |
| `reachable`                    | `Reachability`                | `safe` \| `risky` \| `invalid` \| `unknown` — the send/no-send summary. |
| `confidence`                   | `number`                      | 0–100, calibrated by which checks fired and per-provider reliability.   |
| `subStatus`                    | `SubStatus`                   | Machine-readable reason, e.g. `ok`, `invalid_syntax`, `no_mx`, `mailbox_not_found`, `catch_all`, `provider_unverifiable`. |
| `provider`                     | `Provider?`                   | Mailbox provider from the MX fingerprint (`google`, `microsoft`, …, `custom`); present once MX is known. |
| `free` / `role` / `disposable` | `boolean`                     | Free-provider, role account (`info@`, `sales@`…), or throwaway domain.  |
| `catchAll`                     | `boolean?`                    | Present only when a catch-all probe ran.                                |
| `didYouMean`                   | `string?`                     | Suggested correction for a likely typo.                                 |
| `mx`                           | `readonly MxRecord[]?`        | MX records found (`host`, `priority`).                                  |
| `smtp`                         | `SmtpInfo`                    | `{ attempted, available, code?, message? }` — whether the probe ran and whether port 25 was usable. |
| `checks`                       | `readonly CheckResult[]`      | Per-stage trace (`name`, `outcome`, `detail?`) — explains any verdict.  |
| `durationMs`                   | `number`                      | Wall-clock time for the validation.                                     |

## About the SMTP probe

The SMTP mailbox probe is **optional and off by default in the CLI** (it is `'auto'` in the library API).
It needs an environment with **outbound port 25** open — most cloud providers and home ISPs block it. The
probe is gated by a port-25 preflight, so where port 25 is unavailable the SMTP-dependent stages are
skipped and reported honestly rather than guessed.

Even when the probe runs, a `250 OK` from an accept-all-prone provider (Gmail / Yahoo / default
Microsoft 365) or a catch-all domain is never promoted to a confident `valid` — it degrades to `unknown`
(with `subStatus: provider_unverifiable`) or `risky`. That is the point of openbounce: it tells you what
it actually knows.
