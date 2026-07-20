// Accuracy benchmark — runs the BUILT engine over a ground-truth-labeled corpus (bench/corpus.jsonl)
// and reports per-category correctness plus the two SAFETY INVARIANTS that define "honest": never a
// confident `valid` where the mailbox is unknowable (accept-all-prone provider or catch-all domain),
// and never a false `invalid` on a deliverable address. `unknown` is counted as `unknown` — the correct
// answer on the big-provider segment — never as a win or a loss (see docs/guide/performance.md). Run after `pnpm build`.
//
// Offline cases use a fake DNS resolver; honesty-critical cases additionally use a fake SMTP prober
// (`smtp` field) so the invariants actually exercise the SMTP verdict path — a Gmail `250` MUST stay
// `unknown`, a catch-all MUST NOT become `valid`. This measures ENGINE CORRECTNESS against a labeled
// set, NOT real-world deliverability accuracy (that needs port 25 + a real labeled list — see docs/guide/performance.md).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { validate } from '@openbounce/core';

const UNRELIABLE = new Set(['google', 'microsoft', 'yahoo']);

const corpusUrl = new URL('./corpus.jsonl', import.meta.url);
const rows = readFileSync(corpusUrl, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l.length > 0)
  .map((l, i) => {
    try {
      return JSON.parse(l);
    } catch (err) {
      throw new Error(`corpus.jsonl line ${i + 1}: ${err.message}`);
    }
  });

/** A fake DnsResolver driven by an entry's `dns` field, mirroring the real resolver's contract. */
function fakeDns(entry) {
  const d = entry.dns ?? {};
  return {
    resolveMx: () => {
      if (d.error) return Promise.reject(new Error('SERVFAIL')); // transient DNS failure → dns_error
      if (d.nullMx) return Promise.resolve([{ host: '', priority: 0 }]); // RFC 7505 null MX
      if (d.noMx) return Promise.resolve([]);
      return Promise.resolve((d.mx ?? []).map((host, i) => ({ host, priority: (i + 1) * 10 })));
    },
    resolve: (_domain, type) => {
      if (d.error) return Promise.reject(new Error('SERVFAIL'));
      return Promise.resolve(type === 'A' ? (d.a ?? []) : type === 'AAAA' ? (d.aaaa ?? []) : []);
    },
  };
}

/** A fake SmtpProber for honesty-critical cases. Distinguishes the real mailbox probe from the pipeline's
 *  random catch-all probe by local-part, so `accept` proves "not catch-all" while `catchall` accepts all. */
function fakeProber(entry) {
  const scenario = entry.smtp.scenario;
  const realLocal = entry.email.split('@')[0].toLowerCase();
  const reply = (code, accepted, outcome) => Promise.resolve({ code, accepted, outcome });
  return {
    preflight: () => Promise.resolve(true),
    probe: ({ email }) => {
      const isReal = email.split('@')[0].toLowerCase() === realLocal;
      switch (scenario) {
        case 'accept':
          return isReal ? reply(250, true, 'accepted') : reply(550, false, 'rejected');
        case 'reject':
          return reply(550, false, 'rejected');
        case 'greylist':
          return reply(451, false, 'greylisted');
        case 'catchall':
          return reply(250, true, 'accepted');
        default:
          return reply(0, false, 'inconclusive');
      }
    },
  };
}

/** Engine options for an entry: offline unless it carries an `smtp` scenario. */
function optionsFor(entry) {
  if (!entry.smtp) return { dns: fakeDns(entry), smtp: false };
  return {
    dns: fakeDns(entry),
    smtp: 'auto',
    prober: fakeProber(entry),
    clock: { now: () => 0, sleep: () => Promise.resolve() }, // instant greylist retries
    rng: { next: () => 0.5 }, // deterministic catch-all probe address
  };
}

/** True iff every field asserted in `expect` matches (`null` = the field must be absent). */
function matches(expect, result) {
  for (const [key, want] of Object.entries(expect)) {
    const got = result[key];
    if (want === null) {
      if (got !== undefined && got !== null) return false;
    } else if (typeof want === 'object') {
      if (JSON.stringify(got) !== JSON.stringify(want)) return false;
    } else if (got !== want) {
      return false;
    }
  }
  return true;
}

