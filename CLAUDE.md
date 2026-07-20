# CLAUDE.md — openbounce

Open-source, local-first email verifier (library + CLI) — the self-hostable alternative to ZeroBounce.
**Phases 1–4 shipped — engine + CLI feature-complete; Phase 5 (publish v0.1) is next.** User-facing docs
live in `docs/guide/` and the public roadmap in `docs/ROADMAP.md`; detailed design & decision records are
kept in `docs/internal/` (out of the public repo). **Project state is the roadmap.**

Personal project (not affiliated with any employer). Committed under the maintainer's personal git
identity; license is **MIT**.

## Principles

Build by these (a personal engineering baseline — SOLID, DRY/KISS/YAGNI, typed, tested, deterministic,
boy-scout — applied to this project):

- **SOLID** — one responsibility per module; extend via new resolver/data impls, not edits; substitutable
  implementations behind small interfaces; depend on abstractions (inject `DnsResolver`/`SmtpProber`/`Clock`/`Rng`).
- **DRY / KISS / YAGNI** — one source of truth; derive state, don't duplicate; the simplest thing that
  works; no hypothetical-future machinery.
- **Fail fast, typed errors** — validate at boundaries; typed errors or `Result` values, never strings.
  Network failures **degrade to `unknown`**, they don't throw (a batch must never abort on one bad row).
- **Security & privacy by default** — treat all remote SMTP/DNS responses as untrusted input; never log
  full addresses/PII; process locally, persist nothing.
- **Determinism** — inject `Clock`/`Rng`; keep a **pure core** (no I/O, time, randomness), lint-enforced.
- **Readable over clever; boy-scout rule** — delete dead code/assets.

## Conventions

- **Tests** under `tests/` mirroring `src/` (not co-located); no untested code; deterministic (fake
  resolvers, injected clock); import via the `@/` alias.
- **Branching** off `main` (`feature/`/`fix/`/`chore/`); **squash-merge**; delete the branch (remote +
  local) after merge; code PRs wait for approval; docs-only may go straight to `main`. Never
  `--no-verify`; never `Co-Authored-By`.
- **Docs** — user-facing in `docs/guide/`, public roadmap `docs/ROADMAP.md`; numbered design/decision
  records live in `docs/internal/` (private — out of the public repo); every doc has a TOC; **keep the
  roadmap current after every meaningful change.**
- **Releasing** — see the Releasing section of `CONTRIBUTING.md`: both packages ship in lockstep at one
  version; gate green → bump → `pnpm -r publish --dry-run` → `pnpm run release` (OTP) → verify → tag.
- **Strict typing**; discriminated unions over class hierarchies; `readonly` state; pluggable seams
  behind explicit interfaces, each with a conformance suite.
- **Dual TypeScript** — the primary `typescript` is pinned to the newest release `typescript-eslint`
  supports (**TS 6.x**); it drives lint, typecheck, and the `.d.ts` build. **TS 7** rides along as the
  `typescript-next` alias and runs as a `tsc --noEmit` forward-compat gate in `pnpm typecheck`/CI.
  **TODO — when `typescript-eslint` supports TS 7 (check the `@typescript-eslint/parser` peer range),
  drop the dual:** move `typescript` to 7, remove the `typescript-next` alias and the
  `ignoreDeprecations` build-tsconfig hatch. See ADR-012.

## Project-specific rules (what differs / must-honor)

1. **Pure-core network seam.** `packages/core/src/core/**` and `.../data/**` must not import
   `node:dns`/`net`/`dgram`/`tls`/`http(s)`/`fs`/`crypto`/`timers`, and must not use `Date`, `Math.random`,
   timers, `process`, or `fetch` (ESLint-enforced). Network via injected `DnsResolver`/`SmtpProber`;
   time/randomness via injected `Clock`/`Rng`. Real adapters live in `src/resolvers/` (I/O allowed);
   `src/index.ts` is the composition root that wires defaults.
2. **Honesty invariant.** Never emit a confident `valid` where the provider makes it unknowable. Big
   consumer providers (`google`/`microsoft`/`yahoo`) and catch-all domains resolve to `risky`/`unknown`,
   not `valid`. Confidence must be calibrated, not aspirational.
3. **Good-citizen SMTP.** `MAIL FROM:<>` (null sender); **never send `DATA`**; per-step timeouts;
   `4xx` → greylist retry/backoff; catch-all via a random-address probe; per-domain serialization + low
   concurrency by default (don't get the user's IP onto Spamhaus PBL).
4. **Local-first.** SMTP is optional; always preflight port 25 and degrade — never hard-require it.
5. **Out of scope:** spam-trap/abuse detection (needs proprietary data — ADR-006); sending mail.

## Commands

CI runs exactly these (pnpm) and all must pass:

- `pnpm lint` · `pnpm format:check` · `pnpm typecheck` · `pnpm test` · `pnpm build` · `pnpm smoke`
- `pnpm smoke` — ESM-first package check: loads the built `@openbounce/core` (`import` + `require`) and the flagship `openbounce` (re-export), and runs the `openbounce` CLI bin — catches a broken `exports` map, bin, or build. Runs after `build`.
- `pnpm typecheck` — **dual**: typechecks with the primary **TS 6** toolchain **and** runs a **TS 7** forward-compat pass (`pnpm typecheck:next`, via the `typescript-next` alias). Both must be green. See ADR-012 + the dual-TypeScript convention below.
- (later) `pnpm test:integration` — real SMTP probes, behind a flag; needs outbound port 25.

A fresh clone must pass `install → lint → format:check → typecheck → test → build` with no manual setup.
(One-time on some machines: `pnpm approve-builds --all` to allow esbuild's postinstall.)

## Per-phase / per-task process

1. Branch off `main` (docs-only may go straight to `main`).
2. Build with tests, not after — no untested behavior.
3. Run the full local gate green (`lint`/`format:check`/`typecheck`/`test`/`build`).
4. **Adversarial review gate** after every phase/sub-phase — parallel subagents across the review
   lenses (correctness/logic end-to-end · bug-hunt · security · scale/perf · code-quality · testing ·
   docs-fidelity · anything else). Fix real findings in the same change or log them with a severity.
5. Keep the roadmap current in the same change.
6. Commit + push; open/update the PR. Code PRs wait for approval; squash-merge; delete the branch.
