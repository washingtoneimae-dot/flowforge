import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRoot, listFiles, importFiles } from './files.js';

describe('files browser', () => {  it('rejects bad scopes and keys', () => {
    expect(() => resolveRoot('nope', undefined)).toThrow(/unknown file scope/);
    expect(() => resolveRoot('custom', '../evil')).toThrow(/valid node key/);
    expect(resolveRoot('custom', 'myNode').label).toBe('data/custom/myNode');
    expect(resolveRoot('device', undefined)).toMatchObject({ root: '/', mkdir: false });
  });
  it('lists jailed directories and rejects escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-ls-'));
    const { entries } = listFiles(root, '');
    expect(Array.isArray(entries)).toBe(true);
    expect(() => listFiles(root, '../../..')).toThrow(/escapes/);
    expect(() => listFiles(root, '/abs')).toThrow(/escapes/);
  });
  it('does not create missing device paths and reports unreadable ones', () => {
    expect(() => listFiles('/', 'definitely-not-here-ff', false)).toThrow(/cannot list/);
  });
});

describe('files import', () => {
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  it('writes files jailed under the base path', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-imp-'));
    const r = importFiles(root, 'inbox', [
      { path: 'a.txt', content: b64('hi') },
      { path: 'sub/b.bin', content: b64('xy') },
    ]);
    expect(r.written).toEqual(['inbox/a.txt', 'inbox/sub/b.bin']);
    expect(r.bytes).toBe(4);
  });
  it('rejects escapes and empties; absolutes are jailed to relative', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-imp-'));
    expect(() => importFiles(root, '', [{ path: '../evil.txt', content: b64('x') }])).toThrow(/bad file path|escapes/);
    expect(importFiles(root, '', [{ path: '/abs.txt', content: b64('x') }]).written).toEqual(['abs.txt']);
    expect(() => importFiles(root, '../../..', [{ path: 'a.txt', content: b64('x') }])).toThrow(/escapes/);
    expect(() => importFiles(root, '', [])).toThrow(/no files/);
  });
});
