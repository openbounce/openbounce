# @openbounce/core

The [openbounce](https://github.com/openbounce/openbounce) email-verification engine — syntax, MX/DNS,
SMTP mailbox probing, catch-all detection, disposable / role / free classification, and did-you-mean
typo suggestions. Local-first, no paid API.

> **Status: early (v0).** API + result schema are stable; feature-complete — offline checks, an
> optional SMTP mailbox probe, catch-all detection, and streaming bulk are all implemented. Honest
> `unknown` where a mailbox is genuinely unverifiable (Gmail/Yahoo/M365, catch-all, no port 25).

```ts
import { validate } from '@openbounce/core';

const result = await validate('user@example.com');
// { email, status, subStatus, reachable, confidence, free, role, disposable, checks, ... }
```

Pure validation logic is decoupled from the network via injected `DnsResolver` / `SmtpProber` seams, so
it's deterministically testable and portable. See
[how it works](https://github.com/openbounce/openbounce/blob/main/docs/guide/how-it-works.md).

## License

MIT © Sharvil Kadam
