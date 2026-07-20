// Performance benchmark-as-test: proves the bulk worker-pool actually overlaps network work
// instead of running serially, and that per-domain serialization holds. The throughput assertion is
// *relative* (parallel vs. sequential in the same run) so it's robust to machine speed / CI load.

import { describe, expect, it } from 'vitest';
import { validateMany } from '@/index';
import type { DnsResolver } from '@/types';
import { defaultData } from '@/data';
import { fixedClock, fixedRng, unavailableProber } from './test-utils';

/** A DnsResolver whose MX lookup takes `delayMs`, tracking peak concurrent in-flight lookups. */
function delayedDns(delayMs: number): { dns: DnsResolver; peak: () => number } {
  let live = 0;
  let peak = 0;
  const dns: DnsResolver = {
    resolveMx: (domain) =>
      new Promise((resolve) => {
        live += 1;
        peak = Math.max(peak, live);
        setTimeout(() => {
          live -= 1;
          resolve([{ host: `mx.${domain}`, priority: 10 }]);
        }, delayMs);
      }),
    resolve: () => Promise.resolve([]),
  };
  return { dns, peak: () => peak };
}

async function drain(iter: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _ of iter) count += 1;
  return count;
}

const base = {
  data: defaultData,
  prober: unavailableProber,
  clock: fixedClock,
  rng: fixedRng,
  smtp: false as const, // offline: the only latency is the (faked, delayed) DNS lookup
};

describe('bulk throughput (benchmark-as-test)', () => {
  it('overlaps DNS across domains — concurrency gives a large speedup vs. sequential', async () => {
    const emails = Array.from({ length: 48 }, (_, i) => `user@d${i}.example`); // unique domains

    const seqDns = delayedDns(6);
    const seqStart = performance.now();
    const seqCount = await drain(
      validateMany(emails, { ...base, dns: seqDns.dns, concurrency: 1 }),
    );
    const seqMs = performance.now() - seqStart;

    const parDns = delayedDns(6);
    const parStart = performance.now();
    const parCount = await drain(
      validateMany(emails, { ...base, dns: parDns.dns, concurrency: 20 }),
    );
    const parMs = performance.now() - parStart;

    expect(seqCount).toBe(48);
    expect(parCount).toBe(48);
    expect(parDns.peak()).toBeGreaterThan(1); // real overlap happened
    expect(parMs).toBeLessThan(seqMs / 3); // ≥3× faster than serial
  });

  it('looks up each domain once across the batch (per-domain DNS cache)', async () => {
    const emails = Array.from({ length: 12 }, (_, i) => `user${i}@one-domain.example`); // all one domain
    const { dns, peak } = delayedDns(4);
    const count = await drain(
      validateMany(emails, { ...base, dns, concurrency: 10, perDomainConcurrency: 1 }),
    );
    expect(count).toBe(12);
    expect(peak()).toBe(1); // the 12 addresses share a single cached MX lookup — no hammering
  });
});
