// Identify the mailbox provider from a domain's MX hostnames. Pure (no I/O). Used to (a) surface
// `provider` and (b) let the scorer down-weight providers whose SMTP probes are unreliable.
//
// Matching is by DNS-label suffix (host === suffix or host ends with `.suffix`), NOT substring — so a
// brand-lookalike like `mail.snapple.com` is NOT mistaken for Apple.

import type { Provider } from '../types';

/** Providers whose `RCPT TO` results are unreliable (accept-all / rate-limit) — never a clean `valid`. */
export const UNRELIABLE_PROVIDERS: ReadonlySet<Provider> = new Set([
  'google',
  'microsoft',
  'yahoo',
]);

// provider → the registrable MX suffixes that identify it.
const RULES: ReadonlyArray<readonly [Provider, readonly string[]]> = [
  ['google', ['google.com', 'googlemail.com']],
  ['microsoft', ['outlook.com', 'protection.outlook.com', 'office365.com', 'hotmail.com']],
  ['yahoo', ['yahoodns.net', 'yahoo.com']],
  ['apple', ['icloud.com', 'apple.com', 'me.com']],
  ['proton', ['protonmail.ch', 'proton.me', 'protonmail.com']],
  ['zoho', ['zoho.com', 'zohomail.com', 'zoho.eu']],
];

function hostHasSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** Returns the provider, `'custom'` if MX exists but is unrecognized, or undefined if there are no MX. */
export function fingerprintProvider(mxHosts: readonly string[]): Provider | undefined {
  if (mxHosts.length === 0) return undefined;
  const hosts = mxHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));

  for (const [provider, suffixes] of RULES) {
    if (hosts.some((host) => suffixes.some((suffix) => hostHasSuffix(host, suffix)))) {
      return provider;
    }
  }
  return 'custom';
}
