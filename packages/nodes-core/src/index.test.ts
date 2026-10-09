import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { evaluateExpression } from '@flowforge/engine';
import { setFields, ifNode, filterNode, switchNode, splitOutNode, aggregateNode, cryptoNode, jsonParseNode, coreNodes, datetimeNode, waitNode, scriptStart, scriptEnd, nodeCategories, httpRequest } from './index.js';

const ctx = (params: any, items: any[] = [{ json: {} }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

describe('setFields', () => {
  it('merges fields into every item', async () => {
    const out = await setFields.execute(ctx({ fields: '{"a":1}' }, [{ json: { b: 2 } }])) as any;
    expect(out).toEqual([{ json: { b: 2, a: 1 } }]);
  });
  it('rejects invalid JSON', async () => {
    await expect(async () => setFields.execute(ctx({ fields: '{bad' }))).rejects.toThrow(/valid JSON/);
  });
  it('resolves {{ }} per item', async () => {
    const out = await setFields.execute(ctx({ fields: '{"u":"user-{{ $json.id }}"}' }, [{ json: { id: 1 } }, { json: { id: 2 } }])) as any;
    expect(out).toEqual([{ json: { id: 1, u: 'user-1' } }, { json: { id: 2, u: 'user-2' } }]);
  });
});

describe('if / filter', () => {
  const items = [{ json: { ok: true } }, { json: { ok: false } }];
  it('if routes to branches', async () => {
    const out: any = await ifNode.execute(ctx({ left: '$json.ok', operator: 'equals', right: 'true' }, items));
    expect(out.branches[0]).toHaveLength(1);
    expect(out.branches[1]).toHaveLength(1);
  });
  it('filter splits keep/drop', async () => {
    const out: any = await filterNode.execute(ctx({ left: '$json.ok', operator: 'equals', right: 'true' }, items));
    expect(out.branches[0]).toHaveLength(1);
    expect(out.branches[1]).toHaveLength(1);
  });
});

describe('switch', () => {
  it('routes by case value with default fallback', async () => {
    const items = [{ json: { s: 'a' } }, { json: { s: 'b' } }, { json: { s: 'zzz' } }];
    const out: any = await switchNode.execute(ctx({ value: '$json.s', case0: 'a', case1: 'b', case2: '' }, items));
    expect(out.branches[0]).toHaveLength(1);
    expect(out.branches[1]).toHaveLength(1);
    expect(out.branches[2]).toHaveLength(1);
  });
});

describe('splitOut / aggregate', () => {
  it('splitOut fans an array field into items', async () => {
    const out: any = await splitOutNode.execute(ctx({ field: '$json.rows' }, [{ json: { rows: [1, 2, 3] } }]));
    expect(out).toHaveLength(3);
  });
  it('aggregate folds items into one', async () => {
    const out: any = await aggregateNode.execute(ctx({ field: 'list' }, [{ json: { n: 1 } }, { json: { n: 2 } }]));
    expect(out).toEqual([{ json: { list: [{ n: 1 }, { n: 2 }], count: 2 } }]);
  });
});

describe('crypto', () => {
  it('hashes with sha256', async () => {
    const out: any = await cryptoNode.execute(ctx({ action: 'sha256', value: '"hello"', field: 'h' }, [{ json: {} }]));
    expect(out[0].json.h).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uuid has valid format', async () => {
    const out: any = await cryptoNode.execute(ctx({ action: 'uuid', field: 'id' }, [{ json: {} }]));
    expect(out[0].json.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('jsonParse', () => {
  it('parses a JSON string field', async () => {
    const out: any = await jsonParseNode.execute(ctx({ field: 'raw' }, [{ json: { raw: '{"a":1}' } }]));
    expect(out[0].json.raw).toEqual({ a: 1 });
  });
  it('throws on invalid json', async () => {
    await expect(async () => jsonParseNode.execute(ctx({ field: 'raw' }, [{ json: { raw: 'nope' } }]))).rejects.toThrow();
  });
});

describe('datetime / wait', () => {
  it('datetime adds iso timestamp', async () => {
    const out: any = await datetimeNode.execute(ctx({ field: 'ts', format: 'iso' }, [{ json: {} }]));
    expect(out[0].json.ts).toMatch(/T/);
  });
  it('wait passes items through', async () => {
    const out: any = await waitNode.execute(ctx({ ms: 1 }, [{ json: { a: 1 } }]));
    expect(out).toEqual([{ json: { a: 1 } }]);
  });
});

describe('registry', () => {
  it('every core node has key, name and execute', () => {
    for (const n of coreNodes) {
      expect(n.key).toBeTruthy();
      expect(n.displayName).toBeTruthy();
      expect(typeof n.execute).toBe('function');
    }
    expect(coreNodes.length).toBeGreaterThanOrEqual(15);
  });
  it('every core node has a category', () => {
    for (const n of coreNodes) {
      expect(nodeCategories[n.key], n.key).toBeTruthy();
    }
  });
  it('every description follows the Action → Output contract', () => {
    for (const n of coreNodes) {
      expect(n.description.length, n.key).toBeGreaterThan(20);
      expect(n.description, n.key).toMatch(/→/);
    }
  });
});

describe('script markers', () => {
  it('pass items through unchanged', async () => {
    const items = [{ json: { a: 1 } }];
    expect(await scriptStart.execute(ctx({ blockId: 'b' }, items))).toEqual(items);
    expect(await scriptEnd.execute(ctx({ blockId: 'b' }, items))).toEqual(items);
  });
});

describe('httpRequest credentials', () => {
  const withServer = async (fn: (url: string, seen: Record<string, string | undefined>) => Promise<void>) => {
    const seen: Record<string, string | undefined> = {};
    const srv = createServer((req, res) => {
      seen.authorization = req.headers.authorization;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => srv.listen(0, r));
    try {
      await fn(`http://127.0.0.1:${(srv.address() as any).port}/x`, seen);
    } finally {
      srv.close();
    }
  };
  it('sends Bearer auth from a resolved credential object', async () => {
    await withServer(async (url, seen) => {
      const out: any = await httpRequest.execute(ctx({ method: 'GET', url, headers: '{}', body: '', credential: { token: 's3cr3t' } }));
      expect(out[0].json.ok).toBe(true);
      expect(seen.authorization).toBe('Bearer s3cr3t');
    });
  });
  it('explicit headers win over the credential', async () => {
    await withServer(async (url, seen) => {
      await httpRequest.execute(ctx({ method: 'GET', url, headers: '{"Authorization":"Basic eA=="}', body: '', credential: { token: 's3cr3t' } }));
      expect(seen.authorization).toBe('Basic eA==');
    });
  });
  it('supports username/password as Basic', async () => {
    await withServer(async (url, seen) => {
      await httpRequest.execute(ctx({ method: 'GET', url, headers: '{}', body: '', credential: { username: 'u', password: 'p' } }));
      expect(seen.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    });
  });
  it('works with no credential at all', async () => {
    await withServer(async (url, seen) => {
      await httpRequest.execute(ctx({ method: 'GET', url, headers: '{}', body: '', credential: '' }));
      expect(seen.authorization).toBeUndefined();
    });
  });
});
