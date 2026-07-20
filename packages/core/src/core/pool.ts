// A pure streaming scheduler: run `task` over a (possibly async) source with bounded GLOBAL concurrency
// AND bounded PER-KEY concurrency, yielding each result as it settles. Pure — only promises + maps, no
// I/O, time, or randomness (the pure-core lint applies here). Used by validateMany so a bulk run
// overlaps work across domains while never opening more than `perKeyConcurrency` connections to one MX
// (good-citizen, CLAUDE.md #3), and stays memory-bounded on huge/streaming inputs.

export interface PoolOptions<T> {
  /** Max tasks in flight across all keys. */
  readonly concurrency: number;
  /** Max tasks in flight sharing one key (e.g. per MX domain). */
  readonly perKeyConcurrency: number;
  /** The serialization key for an item (e.g. the email's domain). */
  readonly key: (item: T) => string;
}

function iteratorOf<T>(source: Iterable<T> | AsyncIterable<T>): AsyncIterator<T> | Iterator<T> {
  return Symbol.asyncIterator in source
    ? source[Symbol.asyncIterator]()
    : source[Symbol.iterator]();
}

/** Coerce a count option to a positive integer; a non-finite value (NaN/±Infinity) falls back to 1. */
function positiveInt(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/**
 * Yield `task(item)` results as they complete. At most `concurrency` run at once, at most
 * `perKeyConcurrency` share a key, and at most ~`2 × concurrency` items are buffered from the source at
 * a time (so a 1M-row stream doesn't materialize). Results arrive in completion order, not input order.
 * A rejecting `task` propagates (aborting the generator) — callers that must not abort should pass a
 * task that never rejects (e.g. one that degrades failures to a value).
 *
 * On early termination (the consumer `break`s, or the loop body throws), the source iterator's
 * `return()` is invoked so streaming sources release their resources (e.g. a file handle). In-flight
 * tasks are not cancelled — the pool is transport-agnostic, so pass a `task` that self-bounds (timeouts).
 *
 * Overlap across keys is limited to the buffer window: a source **fully grouped by key** (all of key A,
 * then all of key B, …) exposes only ~`2 × concurrency` items — i.e. few distinct keys — at a time, so
 * global concurrency is underused. Interleave keys in the source for full throughput (see validateMany).
 */
export async function* runPool<T, R>(
  source: Iterable<T> | AsyncIterable<T>,
  task: (item: T) => Promise<R>,
  options: PoolOptions<T>,
): AsyncIterable<R> {
  const concurrency = positiveInt(options.concurrency);
  const perKey = positiveInt(options.perKeyConcurrency);
  const maxBuffer = concurrency * 2;
  const iter = iteratorOf(source);

  const pending: T[] = [];
  const keyCount = new Map<string, number>();
  const inflight = new Map<number, Promise<{ id: number; result: R }>>();
  const inflightKey = new Map<number, string>();
  let nextId = 0;
  let sourceDone = false;

  async function fill(): Promise<void> {
    while (!sourceDone && pending.length + inflight.size < maxBuffer) {
      const next = await iter.next();
      if (next.done === true) {
        sourceDone = true;
        return;
      }
      pending.push(next.value);
    }
  }

  function startReady(): void {
    let i = 0;
    while (i < pending.length && inflight.size < concurrency) {
      const item = pending[i] as T;
      const key = options.key(item);
      if ((keyCount.get(key) ?? 0) < perKey) {
        pending.splice(i, 1);
        keyCount.set(key, (keyCount.get(key) ?? 0) + 1);
        const id = nextId++;
        inflightKey.set(id, key);
        inflight.set(
          id,
          task(item).then((result) => ({ id, result })),
        );
      } else {
        i += 1; // key saturated → leave it queued and look further down
      }
    }
  }

  try {
    await fill();
    startReady();
    while (inflight.size > 0) {
      const { id, result } = await Promise.race(inflight.values());
      inflight.delete(id);
      const key = inflightKey.get(id) as string;
      inflightKey.delete(id);
      const remaining = (keyCount.get(key) as number) - 1;
      // Delete at zero so `keyCount` stays O(active keys), not O(distinct keys ever seen) — otherwise a
      // high-cardinality stream (one domain per row) would grow the map without bound.
      if (remaining <= 0) keyCount.delete(key);
      else keyCount.set(key, remaining);
      yield result;
      await fill();
      startReady();
    }
  } finally {
    // Forward cancellation to the source so a streaming source can run its own cleanup (the CLI's
    // readline/file handle). Native async generators don't auto-forward `return()` to a manually
    // stepped iterator, so we do it explicitly. Best-effort — never mask the consumer's outcome.
    try {
      await iter.return?.();
    } catch {
      // ignore source-cleanup errors
    }
  }
}
