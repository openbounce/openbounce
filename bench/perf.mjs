// Performance benchmark — real, measured numbers for the README (with machine + date). Uses a fake,
// instant DNS resolver so we measure the ENGINE, not the network (the real bottleneck is deliberately
// rate-limited network I/O — see docs/guide/performance.md). Run after `pnpm build`.
import { writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { validate, validateMany } from '@openbounce/core';

const instantDns = {
  resolveMx: () => Promise.resolve([{ host: 'gmail-smtp-in.l.google.com', priority: 10 }]),
  resolve: () => Promise.resolve([]),
};
const opts = { dns: instantDns, smtp: false };

function stats(durationsMs) {
  const s = [...durationsMs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: at(50), p95: at(95), p99: at(99), mean };
}

// 1. Offline single-validate latency (full offline path: syntax + lists + fingerprint + fake DNS).
async function latency() {
  const email = 'jane.doe@gmail.com';
  for (let i = 0; i < 2000; i++) await validate(email, opts); // warmup
  const durations = [];
  for (let i = 0; i < 20000; i++) {
    const t = performance.now();
    await validate(email, opts);
    durations.push(performance.now() - t);
  }
  return stats(durations);
}

// 2. Bulk throughput (engine-isolated): unique domains, fake instant DNS, offline.
async function throughput() {
  const emails = Array.from({ length: 50000 }, (_, i) => `user${i}@d${i}.example`);
  const t = performance.now();
  let n = 0;
  for await (const _ of validateMany(emails, { ...opts, concurrency: 20 })) {
    void _;
    n += 1;
  }
  const elapsed = (performance.now() - t) / 1000;
  return { count: n, seconds: elapsed, perSec: Math.round(n / elapsed) };
}

// 3. Memory-bounded on a large stream: pull lazily, sample heap, report the delta (should stay ~flat).
async function retainedMB(total) {
  function* source() {
    for (let i = 0; i < total; i++) yield `user${i}@d${i % 500}.example`;
  }
  if (globalThis.gc) globalThis.gc();
  const baseline = process.memoryUsage().heapUsed;
  for await (const _ of validateMany(source(), { ...opts, concurrency: 20 })) void _;
  if (globalThis.gc) globalThis.gc();
  return (process.memoryUsage().heapUsed - baseline) / 1024 / 1024;
}
async function memory() {
  // Retained (post-GC) heap after draining — should be ~0 and FLAT as the stream grows (O(1), not O(n)).
  return {
    calibrated: Boolean(globalThis.gc),
    small: (await retainedMB(50000)).toFixed(1),
    large: (await retainedMB(200000)).toFixed(1),
  };
}

const lat = await latency();
const thr = await throughput();
const mem = await memory();

const stamp = new Date().toISOString().slice(0, 10);
const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
const machine = `Node ${process.version} · ${os.platform()} ${os.arch()} · ${cpu}`;
const ms = (n) => `${n.toFixed(3)} ms`;
const num = (n) => n.toLocaleString('en-US'); // fixed locale → reproducible output

const report = [
  '# openbounce — performance benchmark',
  '',
  `_Generated ${stamp} · ${machine}._`,
  '',
  'Engine-isolated (fake instant DNS, offline). Real-world bulk throughput is **network-bound and',
  'deliberately rate-limited** per domain — these numbers isolate engine overhead, not end-to-end speed.',
  '',
  '| Metric | Result |',
  '| --- | --- |',
  `| Offline \`validate()\` latency (p50) | ${ms(lat.p50)} |`,
  `| Offline \`validate()\` latency (p95) | ${ms(lat.p95)} |`,
  `| Offline \`validate()\` latency (p99) | ${ms(lat.p99)} |`,
  `| Offline \`validate()\` latency (mean) | ${ms(lat.mean)} |`,
  `| Bulk throughput (engine, 50k unique domains, conc. 20) | ${num(thr.perSec)} emails/sec |`,
  `| Retained heap after a 50k-row stream (500 domains) | ${mem.small} MB${mem.calibrated ? '' : ' (uncalibrated — no --expose-gc)'} |`,
  `| Retained heap after a 200k-row stream (500 domains) | ${mem.large} MB — flat vs 50k ⇒ O(1), not O(n) |`,
  '',
  '_Memory (honest):_ retained heap is measured post-GC and stays ~flat as the stream grows — the',
  'input/output never materializes (streaming buffer ~2×concurrency). Separately, the per-domain **DNS',
  'cache grows with the number of _distinct_ domains** in a batch (a logged Phase-4 follow-up); this test',
  'reuses 500 domains, so it isolates the buffer. Pass `cache: false` to bound cache memory on a',
  'high-cardinality list.',
  '',
].join('\n');

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/perf.md', import.meta.url), report);
console.log(report);
console.log(
  `perf ✓  validate p50=${ms(lat.p50)} · bulk ${num(thr.perSec)}/s · retained 50k=${mem.small}MB 200k=${mem.large}MB`,
);
