import { describe, it, expect, afterAll } from 'vitest';
import {
  hashPassword, verifyPassword, setupRequired, setupPassword, checkPassword,
  changePassword, mintSession, createApiToken, validateSession, revokeSession,
  revokeAllSessions, listApiTokens, loginAllowed, recordLogin,
} from './auth.js';
import { db } from './db.js';

afterAll(() => {
  db.prepare("DELETE FROM sessions WHERE label LIKE 'test%'").run();
  // restore pre-test settings state (tests below set a password)
  db.prepare("DELETE FROM settings WHERE key='password_hash'").run();
});

describe('password hashing', () => {
  it('hashes and verifies, rejects wrong passwords', () => {
    const h = hashPassword('correct-horse-9');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct-horse-9', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
    expect(verifyPassword('correct-horse-9', 'garbage')).toBe(false);
  });
  it('rejects short passwords and randomizes salts', () => {
    expect(() => hashPassword('short')).toThrow(/8 characters/);
    expect(hashPassword('same-password-1')).not.toBe(hashPassword('same-password-1'));
  });
});

describe('setup + password lifecycle', () => {
  it('setup-once semantics with env override', () => {
    delete process.env.FLOWFORGE_PASSWORD;
    db.prepare("DELETE FROM settings WHERE key='password_hash'").run();
    expect(setupRequired()).toBe(true);
    expect(checkPassword('anything')).toBe(false);
    setupPassword('first-secret-1');
    expect(setupRequired()).toBe(false);
    expect(checkPassword('first-secret-1')).toBe(true);
    expect(checkPassword('nope')).toBe(false);
    expect(() => setupPassword('second-secret-2')).toThrow(/already set/);
    changePassword('first-secret-1', 'rotated-secret-2');
    expect(checkPassword('rotated-secret-2')).toBe(true);
    expect(() => changePassword('wrong', 'x'.repeat(8))).toThrow(/wrong/);
    process.env.FLOWFORGE_PASSWORD = 'env-secret-3';
    try {
      expect(setupRequired()).toBe(false);
      expect(checkPassword('env-secret-3')).toBe(true);
      expect(checkPassword('rotated-secret-2')).toBe(false);
      expect(() => setupPassword('x'.repeat(8))).toThrow(/managed/);
    } finally {
      delete process.env.FLOWFORGE_PASSWORD;
    }
  });
});

describe('sessions + api tokens', () => {
  it('mints, validates, revokes', () => {
    const { token } = mintSession(null);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(validateSession(token)?.label).toBeNull();
    expect(validateSession('bogus')).toBeNull();
    expect(revokeSession(token)).toBe(true);
    expect(validateSession(token)).toBeNull();
    expect(revokeSession(token)).toBe(false);
  });
  it('tracks named api tokens separately', () => {
    const a = createApiToken('test-mcp');
    const b = mintSession(null);
    try {
      const listed = listApiTokens().filter((t) => t.label?.startsWith('test'));
      expect(listed.map((t) => t.label)).toContain('test-mcp');
      expect(validateSession(a.token)?.label).toBe('test-mcp');
    } finally {
      revokeSession(a.token);
      revokeSession(b.token);
    }
  });
  it('expires old sessions on access', () => {
    const { token } = mintSession(null, -1000);
    expect(validateSession(token)).toBeNull();
  });
  it('revoke-all clears everything', () => {
    const a = mintSession('test-x', 60_000);
    mintSession(null);
    const n = revokeAllSessions();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(validateSession(a.token)).toBeNull();
  });
});

describe('login throttle', () => {
  it('blocks after 10 failures per window, resets on success', () => {
    const ip = 'test-throttle-ip';
    expect(loginAllowed(ip)).toBe(true);
    for (let i = 0; i < 10; i++) recordLogin(ip, false);
    expect(loginAllowed(ip)).toBe(false);
    recordLogin(ip, true);
    expect(loginAllowed(ip)).toBe(true);
  });
});
