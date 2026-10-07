import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveRoot, listFiles } from './files.js';

describe('files browser', () => {
  it('rejects bad scopes and keys', () => {
    expect(() => resolveRoot('nope', undefined)).toThrow(/unknown file scope/);
    expect(() => resolveRoot('custom', '../evil')).toThrow(/valid node key/);
    expect(resolveRoot('custom', 'myNode').label).toBe('data/custom/myNode');
  });
  it('lists jailed directories and rejects escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-ls-'));
    const { entries } = listFiles(root, '');
    expect(Array.isArray(entries)).toBe(true);
    expect(() => listFiles(root, '../../..')).toThrow(/escapes/);
    expect(() => listFiles(root, '/abs')).toThrow(/escapes/);
  });
});
