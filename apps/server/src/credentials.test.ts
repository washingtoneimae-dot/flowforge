import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  encryptFields, decryptFields, validateCredentialInput,
  listCredentials, insertCredential, updateCredential, deleteCredential,
  getCredentialFields, resolveCredentialRefs, CRED_NAME_RE,
} from './credentials.js';
import { db } from './db.js';

const TEST_PREFIX = 'testcred';
const key = randomBytes(32);

afterAll(() => {
  db.prepare(`DELETE FROM credentials WHERE name LIKE '${TEST_PREFIX}%'`).run();
});

describe('credential names', () => {
  it('accepts sane names', () => {
    expect(CRED_NAME_RE.test('github-token')).toBe(true);
    expect(CRED_NAME_RE.test('a_b-9')).toBe(true);
    expect(CRED_NAME_RE.test('')).toBe(false);
    expect(CRED_NAME_RE.test('has space')).toBe(false);
    expect(CRED_NAME_RE.test('../x')).toBe(false);
  });
  it('validates input bodies', () => {
    expect(validateCredentialInput({ name: 't1', fields: { token: 'x' } }).type).toBe('token');
    expect(() => validateCredentialInput({ name: 'bad name', fields: { a: 1 } })).toThrow(/name/);
    expect(() => validateCredentialInput({ name: 't1', fields: {} })).toThrow(/non-empty/);
    expect(() => validateCredentialInput({ name: 't1', fields: [1] })).toThrow(/non-empty/);
  });
});

describe('encryption', () => {
  it('round-trips fields', () => {
    const enc = encryptFields(key, { token: 'secret', user: 'u' });
    expect(enc.startsWith('v1.')).toBe(true);
    expect(decryptFields(key, enc)).toEqual({ token: 'secret', user: 'u' });
  });
  it('is randomized (no deterministic leak)', () => {
    expect(encryptFields(key, { a: 1 })).not.toBe(encryptFields(key, { a: 1 }));
  });
  it('fails on wrong key, tampering, and bad versions', () => {
    const enc = encryptFields(key, { a: 1 });
    expect(() => decryptFields(randomBytes(32), enc)).toThrow(/wrong key or tampered/);
    const tampered = enc.slice(0, -4) + 'AAAA';
    expect(() => decryptFields(key, tampered)).toThrow(/wrong key or tampered/);
    expect(() => decryptFields(key, 'v9.whatever')).toThrow(/version|short/);
  });
});

describe('store', () => {
  it('inserts, lists without values, updates, deletes', () => {
    insertCredential(`${TEST_PREFIX}1`, 'token', encryptFields(key, { token: 's3cr3t' }));
    expect(() => insertCredential(`${TEST_PREFIX}1`, 'token', 'x')).toThrow(/already exists/);
    const listed = listCredentials().filter((c) => c.name.startsWith(TEST_PREFIX));
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('data');
    expect(listed[0]).not.toHaveProperty('fields');
    expect(updateCredential(`${TEST_PREFIX}1`, 'bearer', encryptFields(key, { token: 'new' })))
      .toMatchObject({ type: 'bearer' });
    expect(updateCredential(`${TEST_PREFIX}nope`, 't', undefined)).toBeNull();
    expect(deleteCredential(`${TEST_PREFIX}1`)).toBe(true);
    expect(deleteCredential(`${TEST_PREFIX}1`)).toBe(false);
  });
  it('getCredentialFields decrypts and 404s on unknown', () => {
    insertCredential(`${TEST_PREFIX}2`, 'token', encryptFields(key, { token: 'abc' }));
    expect(getCredentialFields(key, `${TEST_PREFIX}2`)).toEqual({ token: 'abc' });
    expect(() => getCredentialFields(key, `${TEST_PREFIX}missing`)).toThrow(/not found/);
  });
});

describe('resolveCredentialRefs', () => {
  const defs = new Map([
    ['httpRequest', { properties: [{ key: 'url', type: 'string' }, { key: 'credential', type: 'credential' }] }],
    ['noOp', { properties: [] }],
  ]);
  const resolve = (t: string) => defs.get(t);
  const getFields = (name: string) => {
    if (name === 'gh') return { token: 'SECRET' };
    throw new Error(`credential "${name}" not found`);
  };
  it('replaces names with field objects only for credential props', () => {
    const nodes = [
      { id: 'a', type: 'httpRequest', params: { url: 'https://x', credential: 'gh' } },
      { id: 'b', type: 'noOp', params: {} },
    ];
    const { nodes: out, used } = resolveCredentialRefs(nodes, resolve, getFields);
    expect(out[0].params).toEqual({ url: 'https://x', credential: { token: 'SECRET' } });
    expect(out[1]).toBe(nodes[1]); // untouched reference when nothing to resolve
    expect(nodes[0].params.credential).toBe('gh'); // stored def keeps the name
    expect(used).toEqual(['gh']);
  });
  it('skips empty refs and errors on missing credentials', () => {
    const empty = resolveCredentialRefs(
      [{ id: 'a', type: 'httpRequest', params: { credential: '' } }], resolve, getFields,
    );
    expect(empty.nodes[0].params).toEqual({ credential: '' });
    expect(empty.used).toEqual([]);
    expect(() => resolveCredentialRefs(
      [{ id: 'a', type: 'httpRequest', params: { credential: 'ghost' } }], resolve, getFields,
    )).toThrow(/not found/);
  });
});

describe('getCredKey', () => {
  it('reads an explicit env hex key and rejects junk', async () => {
    const { getCredKey } = await import('./credentials.js');
    const root = mkdtempSync(join(tmpdir(), 'ff-cred-'));
    const hex = randomBytes(32).toString('hex');
    process.env.FLOWFORGE_CRED_KEY = hex;
    try {
      expect(getCredKey(root).toString('hex')).toBe(hex);
      process.env.FLOWFORGE_CRED_KEY = 'nope';
      expect(() => getCredKey(root)).toThrow(/64 hex/);
    } finally {
      delete process.env.FLOWFORGE_CRED_KEY;
    }
  });
  it('auto-creates a machine-local key file', async () => {
    const { getCredKey } = await import('./credentials.js');
    const root = mkdtempSync(join(tmpdir(), 'ff-cred-'));
    const k1 = getCredKey(root);
    const k2 = getCredKey(root);
    expect(k1.equals(k2)).toBe(true);
  });
});
