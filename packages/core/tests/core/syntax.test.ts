import { describe, expect, it } from 'vitest';
import { isValidSyntax, normalizeEmail, parseEmail } from '@/core/syntax';

describe('isValidSyntax', () => {
  it('accepts a normal address', () => {
    expect(isValidSyntax('user@example.com')).toBe(true);
  });

  it('accepts subdomains and plus-addressing', () => {
    expect(isValidSyntax('user.name+tag@mail.example.co')).toBe(true);
  });

  it('rejects a missing @', () => {
    expect(isValidSyntax('userexample.com')).toBe(false);
  });

  it('rejects a domain with no TLD', () => {
    expect(isValidSyntax('user@localhost')).toBe(false);
  });

  it('rejects an all-numeric TLD', () => {
    expect(isValidSyntax('user@1.2')).toBe(false);
  });

  it('rejects leading/trailing dots in the domain', () => {
    expect(isValidSyntax('user@.example.com')).toBe(false);
    expect(isValidSyntax('user@example.com.')).toBe(false);
  });

  it('rejects an empty local-part', () => {
    expect(isValidSyntax('@example.com')).toBe(false);
  });

  it('rejects an over-long address', () => {
    expect(isValidSyntax(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases the domain but preserves local-part case, and trims', () => {
    expect(normalizeEmail('  User.Name@EXAMPLE.COM ')).toBe('User.Name@example.com');
  });
});

describe('parseEmail', () => {
  it('splits at the last @', () => {
    expect(parseEmail('a@b@example.com')).toEqual({ local: 'a@b', domain: 'example.com' });
  });

  it('returns null without a usable split', () => {
    expect(parseEmail('@example.com')).toBeNull();
    expect(parseEmail('user@')).toBeNull();
    expect(parseEmail('nope')).toBeNull();
  });
});
