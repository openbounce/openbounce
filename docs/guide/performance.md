# Performance & accuracy

openbounce ships a reproducible benchmark harness (`bench/`). Run it after a build:

```sh
pnpm build && pnpm bench        # both; or bench:accuracy / bench:perf
```

Every run regenerates `bench/results/*.md`. The numbers below are representative (a 2026 laptop, Apple
M3 Pro) — regenerate them on your own hardware rather than trusting these verbatim.

## The one thing that matters: offline is instant, SMTP is network-bound

This is the tradeoff to understand before you turn the SMTP probe on. The engine itself is extremely
fast; the SMTP probe is not — because it isn't the engine, it's the network.

| Mode                  | Speed                                          | What it can determine                                                                 |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Offline** (default in the CLI) | **Sub-millisecond per address**, tens of thousands/sec in bulk | Syntax, typo / did-you-mean, disposable / role / free, and whether the domain can receive mail at all (MX / A / AAAA). |
| **+ SMTP probe**      | **Seconds per _domain_** — a live network round-trip, serialized per domain, bounded by the timeout | Everything above **plus** whether a specific mailbox exists on a **custom / corporate** domain, and catch-all detection. |

Enabling SMTP does not make openbounce slow — it makes it do real network I/O. Each probe opens a TCP
connection on port 25, runs an `EHLO → MAIL FROM → RCPT TO` dialog, waits for the server, and may retry
once on a greylist (`4xx`). That's typically **1–5 seconds per domain**, up to the per-lookup timeout
(default **8 s**), and probes to the same MX are **serialized** (good-citizen), so throughput with SMTP
on is dominated by the remote servers and your network — not by openbounce.

**And crucially, the extra time only buys accuracy on _some_ addresses.** openbounce doesn't even probe
Gmail / Yahoo / Microsoft 365 — a `250` from them confirms nothing, so they resolve to an honest
`unknown` at offline speed (no wasted round-trip). SMTP adds real signal only for domains that run a mail
server giving **honest rejections** — self-hosted, Exchange on-prem, Zoho, Proton, and the like. Note
this also means a business domain **hosted on Google Workspace or Microsoft 365** is `unknown` too: it
shares Google's/Microsoft's accept-all MX, and the fingerprint can't tell it apart from consumer Gmail.

### What that means for the defaults

- **Both the CLI and the library are offline by default.** A bare `validate(email)` — or
  `openbounce <email>` — does no third-party network I/O, so it is safe to drop into a request handler and
  won't get your IP blocklisted. That is the least-astonishing default for a library.
- **Enable the probe explicitly:** `smtp: 'auto'` (or `true`) in the library, `--smtp` on the CLI. `'auto'`
  probes only when a port-25 preflight succeeds and degrades to `unknown` otherwise. Reserve it for
  batch / background work — not a request hot path (see the tradeoff above).

## Engine performance (isolated)

These isolate the engine with a fake, instant DNS resolver — they measure openbounce's own overhead,
**not** end-to-end speed (which, with SMTP on, is network-bound as described above).

| Metric                                                    | Result             |
| --------------------------------------------------------- | ------------------ |
| Offline `validate()` latency (p50 / p95 / p99)            | ~0.002 / 0.004 / 0.08 ms |
| Bulk throughput (50k unique domains, `concurrency: 20`)   | ~50–65k addresses/sec |
| Retained heap over a 50k- then 200k-row stream (500 domains) | ~0 MB, **flat** ⇒ O(1), not O(n) |

Bulk is a **streaming** worker pool: results are yielded as they complete and the input/output never
fully materializes, so memory stays flat as the stream grows (buffer ≈ 2 × concurrency). One caveat: the
per-domain DNS cache grows with the number of _distinct_ domains in a batch — pass `cache: false` to
bound it on a very high-cardinality list.

## Accuracy

Measured against a ground-truth-labeled corpus (`bench/corpus.jsonl`, labeled independently of the
engine). **This is engine correctness on a labeled set — not a real-world deliverability percentage**
(that needs outbound port 25 and a real labeled list, which is a post-launch activity).

**47 / 48 correct (97.9%).** The two honesty guarantees are hard gates (a violation fails the run):

| Invariant                                                        | Result |
| ---------------------------------------------------------------- | ------ |
| False `valid` on the unknowable segment (Gmail / Outlook / catch-all) | **0 ✅** |
| False `invalid` (rejecting a deliverable address)                | **0 ✅** |

`unknown` is scored as the **correct** answer on the big-provider segment — a benchmark that rewarded a
confident guess there would be measuring the wrong thing. The single miss is a disclosed typo-suggestion
false positive (`grail.com` → suggests `gmail.com`); it's advisory only and never changes the verdict.
See `bench/README.md` for the full per-category breakdown and the disclosed limitation.
