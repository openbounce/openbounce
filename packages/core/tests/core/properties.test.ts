// Property-based invariants (fast-check). These assert the rules that must hold for *every* input, not
// just the hand-picked examples — the cheapest guard against the honesty principle silently breaking
// Pure functions only, so they stay fast + deterministic.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { score } from '@/core/score';
import { isValidSyntax, normalizeEmail, parseEmail } from '@/core/syntax';

// A generator over the full Signals space, including the "didn't run" (undefined) states.
const signals = fc.record({
  syntaxOk: fc.boolean(),
  hasMx: fc.constantFrom(true, false, undefined),
  disposable: fc.boolean(),
  role: fc.boolean(),
  smtpAvailable: fc.boolean(),
  smtpAccepted: fc.constantFrom(true, false, undefined),
  catchAll: fc.constantFrom(true, false, undefined),
  unreliableProvider: fc.constantFrom(true, false, undefined),
});

describe('property: normalizeEmail', () => {
  it('is idempotent — normalizing twice equals normalizing once', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeEmail(s);
        expect(normalizeEmail(once)).toBe(once);
      }),
    );
  });

  it('always lower-cases the domain (everything after the last @)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (local, domain) => {
        const out = normalizeEmail(`${local}@${domain}`);
        const outDomain = out.slice(out.lastIndexOf('@') + 1);
        expect(outDomain).toBe(outDomain.toLowerCase());
      }),
    );
  });
});

describe('property: syntax', () => {
  // Build addresses that are valid by construction, so the accept path is actually exercised on every
  // run (a raw fc.string() is email-shaped far too rarely to test anything here).
  const alnum = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''));
  const token = fc.array(alnum, { minLength: 1, maxLength: 15 }).map((cs) => cs.join(''));
  const tld = fc.constantFrom('com', 'net', 'org', 'io', 'co', 'dev');

  it('accepts every well-formed local@label.tld and parses it back exactly', () => {
    fc.assert(
      fc.property(token, token, tld, (local, label, t) => {
        const email = `${local}@${label}.${t}`;
        expect(isValidSyntax(email)).toBe(true);
        expect(parseEmail(email)).toEqual({ local, domain: `${label}.${t}` });
      }),
    );
  });
});

describe('property: score invariants', () => {
  it('confidence is always within [0, 100]', () => {
    fc.assert(
      fc.property(signals, (s) => {
        const { confidence } = score(s);
        expect(confidence).toBeGreaterThanOrEqual(0);
        expect(confidence).toBeLessThanOrEqual(100);
      }),
    );
  });

  it('bad syntax is always "invalid" / unreachable — never valid, whatever else is true', () => {
    fc.assert(
      fc.property(signals, (s) => {
        const v = score({ ...s, syntaxOk: false });
        expect(v.status).toBe('invalid');
        expect(v.reachable).toBe('invalid');
      }),
    );
  });

  it('honesty invariant: an accept-all-prone provider never yields a confident "valid"', () => {
    fc.assert(
      fc.property(signals, (s) => {
        expect(score({ ...s, unreliableProvider: true }).status).not.toBe('valid');
      }),
    );
  });
});
