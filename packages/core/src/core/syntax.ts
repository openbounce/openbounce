/**
 * Pragmatic RFC 5321/5322-flavored email syntax validation + normalization.
 *
 * Pure: no I/O, time, or randomness (enforced by the pure-core lint). This is
 * deliberately conservative rather than a full RFC parser: it rejects the garbage real lists contain
 * (missing @, no TLD, illegal characters, over-length) without trying to accept every exotic-but-legal
 * quoted local-part.
 */

const EMAIL_MAX = 254;
const LOCAL_MAX = 64;
const DOMAIN_MAX = 253;
const LABEL_MAX = 63;

// Unquoted local-part: dot-separated "atoms" of the RFC 5322 atext set.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
// A single DNS label: alphanumeric, internal hyphens allowed.
const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
// TLD: alphabetic, 2+ chars (guards against "user@1.2" and bare IPs).
const TLD_RE = /^[A-Za-z]{2,}$/;

export interface ParsedEmail {
  readonly local: string;
  readonly domain: string;
}

/** Lowercase the domain and trim surrounding whitespace; local-part case is preserved. */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at === -1) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}

/** Split into local/domain at the last '@'. Returns null when there is no usable split. */
export function parseEmail(email: string): ParsedEmail | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/** True if `email` is a syntactically plausible address. */
export function isValidSyntax(email: string): boolean {
  if (email.length === 0 || email.length > EMAIL_MAX) return false;

  const parsed = parseEmail(email);
  if (parsed === null) return false;
  const { local, domain } = parsed;

  if (local.length === 0 || local.length > LOCAL_MAX || !LOCAL_RE.test(local)) return false;

  if (domain.length === 0 || domain.length > DOMAIN_MAX) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;

  const labels = domain.split('.');
  if (labels.length < 2) return false; // require a registrable domain + TLD
  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX || !LABEL_RE.test(label)) return false;
  }

  const tld = labels.at(-1);
  return tld !== undefined && TLD_RE.test(tld);
}
