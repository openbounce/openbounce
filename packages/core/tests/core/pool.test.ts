import { describe, expect, it } from 'vitest';
import { runPool } from '@/core/pool';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runPool', () => {
  it('runs every item, bounded by global and per-key concurrency', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: i, key: i % 4 })); // 4 keys
    let live = 0;
    let peak = 0;
    const perKeyLive = new Map<number, number>();
    const perKeyPeak = new Map<number, number>();

    const task = (item: { id: number; key: number }): Promise<number> =>
      new Promise((resolve) => {
        live += 1;
        peak = Math.max(peak, live);
        const kl = (perKeyLive.get(item.key) ?? 0) + 1;
        perKeyLive.set(item.key, kl);
        perKeyPeak.set(item.key, Math.max(perKeyPeak.get(item.key) ?? 0, kl));
        setTimeout(() => {
          live -= 1;
          perKeyLive.set(item.key, (perKeyLive.get(item.key) ?? 1) - 1);
          resolve(item.id);
        }, 5);
      });

    const results: number[] = [];
    for await (const r of runPool(items, task, {
      concurrency: 6,
      perKeyConcurrency: 2,
      key: (it) => String(it.key),
    })) {
      results.push(r);
    }

    expect([...results].sort((a, b) => a - b)).toEqual(items.map((it) => it.id));
    expect(peak).toBeLessThanOrEqual(6);
    expect(Math.max(...perKeyPeak.values())).toBeLessThanOrEqual(2);
  });

  it('serializes a single saturated key (perKeyConcurrency 1) despite high global concurrency', async () => {
    let live = 0;
    let peak = 0;
    const task = (i: number): Promise<number> =>
      new Promise((resolve) => {
        live += 1;
        peak = Math.max(peak, live);
        setTimeout(() => {
          live -= 1;
          resolve(i);
        }, 3);
      });

    const results: number[] = [];
    for await (const r of runPool([0, 1, 2, 3, 4, 5, 6, 7], task, {
      concurrency: 5,
      perKeyConcurrency: 1,
      key: () => 'one-domain',
    })) {
      results.push(r);
    }

    expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(1); // all one key at perKey 1 → strictly serial
  });

  it('yields in completion order (a fast task overtakes an earlier slow one)', async () => {
    const task = (i: number): Promise<number> =>
      new Promise((resolve) => setTimeout(() => resolve(i), i === 0 ? 40 : 2));
    const results: number[] = [];
    for await (const r of runPool([0, 1, 2], task, {
      concurrency: 3,
      perKeyConcurrency: 3,
      key: () => 'k',
    })) {
      results.push(r);
    }
    expect(results.at(-1)).toBe(0); // item 0 started first but finished last
    expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('is memory-bounded — it does not drain the whole source before yielding', async () => {
    let produced = 0;
    function* source(): Generator<number> {
      for (let i = 0; i < 50; i++) {
        produced += 1;
        yield i;
      }
    }
    const gen = runPool(source(), (i) => tick(5).then(() => i), {
      concurrency: 4,
      perKeyConcurrency: 4,
      key: () => 'k',
    });
    const it = gen[Symbol.asyncIterator]();
    await it.next(); // pull just the first result
    expect(produced).toBeLessThanOrEqual(8); // maxBuffer = 2 × concurrency
    for await (const _ of gen) void _; // drain the rest (same underlying generator)
  });

  it('handles an empty source', async () => {
    const results: number[] = [];
    for await (const r of runPool([], async (x: number) => x, {
      concurrency: 4,
      perKeyConcurrency: 1,
      key: () => 'k',
    })) {
      results.push(r);
    }
    expect(results).toEqual([]);
  });

  it('runs the source `finally` (releases resources) when the consumer breaks early', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<number> {
      try {
        for (let i = 0; i < 100; i++) yield i;
      } finally {
        closed = true; // a real source frees a file handle / socket here
      }
    }
    for await (const _ of runPool(source(), (x) => tick(1).then(() => x), {
      concurrency: 4,
      perKeyConcurrency: 4,
      key: () => 'k',
    })) {
      void _;
      break; // take one result and bail — the source must still be cleaned up
    }
    await tick(0);
    expect(closed).toBe(true);
  });

  it('propagates a rejecting task (aborts the generator)', async () => {
    const task = (i: number): Promise<number> =>
      i === 1 ? Promise.reject(new Error('boom')) : tick(2).then(() => i);
    await expect(
      (async () => {
        for await (const _ of runPool([0, 1, 2], task, {
          concurrency: 3,
          perKeyConcurrency: 3,
          key: () => 'k',
        })) {
          void _;
        }
      })(),
    ).rejects.toThrow('boom');
  });

  it('does not stall when the buffer fills with one saturated key (grouped input completes)', async () => {
    // 30 items of key "a" (serialized at perKey 1) then one "b" sitting far past the buffer window —
    // the pool must keep pulling until it reaches "b". Guards against a head-of-line deadlock.
    const items = [...Array.from({ length: 30 }, () => 'a'), 'b'];
    const results: string[] = [];
    for await (const r of runPool(items, (k) => tick(1).then(() => k), {
      concurrency: 8,
      perKeyConcurrency: 1,
      key: (k) => k,
    })) {
      results.push(r);
    }
    expect(results).toHaveLength(31);
    expect(results.filter((r) => r === 'b')).toHaveLength(1);
  });

  it('coerces a non-finite concurrency to a safe default (never silently drops items)', async () => {
    const results: number[] = [];
    for await (const r of runPool([0, 1, 2, 3], async (x: number) => x, {
      concurrency: Number.NaN,
      perKeyConcurrency: Number.NaN,
      key: () => 'k',
    })) {
      results.push(r);
    }
    expect([...results].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it('stays memory-bounded even when the key is saturated (queued items are capped)', async () => {
    let produced = 0;
    function* source(): Generator<number> {
      for (let i = 0; i < 100; i++) {
        produced += 1;
        yield i;
      }
    }
    const gen = runPool(source(), (i) => tick(3).then(() => i), {
      concurrency: 5,
      perKeyConcurrency: 1, // all one key → serialized, so items pile up in `pending` if unbounded
      key: () => 'hot',
    });
    const it = gen[Symbol.asyncIterator]();
    await it.next();
    expect(produced).toBeLessThanOrEqual(10); // maxBuffer = 2 × concurrency, saturated key notwithstanding
    await it.return?.();
  });
});
