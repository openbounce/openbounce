// Refreshes the bundled datasets from pinned upstreams, then normalizes (lowercase, dedupe, sort) and
// writes them to packages/core/src/data/generated/. Run manually; commit the generated files (never a
// runtime fetch). See docs/guide/how-it-works.md.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'core',
  'src',
  'data',
  'generated',
);

// Disposable/throwaway-email domains — the canonical CC0 (public-domain) list.
const SOURCES = {
  disposable: {
    url: 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
    license: 'CC0-1.0',
  },
};

async function fetchDomains(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  const text = await res.text();
  const domains = text
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l.length > 0 && !l.startsWith('#') && l.includes('.'));
  return [...new Set(domains)].sort();
}

await mkdir(OUT, { recursive: true });

const disposable = await fetchDomains(SOURCES.disposable.url);
await writeFile(join(OUT, 'disposable.json'), `${JSON.stringify(disposable)}\n`);

await writeFile(
  join(OUT, 'SOURCES.md'),
  `# Generated datasets\n\nRegenerate with \`node scripts/update-data.mjs\`. Do not hand-edit.\n\n` +
    `- **disposable.json** (${disposable.length} domains) — ${SOURCES.disposable.url} — license ${SOURCES.disposable.license}\n`,
);

console.log(`disposable: ${disposable.length} domains written to ${OUT}`);
