# openbounce

**Open-source, local-first email verification — library + CLI.** The honest, embeddable verifier you run
yourself: syntax, MX/DNS, catch-all, disposable/role/free, typo suggestions, and an optional SMTP mailbox
probe. Runs on infrastructure you control, stores nothing, no paid API.
[Full docs →](https://github.com/openbounce/openbounce)

> **Status: early (v0).** Feature-complete (offline checks + SMTP probe + streaming bulk CLI); honest
> `unknown` where a mailbox is genuinely unverifiable (Gmail/Yahoo/M365, catch-all, no port 25).

## Install

```sh
npm install openbounce        # library API + the `openbounce` CLI
npx openbounce user@x.com     # …or run the CLI without installing
```

For the lean engine only (no CLI), use [`@openbounce/core`](https://www.npmjs.com/package/@openbounce/core).

## Library

```ts
import { validate } from 'openbounce';

const r = await validate('name@company.com');
// { email, status, subStatus, reachable, confidence, provider?, free, role, disposable, mx?, checks[], ... }
```

## CLI

```sh
openbounce user@example.com                 # human-readable
openbounce user@example.com --json          # machine-readable (exit 1 if invalid)
openbounce --input list.csv --output clean.csv          # bulk, offline by default
openbounce --input list.csv --format jsonl              # JSONL to stdout
openbounce --input list.csv --smtp                      # also run the SMTP probe (needs port 25)
```

## License

MIT © Sharvil Kadam
