// Did-you-mean domain suggestions via Levenshtein distance against a common-domain list.
// Pure: no I/O, time, or randomness (enforced by the pure-core lint).

import { parseEmail } from './syntax';

/** Classic Levenshtein edit distance (iterative, two-row). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/** The second-level part of a domain (everything before the last dot). */
function secondLevel(domain: string): string {
  const dot = domain.lastIndexOf('.');
  return dot === -1 ? domain : domain.slice(0, dot);
}

/** Suggest a closer common domain, or undefined if `domain` is already common / nothing is close. */
export function suggestDomain(
  domain: string,
  commonDomains: readonly string[],
): string | undefined {
  const d = domain.toLowerCase();
  if (commonDomains.includes(d)) return undefined;

  // Only correct a genuinely-close miss: a tighter bound for short domains avoids false "corrections".
  const threshold = d.length <= 5 ? 1 : 2;

  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of commonDomains) {
    // Length pre-filter: |len(a) − len(b)| lower-bounds the edit distance, so a candidate whose length
    // differs by more than the threshold can't win — skip the O(n·m) compute (and its allocations).
    if (Math.abs(candidate.length - d.length) > threshold) continue;
    const dist = levenshtein(d, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  if (best === undefined || bestDist === 0 || bestDist > threshold) return undefined;

  // Reject a "correction" that rewrites half or more of the second-level label (e.g. att.com→aol.com,
  // cox.com→aol.com): a real typo perturbs a small fraction of the name, not most of it.
  const sld = secondLevel(d);
  const bestSld = secondLevel(best);
  if (levenshtein(sld, bestSld) * 2 >= Math.min(sld.length, bestSld.length)) return undefined;
  return best;
}

/** Suggest a corrected full address (`local@closer-domain`), or undefined. */
export function suggestEmail(email: string, commonDomains: readonly string[]): string | undefined {
  const parsed = parseEmail(email);
  if (parsed === null) return undefined;
  const suggestion = suggestDomain(parsed.domain, commonDomains);
  return suggestion === undefined ? undefined : `${parsed.local}@${suggestion}`;
}
