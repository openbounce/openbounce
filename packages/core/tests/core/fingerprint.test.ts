import { describe, expect, it } from 'vitest';
import { fingerprintProvider, UNRELIABLE_PROVIDERS } from '@/core/fingerprint';

describe('fingerprintProvider', () => {
  it('returns undefined when there are no MX hosts', () => {
    expect(fingerprintProvider([])).toBeUndefined();
  });
  it('identifies the major providers', () => {
    expect(fingerprintProvider(['gmail-smtp-in.l.google.com'])).toBe('google');
    expect(fingerprintProvider(['acme-com.mail.protection.outlook.com'])).toBe('microsoft');
    expect(fingerprintProvider(['mta5.am0.yahoodns.net'])).toBe('yahoo');
    expect(fingerprintProvider(['mx01.mail.icloud.com'])).toBe('apple');
    expect(fingerprintProvider(['mail.protonmail.ch'])).toBe('proton');
    expect(fingerprintProvider(['mx.zoho.com'])).toBe('zoho');
  });
  it('falls back to "custom" for an unrecognized but present MX', () => {
    expect(fingerprintProvider(['mx.mycompany.example'])).toBe('custom');
  });
  it('does NOT match on suffix spoofing — only true host-boundary suffixes count', () => {
    // These embed a provider domain without being a real subdomain of it; a naive substring/endsWith
    // check would false-positive. Each must resolve to "custom", not the impersonated provider.
    expect(fingerprintProvider(['mx.notgoogle.com'])).toBe('custom');
    expect(fingerprintProvider(['google.com.mx.attacker.example'])).toBe('custom');
    expect(fingerprintProvider(['mail.evilyahoo.com'])).toBe('custom');
    expect(fingerprintProvider(['fakeoutlook.com'])).toBe('custom');
  });
  it('matches a real suffix at any subdomain depth, tolerating a trailing dot', () => {
    expect(fingerprintProvider(['a.b.c.google.com'])).toBe('google');
    expect(fingerprintProvider(['aspmx.l.google.com.'])).toBe('google'); // FQDN trailing dot from DNS
  });
  it('picks a provider if any MX host matches, not only the first', () => {
    expect(fingerprintProvider(['mx.mycompany.example', 'gmail-smtp-in.l.google.com'])).toBe(
      'google',
    );
  });
  it('marks the accept-all-prone providers as unreliable to probe', () => {
    expect(UNRELIABLE_PROVIDERS.has('google')).toBe(true);
    expect(UNRELIABLE_PROVIDERS.has('microsoft')).toBe(true);
    expect(UNRELIABLE_PROVIDERS.has('yahoo')).toBe(true);
    expect(UNRELIABLE_PROVIDERS.has('custom')).toBe(false);
  });
});
