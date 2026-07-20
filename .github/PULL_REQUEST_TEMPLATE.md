<!-- Thanks for contributing! Keep changes focused; see CONTRIBUTING.md. -->

**What & why**
What does this change and why?

**How tested**
The new/updated tests, and confirmation the full gate passes locally
(`lint · format:check · typecheck · test · build · smoke`).

**Checklist**

- [ ] Branched off `main`; conventional-commit title (`feat:`/`fix:`/`chore:`/`docs:`).
- [ ] Tests ship with the change (under `tests/` mirroring `src/`, deterministic — no real network/clock/random).
- [ ] Full gate green locally.
- [ ] Honesty invariant respected — no confident `valid` where a mailbox is genuinely unknowable.
- [ ] If touching the pure core, no new I/O/time/randomness imports (the architectural lint stays green).
- [ ] Docs/roadmap updated if behavior changed.
