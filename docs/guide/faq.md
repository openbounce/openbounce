# FAQ

Short, honest answers to the questions people ask most about openbounce. The guiding principle
throughout: when the truth about a mailbox is genuinely unknowable, openbounce says so — it returns
`unknown` rather than a fabricated `valid`.

## Table of contents

- [What is openbounce?](#what-is-openbounce)
- [Why does it sometimes return `unknown` instead of valid or invalid?](#why-does-it-sometimes-return-unknown-instead-of-valid-or-invalid)
- [Why can't you reliably verify Gmail / Outlook / Yahoo mailboxes?](#why-cant-you-reliably-verify-gmail--outlook--yahoo-mailboxes)
- [How is this different from a paid API like ZeroBounce?](#how-is-this-different-from-a-paid-api-like-zerobounce)
- [Is it safe to run against real mail servers?](#is-it-safe-to-run-against-real-mail-servers)
- [Does it store or send email?](#does-it-store-or-send-email)
- [Can I use just the engine without the CLI?](#can-i-use-just-the-engine-without-the-cli)

## What is openbounce?

openbounce is a local-first, MIT-licensed email verifier you run yourself — as a **CLI** (`openbounce`)
or as a **library** (`@openbounce/core`, TypeScript). It runs a pipeline of checks, cheapest and most
certain first:

**syntax → typo / did-you-mean → disposable / role / free → MX / DNS + provider fingerprint →
(optional) SMTP `RCPT TO` mailbox probe → catch-all detection → scoring.**

The offline stages (syntax, typo, disposable / role / free classification, and MX / DNS) need no network
egress beyond DNS, no API key, and no infrastructure. The SMTP mailbox probe is optional and needs
outbound port 25. Every verdict comes back as a `Result` with a `status`, a `reachable` summary, a
calibrated `confidence` (0–100), and a per-signal `checks[]` trace so you can see *why*.

## Why does it sometimes return `unknown` instead of valid or invalid?

Because sometimes the honest answer really is "we don't know," and openbounce refuses to guess. A result
degrades to `unknown` (or `risky`) in cases like:

| Situation                                          | What you get                                  |
| -------------------------------------------------- | --------------------------------------------- |
| Outbound port 25 is blocked, so no SMTP probe ran  | `unknown` / `smtp_unavailable`                |
| A DNS lookup failed transiently                    | `unknown` / `dns_error`                       |
| The domain accepts every address (catch-all)       | `catch_all` / `catch_all` (reachable `risky`) |
| The provider accepts every address (Gmail, etc.)   | `unknown` / `provider_unverifiable`           |
| The mail server greylisted the probe               | `unknown` / `greylisted`                      |

The core honesty invariant, in one line: a `250 OK` from an accept-all-prone provider is **never**
promoted to a confident `valid` — it degrades to `unknown`. openbounce still catches everything that
*is* knowable with high precision: bad syntax, dead domains (no MX / A / AAAA), disposable domains, role
accounts, typos, and mailbox existence on domains that run their own honest-rejection mail server (not
Gmail / Yahoo / Microsoft-hosted, including Workspace / M365) where port 25 is open.

## Why can't you reliably verify Gmail / Outlook / Yahoo mailboxes?

Two hard realities, neither of which any verifier controls:

1. **Big consumer providers accept everything.** Gmail, Yahoo, and default Microsoft 365 / Outlook reply
   `250 OK` to a `RCPT TO` for *every* address, whether the mailbox exists or not — this is deliberate
   anti-harvesting behavior. So the SMTP reply carries no signal about whether the mailbox is real.
2. **Port 25 is usually blocked.** The SMTP probe needs outbound port 25, which most cloud providers and
   home ISPs block. Without it, there is nothing to probe.

This is a real accuracy ceiling, and it applies to **every** tool — no verifier can confirm a specific
Gmail / Yahoo / default-M365 mailbox over SMTP, because the provider simply doesn't tell anyone. If a
service claims otherwise, treat that claim with skepticism: the underlying protocol does not expose the
answer. openbounce fingerprints the provider from its MX records and returns an honest `unknown` for
these addresses rather than a coin-flip dressed up as `valid`.

## How is this different from a paid API like ZeroBounce?

They solve the same problem from opposite directions. The factual differences:

| | openbounce | Hosted verification APIs |
| --- | --- | --- |
| Where it runs | Your machine / your infrastructure | The vendor's servers |
| Your list | Never leaves your box | Uploaded to the vendor |
| Cost model | Free; you supply the network egress | Per-check fee |
| License | Open source (MIT) | Proprietary |
| Network egress | You bring your own | Included |

openbounce is local-first and self-hosted, so your contact list (and your customers' personal data)
stays with you, and there's no per-check charge. In exchange, you supply the environment: DNS resolution
for the offline checks, and an outbound-port-25 path if you want the SMTP probe. Hosted APIs bundle that
egress and run at scale for you, for a fee. Pick whichever trade-off fits.

## Is it safe to run against real mail servers?

The SMTP probe is built to be a good citizen, and it is **off by default** in the CLI (offline checks
only unless you pass `--smtp`). When you do enable it, the prober:

- uses the null sender (`MAIL FROM:<>`), not a fake address;
- **never sends `DATA`** — the dialog stops after `RCPT TO`, so no message is ever transmitted;
- applies per-step timeouts and treats `4xx` as greylisting (retry with backoff, don't hammer);
- serializes probes per MX domain (default `perDomainConcurrency: 1`) and keeps global concurrency low
  (default `10`) so you don't flood a single server.

You can set `heloHost` to a hostname whose reverse DNS matches your sending IP for better reputation.
One caution: on a **shared IP** (many clouds, some office networks), SMTP probing can affect the
reputation of that IP for everyone on it, so be conservative there — or leave SMTP off and rely on the
offline checks. In the library, SMTP is **off by default**; if you enable it with `smtp: 'auto'` it probes
only when a port-25 preflight succeeds.

## Does it store or send email?

No. openbounce processes everything locally and persists nothing — no list is uploaded, no results are
written anywhere except where you explicitly send them (stdout or an `--output` file). And it never
sends mail: the SMTP dialog stops after `RCPT TO` and never issues `DATA`, so no message body is ever
transmitted to anyone.

## Can I use just the engine without the CLI?

Yes. `@openbounce/core` is the lean, zero-dependency engine with no CLI attached — install it to embed
verification directly in your own app:

```ts
import { validate, validateMany } from '@openbounce/core';

const r = await validate('name@company.com');
if (r.status === 'invalid') reject(r.subStatus); // 'invalid_syntax' | 'no_mx' | ...

// Stream-clean a list; results arrive as they complete (not input order — key by result.email):
for await (const result of validateMany(emails, { concurrency: 10 })) {
  save(result);
}
```

The flagship `openbounce` package re-exports the same `validate` / `validateMany` API and adds the CLI
on top, so anything you can do from the library you can also do from the command line.
