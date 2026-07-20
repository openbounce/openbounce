// Conformance tests for the real DnsResolver adapter, with the c-ares Resolver mocked so they stay
// deterministic and offline. This is the subtle, correctness-critical code (error classification,
// RFC 7505 null-MX, priority sort, A/AAAA dispatch) that the fake resolver in the pipeline tests
// cannot exercise — a mis-classified SERVFAIL here would turn a transient error into a false `no_mx`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveMx: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}));

vi.mock('node:dns', () => ({
  promises: {
    Resolver: class {
      resolveMx = mocks.resolveMx;
      resolve4 = mocks.resolve4;
      resolve6 = mocks.resolve6;
    },
  },
}));

import { NodeDnsResolver } from '@/resolvers/node-dns';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('NodeDnsResolver (mocked c-ares)', () => {
  beforeEach(() => {
    mocks.resolveMx.mockReset();
    mocks.resolve4.mockReset();
    mocks.resolve6.mockReset();
  });

  it('lower-cases + strips the trailing dot and sorts MX by priority', async () => {
    mocks.resolveMx.mockResolvedValue([
      { exchange: 'MX2.Example.COM.', priority: 20 },
      { exchange: 'mx1.example.com', priority: 10 },
    ]);
    expect(await new NodeDnsResolver().resolveMx('example.com')).toEqual([
      { host: 'mx1.example.com', priority: 10 },
      { host: 'mx2.example.com', priority: 20 },
    ]);
  });

  it('keeps an RFC 7505 null MX (host → "") rather than dropping it', async () => {
    mocks.resolveMx.mockResolvedValue([{ exchange: '.', priority: 0 }]);
    expect(await new NodeDnsResolver().resolveMx('no-mail.example')).toEqual([
      { host: '', priority: 0 },
    ]);
  });

  it('maps a "not found" error (ENOTFOUND/ENODATA) to an empty result', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      mocks.resolveMx.mockRejectedValueOnce(dnsError(code));
      expect(await new NodeDnsResolver().resolveMx('nope.example')).toEqual([]);
    }
  });

  it('rethrows a transient failure (SERVFAIL/timeout) so the pipeline can report unknown', async () => {
    mocks.resolveMx.mockRejectedValue(dnsError('ESERVFAIL'));
    await expect(new NodeDnsResolver().resolveMx('flaky.example')).rejects.toThrow('ESERVFAIL');
  });

  it('dispatches resolve() to resolve4 for A and resolve6 for AAAA', async () => {
    mocks.resolve4.mockResolvedValue(['93.184.216.34']);
    mocks.resolve6.mockResolvedValue(['2606:2800:220:1::248:1893:25c8:1946']);
    const r = new NodeDnsResolver();
    expect(await r.resolve('example.com', 'A')).toEqual(['93.184.216.34']);
    expect(await r.resolve('example.com', 'AAAA')).toEqual(['2606:2800:220:1::248:1893:25c8:1946']);
    expect(mocks.resolve4).toHaveBeenCalledOnce();
    expect(mocks.resolve6).toHaveBeenCalledOnce();
  });

  it('maps a not-found A lookup to empty (never a false throw)', async () => {
    mocks.resolve4.mockRejectedValue(dnsError('ENOTFOUND'));
    expect(await new NodeDnsResolver().resolve('nope.example', 'A')).toEqual([]);
  });
});
