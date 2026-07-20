import { describe, expect, it } from 'vitest';
import { validate, validateMany } from '@/index';
import type { DataProvider, Result, SmtpProber } from '@/types';
import { fakeDns, fixedClock, unavailableProber } from './test-utils';

describe('validate (wiring)', () => {
  it('rejects invalid syntax with defaults (no network needed)', async () => {
    const r = await validate('not-an-email');
    expect(r.status).toBe('invalid');
    expect(r.subStatus).toBe('invalid_syntax');
    expect(r.reachable).toBe('invalid');
  });

  it('is offline by default — never probes unless SMTP is explicitly requested', async () => {
    let probeCalls = 0;
    let preflightCalls = 0;
    const spyProber: SmtpProber = {
      preflight: () => {
        preflightCalls++;
        return Promise.resolve(true);
      },
      probe: () => {
        probeCalls++;
        return Promise.resolve({ code: 250, accepted: true, outcome: 'accepted' });
      },
    };
    // A deliverable custom domain, port 25 "open" per the prober — a bare validate() must still NOT probe.
    const r = await validate('jane@acme-corp.example', {
      dns: fakeDns({ 'acme-corp.example': { mx: ['mx.acme-corp.example'] } }),
      prober: spyProber,
      clock: fixedClock,
    });
    expect(probeCalls).toBe(0);
    expect(preflightCalls).toBe(0); // offline default: we don't even preflight
    expect(r.subStatus).toBe('smtp_unavailable'); // honest unknown, mailbox unverified
    expect(r.checks.find((c) => c.name === 'smtp')?.outcome).toBe('skip');
  });

  it('runs the full offline pipeline through injected deps', async () => {
    const r = await validate('jane@gmail.com', {
      dns: fakeDns({ 'gmail.com': { mx: ['gmail-smtp-in.l.google.com'] } }),
      prober: unavailableProber,
      clock: fixedClock,
    });
    expect(r.email).toBe('jane@gmail.com');
    expect(r.provider).toBe('google');
    expect(r.free).toBe(true);
    expect(r.status).toBe('unknown'); // no SMTP in Phase 2 → honest unknown
    expect(r.smtp.available).toBe(false);
  });
});

describe('validateMany', () => {
  it('streams one result per input across a small concurrency', async () => {
    const dns = fakeDns({
      'a.example': { mx: ['mx.a.example'] },
      'b.example': { mx: ['mx.b.example'] },
    });
    const emails = ['x@a.example', 'not-an-email', 'y@b.example'];
    const seen: string[] = [];
    for await (const r of validateMany(emails, {
      dns,
      prober: unavailableProber,
      clock: fixedClock,
      concurrency: 2,
    })) {
      seen.push(r.email);
    }
    expect(seen).toHaveLength(3);
    expect(seen).toContain('x@a.example');
    expect(seen).toContain('y@b.example');
  });

  it('isolates a per-row failure (never aborts the batch)', async () => {
    const dns = fakeDns({
      'a.example': { mx: ['mx.a.example'] },
      'b.example': { mx: ['mx.b.example'] },
    });
    // A data provider that throws for one specific address makes runPipeline throw for that row only.
    const data: DataProvider = {
      isDisposable: () => false,
      isFreeProvider: () => false,
      isRoleAccount: () => false,
      suggest: (email) => {
        if (email.includes('boom')) throw new Error('kaboom');
        return undefined;
      },
    };
    const emails = ['x@a.example', 'boom@b.example', 'y@a.example'];
    const results: Result[] = [];
    for await (const r of validateMany(emails, {
      dns,
      data,
      prober: unavailableProber,
      clock: fixedClock,
      concurrency: 2,
    })) {
      results.push(r);
    }
    // Results arrive in completion order (not input order); look them up by address.
    expect(results).toHaveLength(emails.length); // exactly one per input — no drops, no duplicates
    const byEmail = new Map(results.map((r) => [r.email, r]));
    expect([...byEmail.keys()].sort()).toEqual([...emails].sort());
    expect(byEmail.get('boom@b.example')).toMatchObject({
      status: 'unknown',
      subStatus: 'dns_error',
      confidence: 0,
    });
    expect(byEmail.get('x@a.example')?.subStatus).toBe('smtp_unavailable'); // good rows still processed
    expect(byEmail.get('y@a.example')?.subStatus).toBe('smtp_unavailable');
  });
});
