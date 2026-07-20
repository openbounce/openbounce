# openbounce — benchmarks

Reproducible accuracy + performance benchmarks. Run after a build:

```sh
pnpm build && pnpm bench        # both; or bench:accuracy / bench:perf
```

Each run prints a report and writes `bench/results/*.md` (gitignored — regenerate anytime; the current
snapshot is below).

## What these measure (and what they don't)

- **`accuracy.mjs`** runs the engine over a **ground-truth-labeled corpus** (`corpus.jsonl`, labeled
  independently of the engine) with a fake DNS resolver, **offline** (no port 25). It reports per-category
  correctness and two **safety invariants**. It measures **engine correctness against a labeled set** —
  **not** a real-world deliverability accuracy %. A real-world number needs outbound port 25 + a real
  labeled list, which is a post-launch activity.
- **`perf.mjs`** measures **engine** overhead with a fake instant DNS resolver — offline `validate()`
  latency, bulk throughput, and heap growth over a large stream. Real-world bulk throughput is
  network-bound and **deliberately** rate-limited per domain; these numbers isolate the engine, not
  end-to-end speed.

**Honesty rule:** `unknown` is the *correct* answer on the big-provider segment (Gmail/Yahoo/M365/
catch-all), so it is scored as correct there and never as a win or a loss elsewhere. A benchmark that
penalizes honesty is measuring the wrong thing.

## Current snapshot

_2026-07-14 · Node v24.14.1 · darwin arm64 · Apple M3 Pro · 48 labeled cases._

**Accuracy — 47/48 correct (97.9%).** The two safety invariants are **hard gates** (a violation exits
non-zero) and are exercised through a fake SMTP prober — so they actually test the honesty path, not a
vacuous offline default:

| Invariant | Result |
| --- | --- |
| False `valid` on the unknowable segment (Gmail/Outlook/catch-all, keyed on the engine's result) | **0 ✅** |
| False `invalid` (rejecting a deliverable address) | **0 ✅** |

The honesty-critical cases include a real `valid` (custom domain, SMTP `250`, random address rejected), a
`mailbox_not_found` (SMTP `550`), a `catch_all` (accepts everything), a `greylisted` (4xx), and — the
key one — a Gmail/Outlook SMTP `250` that must resolve to `unknown`/`provider_unverifiable`, **never**
`valid`. Null-MX and DNS-error paths are covered too. Per-category: all 100% except `not-typo` 1/2 (the
disclosed `grail.com` miss below).

**Performance (engine-isolated):**

| Metric | Result |
| --- | --- |
| Offline `validate()` latency (p50 / p95 / p99) | ~0.002 / 0.004 / 0.08 ms |
| Bulk throughput (50k unique domains, concurrency 20) | ~52,000 emails/sec |
| Retained heap after 50k- and 200k-row streams (500 domains) | ~0 MB, **flat** ⇒ O(1), not O(n) |

_Memory (honest):_ retained heap is measured post-GC and stays flat as the stream grows — input/output
never materializes (streaming buffer ~2×concurrency). Separately, the per-domain **DNS cache grows with
distinct domains** (a logged Phase-4 follow-up); this test reuses 500 domains, so it isolates the buffer.
`cache: false` bounds it on a high-cardinality list.

## Known limitation (disclosed, not hidden)

- **Typo precision.** The one miss (`user@grail.com` → suggested `user@gmail.com`) is a false
  did-you-mean correction: `grail.com` is a real-but-rare domain 1 edit from `gmail.com`. The suggestion
  is **advisory** — it never changes the verdict (status stays `unknown`) — but it's a genuine
  precision gap. Typo suggestions optimize recall; a small false-positive rate on real look-alike domains
  is inherent, and tightening the guard is roadmapped (see the [roadmap](../docs/ROADMAP.md)). We report
  it rather than trim the corpus to a clean 100% — hiding it would be the "denominator trick" we
  criticize incumbents for.
