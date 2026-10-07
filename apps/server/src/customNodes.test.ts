import { describe, it, expect, afterAll } from 'vitest';
import { validateCustomNode, runCustomCode, rowToDefinition, saveCustomNode, rollbackCustomNode, approveCustomNode, checkCustomTrust, normalizeLimits, normalizeExamples, runExamples } from './customNodes.js';
import { db } from './db.js';

const TEST_PREFIX = 'testTrustNode';

afterAll(() => {
  db.prepare(`DELETE FROM custom_nodes WHERE key LIKE '${TEST_PREFIX}%'`).run();
  db.prepare(`DELETE FROM custom_node_versions WHERE key LIKE '${TEST_PREFIX}%'`).run();
  db.prepare(`DELETE FROM custom_kv WHERE node_key LIKE '${TEST_PREFIX}%'`).run();
});

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
  it('rejects when code does not return an array', async () => {
    await expect(runCustomCode('return 42;', { ...base, items: [] })).rejects.toThrow(/array/);
  });
  it('awaits async code', async () => {
    const out: any = await runCustomCode('return Promise.resolve(items);', { ...base, items: [{ json: { a: 1 } }] });
    expect(out).toEqual([{ json: { a: 1 } }]);
  });
  it('denies ungranted capabilities with a helpful error', async () => {
    await expect(runCustomCode('return fetch("https://example.com").then(r => items);', { ...base, items: [] }))
      .rejects.toThrow(/not granted/);
  });
});

describe('limits and examples validation', () => {
  it('normalizes limits with bounds', () => {
    expect(normalizeLimits(undefined)).toEqual({ timeoutMs: 10_000, maxItems: 10_000 });
    expect(() => normalizeLimits({ timeoutMs: 50 })).toThrow(/timeoutMs/);
    expect(() => normalizeLimits({ maxItems: 99999 })).toThrow(/maxItems/);
  });
  it('normalizes examples', () => {
    expect(normalizeExamples(undefined)).toEqual([]);
    const ex = normalizeExamples([{ name: 'a', params: { x: 1 } }]);
    expect(ex[0]).toMatchObject({ name: 'a', params: { x: 1 } });
    expect(() => normalizeExamples('nope')).toThrow(/array/);
  });
  it('enforces maxItems at runtime', async () => {
    await expect(runCustomCode('return [{}, {}, {}];', { params: {}, items: [] }, { limits: { maxItems: 2 } }))
      .rejects.toThrow(/limit/);
  });
});

describe('trust ladder: save → test → approve → rollback', () => {
  const K = `${TEST_PREFIX}A`;
  const base = (code: string, extra: any = {}) => ({
    key: K, displayName: 'Trust A', description: '', category: 'custom',
    properties: [], code, icon: '', permissions: {}, author: 'tester', ...extra,
  });

  it('saves without examples as draft', async () => {
    const s = await saveCustomNode(validateCustomNode(base('return items;')));
    expect(s).toMatchObject({ key: K, version: 1, status: 'draft' });
  });

  it('saves with passing examples as tested', async () => {
    const s = await saveCustomNode(validateCustomNode(base('return items;', {
      examples: [{ name: 'basic', items: [{ json: { a: 1 } }] }],
    })));
    expect(s.status).toBe('tested');
    expect(s.version).toBe(2);
    expect(s.report?.[0]).toMatchObject({ name: 'basic', ok: true, items: 1 });
  });

  it('saves with failing examples as draft with report', async () => {
    const s = await saveCustomNode(validateCustomNode(base('throw new Error("nope");', {
      examples: [{ name: 'basic' }],
    })));
    expect(s.status).toBe('draft');
    expect(s.report?.[0]).toMatchObject({ ok: false, error: 'nope' });
  });

  it('refuses approval until tested, then approves', async () => {
    await expect(async () => approveCustomNode(K, 'human')).rejects.toThrow(/self-test/);
    await saveCustomNode(validateCustomNode(base('return items;', { examples: [{ name: 'ok' }] })));
    const row = approveCustomNode(K, 'human');
    expect(row.status).toBe('approved');
  });

  it('rolls back to a previous version', async () => {
    const s = await rollbackCustomNode(K, 2, 'tester');
    expect(s.version).toBeGreaterThan(2);
    expect(s.status).toBe('tested');
  });

  it('reports trust per workflow node list', () => {
    expect(checkCustomTrust([K, 'code'])).toEqual({ draft: [], tested: [K], disabled: [] });
    db.prepare('UPDATE custom_nodes SET disabled=1 WHERE key=?').run(K);
    expect(checkCustomTrust([K]).disabled).toEqual([K]);
    db.prepare('UPDATE custom_nodes SET disabled=0 WHERE key=?').run(K);
  });
});
describe('rowToDefinition', () => {
  it('builds an executable action node', async () => {
    const def = rowToDefinition({
      key: 't', display_name: 'T', description: '', category: 'custom',
      properties: JSON.stringify([{ key: 'f', displayName: 'F', type: 'string', default: 'x' }]),
      code: 'return items;', icon: '✉️', permissions: '{}',
      status: 'approved', author: 'human', version: 1, examples: '[]',
      test_report: null, limits: '{}', disabled: 0, created_at: '', updated_at: '',
    });
    expect(def.kind).toBe('action');
    expect(def.icon).toBe('✉️');
    expect(def.properties).toHaveLength(1);
    const out = await def.execute({ params: {}, items: [{ json: {} }], vars: {}, workflow: { id: 'w', name: 'w' }, error: (m) => new Error(m) });
    expect(out).toEqual([{ json: {} }]);
  });
});
