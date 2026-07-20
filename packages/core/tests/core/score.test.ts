import { describe, expect, it } from 'vitest';
import { score, type Signals } from '@/core/score';

const base: Signals = {
  syntaxOk: true,
  hasMx: true,
  disposable: false,
  role: false,
  smtpAvailable: false,
};

describe('score', () => {
  it('invalid syntax → invalid/invalid_syntax', () => {
    const v = score({ ...base, syntaxOk: false });
    expect(v.status).toBe('invalid');
    expect(v.subStatus).toBe('invalid_syntax');
    expect(v.reachable).toBe('invalid');
  });
  it('no MX → invalid/no_mx', () => {
    expect(score({ ...base, hasMx: false }).subStatus).toBe('no_mx');
  });
  it('DNS failure → unknown/dns_error', () => {
    expect(score({ ...base, hasMx: undefined }).subStatus).toBe('dns_error');
  });
  it('disposable domain → disposable/risky', () => {
    const v = score({ ...base, disposable: true });
    expect(v.status).toBe('disposable');
    expect(v.reachable).toBe('risky');
  });
  it('role account (deliverable, no SMTP) → role/risky', () => {
    expect(score({ ...base, role: true }).status).toBe('role');
  });
  it('deliverable domain, no SMTP → honest unknown/smtp_unavailable', () => {
    const v = score(base);
    expect(v.status).toBe('unknown');
    expect(v.subStatus).toBe('smtp_unavailable');
    expect(v.reachable).toBe('unknown');
  });
  it('SMTP accepted → valid/safe (Phase 3 path)', () => {
    const v = score({ ...base, smtpAvailable: true, smtpAccepted: true });
    expect(v.status).toBe('valid');
    expect(v.reachable).toBe('safe');
  });
  it('SMTP rejected → invalid/mailbox_not_found', () => {
    expect(score({ ...base, smtpAvailable: true, smtpAccepted: false }).subStatus).toBe(
      'mailbox_not_found',
    );
  });
  it('catch-all → catch_all/risky', () => {
    const v = score({ ...base, smtpAvailable: true, smtpAccepted: true, catchAll: true });
    expect(v.status).toBe('catch_all');
  });
  it('honesty: an unreliable provider accepting → unknown/provider_unverifiable, never a clean valid', () => {
    const v = score({ ...base, smtpAvailable: true, smtpAccepted: true, unreliableProvider: true });
    expect(v).toMatchObject({
      status: 'unknown',
      subStatus: 'provider_unverifiable',
      reachable: 'risky',
      confidence: 40,
    });
  });
  it('disposable is decisive over a transient DNS error (offline-certain)', () => {
    expect(score({ ...base, hasMx: undefined, disposable: true }).status).toBe('disposable');
  });
  it('greylisted (4xx after retries) → unknown/greylisted', () => {
    const v = score({ ...base, smtpAvailable: true, greylisted: true });
    expect(v).toMatchObject({ status: 'unknown', subStatus: 'greylisted', reachable: 'unknown' });
  });
  it('disposable outranks a role/SMTP verdict', () => {
    expect(score({ ...base, disposable: true, role: true }).status).toBe('disposable');
  });
  it('confidence is always within [0, 100]', () => {
    const cases: Signals[] = [
      base,
      { ...base, syntaxOk: false },
      { ...base, hasMx: false },
      { ...base, hasMx: undefined },
      { ...base, disposable: true },
      { ...base, smtpAvailable: true, smtpAccepted: true },
    ];
    for (const c of cases) {
      const { confidence } = score(c);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(100);
    }
  });
});
