import { describe, it, expect } from 'vitest';
import { validateCustomNode, runCustomCode, rowToDefinition } from './customNodes.js';

describe('validateCustomNode', () => {
  it('accepts a minimal node', () => {
    const v = validateCustomNode({ key: 'upperCase', displayName: 'Uppercase', code: 'return items;' });
    expect(v.key).toBe('upperCase');
    expect(v.category).toBe('custom');
  });
  it('rejects bad keys', () => {
    expect(() => validateCustomNode({ key: 'has space', displayName: 'X', code: 'return items;' })).toThrow(/key/);
    expect(() => validateCustomNode({ key: '9lives', displayName: 'X', code: 'return items;' })).toThrow(/key/);
    expect(() => validateCustomNode({ key: 'if', displayName: '', code: 'return items;' })).toThrow(/displayName/);
  });
  it('rejects empty code and bad properties', () => {
    expect(() => validateCustomNode({ key: 'a', displayName: 'A', code: '  ' })).toThrow(/code/);
    expect(() => validateCustomNode({ key: 'a', displayName: 'A', code: 'return items;', properties: [{ key: '', type: 'nope' }] })).toThrow();
  });
  it('accepts emoji and image icons, rejects junk', () => {
    expect(validateCustomNode({ key: 'a', displayName: 'A', code: 'return items;', icon: '✉️' }).icon).toBe('✉️');
    expect(validateCustomNode({ key: 'a', displayName: 'A', code: 'return items;', icon: 'data:image/png;base64,AAA' }).icon).toContain('data:image');
    expect(validateCustomNode({ key: 'a', displayName: 'A', code: 'return items;' }).icon).toBe('');
    expect(() => validateCustomNode({ key: 'a', displayName: 'A', code: 'return items;', icon: 'this is way too long for an icon label' })).toThrow(/icon/);
  });
});

describe('runCustomCode', () => {
  const base = { params: {} as Record<string, unknown> };
  it('runs items/params code and normalizes items', async () => {
    const out: any = await runCustomCode('return items.map(i => ({ json: { ...i.json, seen: params.flag } }));', {
      ...base, params: { flag: true }, items: [{ json: { a: 1 } }],
    });
    expect(out).toEqual([{ json: { a: 1, seen: true } }]);
  });
  it('supports branch output', async () => {
    const out: any = await runCustomCode('return { branches: [items, []] };', { ...base, items: [{ json: {} }] });
    expect(out.branches[0]).toHaveLength(1);
  });
  it('throws when code does not return an array', () => {
    expect(() => runCustomCode('return 42;', { ...base, items: [] })).toThrow(/array/);
  });
});

describe('rowToDefinition', () => {
  it('builds an executable action node', async () => {
    const def = rowToDefinition({
      key: 't', display_name: 'T', description: '', category: 'custom',
      properties: JSON.stringify([{ key: 'f', displayName: 'F', type: 'string', default: 'x' }]),
      code: 'return items;', icon: '✉️', created_at: '', updated_at: '',
    });
    expect(def.kind).toBe('action');
    expect(def.icon).toBe('✉️');
    expect(def.properties).toHaveLength(1);
    const out = await def.execute({ params: {}, items: [{ json: {} }], vars: {}, workflow: { id: 'w', name: 'w' }, error: (m) => new Error(m) });
    expect(out).toEqual([{ json: {} }]);
  });
});
