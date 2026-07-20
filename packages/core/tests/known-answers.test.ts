// The known-answers oracle (offline subset): a labeled fixture of real-shaped addresses/domains with
// expected verdicts, run through the engine with a seeded fake DNS so it's deterministic in CI. SMTP-dependent rows (catch-all, big-provider mailbox existence)
// are added with Phase 3 and run only in the integration job.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '@/core/pipeline';
import { defaultData } from '@/data';
import type { Result } from '@/types';
import { type DnsFixture, fakeDns, fixedClock, fixedRng, unavailableProber } from './test-utils';

interface Row {
  category: string;
  email: string;
  dns?: { mx?: string[]; noMx?: boolean; error?: boolean; a?: string[] };
  expect: Partial<Record<keyof Result, unknown>>;
  note?: string;
}

// Categories that must always be represented so the oracle can never silently lose a code path.
const REQUIRED_CATEGORIES = [
  'invalid-syntax',
  'invalid-no-mx',
  'disposable',
  'role',
  'free',
  'typo',
  'custom-deliverable',
  'implicit-mx',
];

const fixturePath = fileURLToPath(new URL('./fixtures/known-answers.jsonl', import.meta.url));
const rows: Row[] = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

describe('known-answers oracle (offline)', () => {
  it('covers every required offline category', () => {
    const present = [...new Set(rows.map((r) => r.category))];
    for (const category of REQUIRED_CATEGORIES) {
      expect(present, `known-answers fixture is missing required category "${category}"`).toContain(
        category,
      );
    }
  });

  for (const row of rows) {
    it(`${row.category}: ${row.email}`, async () => {
      // Guard against a hollow oracle row that satisfies the category coverage but asserts nothing.
      expect(Object.keys(row.expect).length, `row "${row.email}" asserts nothing`).toBeGreaterThan(
        0,
      );
      const domain = row.email.split('@')[1] ?? '';
      const fixture: DnsFixture =
        row.dns?.error === true
          ? { error: true }
          : {
              mx: row.dns?.mx ?? [],
              a: row.dns?.a ?? (row.dns?.noMx === true ? [] : ['1.2.3.4']),
            };

      const result = await runPipeline(
        row.email,
        {},
        {
          data: defaultData,
          dns: fakeDns({ [domain]: fixture }),
          prober: unavailableProber,
          clock: fixedClock,
          rng: fixedRng,
        },
      );

      for (const [key, value] of Object.entries(row.expect)) {
        expect(result[key as keyof Result]).toEqual(value);
      }
    });
  }
});
