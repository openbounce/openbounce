import { describe, expect, it } from 'vitest';
import { levenshtein, suggestDomain, suggestEmail } from '@/core/typo';
import { COMMON_DOMAINS } from '@/data/typo-domains';

describe('levenshtein', () => {
  it('is 0 for identical strings', () => {
    expect(levenshtein('gmail.com', 'gmail.com')).toBe(0);
  });
  it('counts substitutions (gmial ↔ gmail is a 2-edit transposition)', () => {
    expect(levenshtein('gmial.com', 'gmail.com')).toBe(2);
  });
  it('counts a single insertion', () => {
    expect(levenshtein('gmai.com', 'gmail.com')).toBe(1);
  });
  it('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('suggestDomain', () => {
  it('returns undefined for an exact common domain', () => {
    expect(suggestDomain('gmail.com', COMMON_DOMAINS)).toBeUndefined();
  });
  it('corrects a close typo', () => {
    expect(suggestDomain('gmial.com', COMMON_DOMAINS)).toBe('gmail.com');
    expect(suggestDomain('gmai.com', COMMON_DOMAINS)).toBe('gmail.com');
    expect(suggestDomain('hotmial.com', COMMON_DOMAINS)).toBe('hotmail.com');
  });
  it('does not "correct" a legitimate unknown domain', () => {
    expect(suggestDomain('mycompany.com', COMMON_DOMAINS)).toBeUndefined();
    expect(suggestDomain('acme-corp.io', COMMON_DOMAINS)).toBeUndefined();
  });
  it('does not "correct" a real domain toward an unrelated look-alike (SLD-fraction guard)', () => {
    // att.com / cox.com are real domains within edit-distance 2 of aol.com, but half the short SLD
    // would have to change — that is not a typo, so no suggestion.
    expect(suggestDomain('att.com', COMMON_DOMAINS)).toBeUndefined();
    expect(suggestDomain('cox.com', COMMON_DOMAINS)).toBeUndefined();
  });
});

describe('suggestEmail', () => {
  it('rewrites only the domain', () => {
    expect(suggestEmail('user.name@gmial.com', COMMON_DOMAINS)).toBe('user.name@gmail.com');
  });
  it('returns undefined when the address is fine', () => {
    expect(suggestEmail('user@gmail.com', COMMON_DOMAINS)).toBeUndefined();
  });
  it('returns undefined for an unparseable address', () => {
    expect(suggestEmail('nope', COMMON_DOMAINS)).toBeUndefined();
  });
});