const byCategory = new Map();
const misses = [];
let correct = 0;
let falseValidOnUnknowable = 0;
let falseInvalid = 0;

for (const entry of rows) {
  const result = await validate(entry.email, optionsFor(entry));
  const ok = matches(entry.expect, result);

  const cat = byCategory.get(entry.category) ?? { total: 0, correct: 0 };
  cat.total += 1;
  if (ok) cat.correct += 1;
  byCategory.set(entry.category, cat);

  if (ok) correct += 1;
  else
    misses.push({
      email: entry.email,
      category: entry.category,
      expect: entry.expect,
      got: result,
    });

  // Invariant 1 — keyed on the ENGINE'S RESULT, not the corpus label: a confident `valid` is a
  // violation whenever the provider is accept-all-prone (Gmail/M365/Yahoo) or the domain is catch-all.
  if (result.status === 'valid' && (UNRELIABLE.has(result.provider) || result.catchAll === true)) {
    falseValidOnUnknowable += 1;
  }
  // Invariant 2 — the ground truth (expect.status) is not `invalid`, but the engine rejected it.
  if (result.status === 'invalid' && entry.expect.status && entry.expect.status !== 'invalid') {
    falseInvalid += 1;
  }
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`);
const stamp = new Date().toISOString().slice(0, 10);
const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
const machine = `Node ${process.version} · ${os.platform()} ${os.arch()} · ${cpu}`;

const lines = [];
lines.push('# openbounce — accuracy benchmark (engine correctness)', '');
lines.push(`_Generated ${stamp} · ${machine} · ${rows.length} labeled cases._`, '');
lines.push(
  'Measures the engine against a **ground-truth-labeled corpus** (`bench/corpus.jsonl`). `unknown` is the',
  'correct answer on the big-provider segment and is scored as such — not a win, not a loss. This is **not**',
  'a real-world deliverability accuracy figure (that needs port 25 + a real labeled list; see docs/guide/performance.md).',
  '',
);
lines.push(`**Overall: ${correct}/${rows.length} correct (${pct(correct, rows.length)}).**`, '');
lines.push('## Safety invariants (the honesty guarantees, exercised via a fake SMTP prober)', '');
lines.push('| Invariant | Count | Status |', '| --- | --- | --- |');
lines.push(
  `| False \`valid\` on unknowable (Gmail/Outlook/catch-all, keyed on the result) | ${falseValidOnUnknowable} | ${falseValidOnUnknowable === 0 ? '✅ pass' : '❌ FAIL'} |`,
);
lines.push(
  `| False \`invalid\` (rejecting a deliverable address) | ${falseInvalid} | ${falseInvalid === 0 ? '✅ pass' : '❌ FAIL'} |`,
);
lines.push('');
lines.push('## Per-category correctness', '');
lines.push('| Category | Correct | Total | % |', '| --- | --- | --- | --- |');
for (const [cat, { correct: c, total }] of [...byCategory.entries()].sort()) {
  lines.push(`| ${cat} | ${c} | ${total} | ${pct(c, total)} |`);
}
lines.push('');
if (misses.length > 0) {
  lines.push(
    '## Misses (reported honestly — recall on lists/typos is bounded by data freshness)',
    '',
  );
  for (const m of misses) {
    lines.push(
      `- \`${m.email}\` (${m.category}) — expected \`${JSON.stringify(m.expect)}\`, got ` +
        `\`{status:"${m.got.status}",subStatus:"${m.got.subStatus}",didYouMean:${JSON.stringify(m.got.didYouMean ?? null)}}\``,
    );
  }
  lines.push('');
}

const report = lines.join('\n');
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/accuracy.md', import.meta.url), report);

console.log(report);
console.log(
  `\naccuracy ✓  ${correct}/${rows.length} correct · false-valid-on-unknowable=${falseValidOnUnknowable} · false-invalid=${falseInvalid}`,
);

// The two safety invariants are hard gates — a violation must fail loudly.
if (falseValidOnUnknowable > 0 || falseInvalid > 0) {
  console.error('\nSAFETY INVARIANT VIOLATED — see above.');
  process.exit(1);
}
