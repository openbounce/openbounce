# Contributing to openbounce

Thanks for your interest! openbounce is an open-source, local-first email verifier (library + CLI),
MIT-licensed. Contributions — bug reports, fixes, tests, docs, dataset updates — are welcome.

## Getting set up

Requires **Node ≥ 22** and **pnpm**. A fresh clone needs no manual setup beyond install:

```sh
pnpm install
```

(One-time on some machines: `pnpm approve-builds --all` to allow esbuild's postinstall.)

This is a pnpm workspace with two packages:

- **`@openbounce/core`** (`packages/core`) — the verification engine (pure core + injected network/time seams).
- **`openbounce`** (`packages/cli`) — the flagship CLI, which also re-exports the engine as a library.

## The gate

A fresh clone must pass this sequence with no manual setup — and **CI runs exactly the same on every push
and PR. Nothing merges red.**

```sh
pnpm lint          # ESLint, zero warnings (incl. the pure-core architectural lint)
pnpm format:check  # Prettier
pnpm typecheck     # dual: the primary TS toolchain + a TS-next --noEmit forward-compat pass
pnpm test          # Vitest
pnpm build         # tsup (dual ESM + CJS)
pnpm smoke         # loads the built packages by name (import + require) and runs the CLI bin
```

`pnpm smoke` is the last line of defense against a broken `exports` map, `bin`, or build — it imports the
published packages the way a consumer would.

## Making a change

- **Branch off `main`** — `feature/…`, `fix/…`, or `chore/…`.
- **Tests ship with the change** — no untested behavior. Tests live under `tests/` mirroring `src/`, and
  must be **deterministic**: inject fake `DnsResolver`/`SmtpProber` and the `Clock`/`Rng` seams; never rely
  on real network, wall-clock, or randomness.
- **Run the full gate green locally** before opening a PR.
- **Open a PR** with a clear description. Use **conventional-commit** style (`feat:`/`fix:`/`chore:`/`docs:`).
  PRs are **squash-merged**; delete the branch afterward.
- Never use `--no-verify` (it skips the pre-commit gate). Don't add `Co-Authored-By` trailers.

## Conventions that matter

A few project rules are load-bearing — please honor them when touching the engine:

- **Pure core.** `packages/core/src/core/**` and `.../data/**` must not do I/O, time, or randomness (no
  `node:*` network/fs/crypto, no `Date`/`Math.random`/timers/`process`/`fetch`) — this is lint-enforced.
  Network goes through the injected `DnsResolver`/`SmtpProber`; time/randomness through `Clock`/`Rng`. Real
  adapters live in `src/resolvers/`; `src/index.ts` wires the defaults.
- **Honesty invariant.** Never emit a confident `valid` where the mailbox is genuinely unknowable. Big
  consumer providers (Gmail/Microsoft/Yahoo) and catch-all domains resolve to `risky`/`unknown`, not
  `valid`. Confidence is calibrated, never aspirational.
- **Good-citizen SMTP.** Null sender (`MAIL FROM:<>`); never send `DATA`; per-step timeouts; `4xx` →
  greylist retry; catch-all via a random-address probe; per-domain serialization + low concurrency so we
  don't get a user's IP onto a blocklist.
- **Local-first.** SMTP is optional — always preflight port 25 and degrade to offline checks; never
  hard-require it.
- **Out of scope:** spam-trap/abuse detection (needs proprietary data) and sending mail.

## Reporting security issues

Please report suspected vulnerabilities **privately** (see `SECURITY.md`) rather than opening a public
issue.

## Releasing (maintainers only)

The two packages ship **in lockstep** at the same version. `openbounce` depends on `@openbounce/core` via
`workspace:*`, which `pnpm publish` rewrites to the real version at publish time. Versioning is pre-1.0
(`0.x`): a breaking change bumps the **minor**, a fix bumps the **patch**; `1.0` comes once the `Result`
schema and options are stable.

**1. Pre-release gate** — on `main`, synced, clean tree; full gate green locally and in CI; roadmap and
`CHANGELOG.md` updated (move the `## [Unreleased]` entries under a new dated `## [X.Y.Z]`). `pnpm smoke`
must pass.

**2. Version bump** — set the **same** version in both `packages/*/package.json`; leave `openbounce`'s
dependency on `@openbounce/core` as `workspace:*` (do not hand-pin). Commit as `chore(release): vX.Y.Z`
via a normal PR.

**3. Dry run**

```sh
pnpm whoami                     # logged in to the account that owns @openbounce
pnpm -r build && pnpm smoke     # final artifact check on the exact tree you'll publish
pnpm -r publish --dry-run       # preview; verifies workspace:* rewrite + publishConfig.access
```

Confirm each tarball has **only** `dist/`, `README.md`, `LICENSE`, `package.json` — no source/tests/docs —
and that `@openbounce/core` resolves to a real version (not `workspace:*`) in `openbounce`'s dependencies.

**4. Publish** (irreversible, OTP-gated)

```sh
pnpm run release                # = pnpm -r build && pnpm -r publish  (prompts for 2FA/OTP)
```

Publishes topologically: `@openbounce/core` first, then `openbounce`. `publishConfig.access: public` on the
scoped package lets its first publish succeed.

**5. Verify**

```sh
npm view openbounce version && npm view @openbounce/core version
cd "$(mktemp -d)" && npm init -y >/dev/null && npm i openbounce      # clean-room install
node -e "import('openbounce').then(m => console.log(typeof m.validate))"   # -> function
npx openbounce --help
```

**6. Tag & announce** — `git tag vX.Y.Z && git push --tags`; cut a GitHub release with notes. Add npm
version badges only **after** the first publish so they resolve.

## License

By contributing, you agree your contributions are licensed under the project's **MIT** license.
