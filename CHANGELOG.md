# Changelog

All notable changes to openbounce are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While pre-1.0 (`0.x`), a breaking change
bumps the **minor** and a fix bumps the **patch**.

## [Unreleased]

_Initial public release (`v0.1.0`), pending publish to npm._

### Added

- **`@openbounce/core`** — the verification engine: syntax validation, MX/DNS resolution with mailbox
  provider fingerprinting, an optional good-citizen SMTP mailbox probe, catch-all detection, and
  disposable / role / free classification plus did-you-mean typo suggestions.
- **Calibrated confidence** — a 0–100 score with a per-check trace, and an honest `unknown` wherever a
  mailbox is genuinely unverifiable (Gmail / Yahoo / Microsoft 365, catch-all domains, or no outbound
  port 25). Accept-all-prone providers resolve to `provider_unverifiable` **without** an SMTP probe —
  faster, and a good citizen (no pointless, serialized probes at Gmail/M365/Yahoo on a bulk list).
- **Streaming bulk verification** — `validateMany` runs a bounded worker pool with per-domain
  serialization and per-domain DNS caching, yielding results as an async stream.
- **`openbounce` CLI** — offline-by-default single and bulk modes, CSV / JSONL input and output, and an
  optional `--smtp` probe.
- **Safe by default** — SMTP is off by default in the **library** too (not just the CLI): `validate(email)`
  does no third-party network I/O unless you opt in with `smtp: 'auto'` / `true`, so it's safe to call on
  a request hot path. Probing is seconds per domain and network-bound — meant for batch/background work.
- **Packaging** — flagship `openbounce` (CLI + a library re-export of the engine) alongside the
  `@openbounce/core` engine package, shipped as dual ESM + CJS.
