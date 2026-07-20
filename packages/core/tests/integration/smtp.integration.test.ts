import { describe, expect, it } from 'vitest';
import { validate } from '@/index';

// Real SMTP probe over port 25. Skipped unless OPENBOUNCE_INTEGRATION=1 (and only meaningful from a box
// whose outbound :25 is open — blocked on most laptops/CI). Run via the dedicated config:
//   OPENBOUNCE_INTEGRATION=1 pnpm --filter @openbounce/core test:integration
const enabled = process.env.OPENBOUNCE_INTEGRATION === '1';

describe.runIf(enabled)('SMTP integration (real port 25)', () => {
  it('returns a shaped, honest verdict (never a confident valid for a big provider)', async () => {
    const r = await validate('postmaster@gmail.com');
    expect(['valid', 'invalid', 'catch_all', 'role', 'disposable', 'unknown']).toContain(r.status);
    // Honesty invariant on a live provider: Gmail can't yield a confident `valid`.
    expect(r.status).not.toBe('valid');
  });

  it('a syntactically dead domain resolves to invalid/no_mx without hanging', async () => {
    const r = await validate('x@no-such-domain-zzzz.example');
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('no_mx');
  });
});
