import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { notionNode } from './notion.js';

const ctx = (params: any, items: any[] = [{ json: { t: 'Hello' } }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (respond: { status: number; payload: unknown }) => {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const text = JSON.stringify(respond.payload);
    return { ok: respond.status >= 200 && respond.status < 300, status: respond.status, text: async () => text };
  });
  return calls;
};

const BASE = 'https://api.notion.test/v1';
const cred = { token: 'secret_notion' };

describe('notion node', () => {
  it('queries a database with version + auth headers', async () => {
    const calls = stubFetch({ status: 200, payload: { results: [{ id: 'p1' }], has_more: false } });
    const out: any = await notionNode.execute(ctx({ operation: 'query_database', credential: cred, target_id: 'db1', page_size: 20, baseUrl: BASE }));
    expect(calls[0].url).toBe(`${BASE}/databases/db1/query`);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'Notion-Version': '2022-06-25', Authorization: 'Bearer secret_notion' });
    expect(out[0].json.results).toHaveLength(1);
  });

  it('creates a page with resolved properties and children', async () => {
    const calls = stubFetch({ status: 200, payload: { id: 'new', url: 'https://n/new' } });
    const out: any = await notionNode.execute(ctx({
      operation: 'create_page', credential: cred, target_id: 'db1', parent_type: 'database',
      properties: '{"Name":{"title":[{"text":{"content":"{{ $json.t }}"}}]}}',
      children: '[{"object":"block","type":"paragraph","paragraph":{"rich_text":[{"text":{"content":"hi"}}]}}]',
      baseUrl: BASE,
    }));
    const body = JSON.parse(calls[0].init.body);
    expect(body.parent).toEqual({ database_id: 'db1' });
    expect(body.properties.Name.title[0].text.content).toBe('Hello');
    expect(body.children).toHaveLength(1);
    expect(out[0].json.id).toBe('new');
  });

  it('appends blocks via PATCH and requires non-empty children', async () => {
    const calls = stubFetch({ status: 200, payload: { results: [{ id: 'b1' }] } });
    const out: any = await notionNode.execute(ctx({
      operation: 'append_blocks', credential: cred, target_id: 'page9',
      children: '[{"object":"block","type":"paragraph","paragraph":{"rich_text":[]}}]',
      baseUrl: BASE,
    }));
    expect(calls[0].url).toBe(`${BASE}/blocks/page9/children`);
    expect(calls[0].init.method).toBe('PATCH');
    expect(out[0].json.results).toHaveLength(1);
    await expect(notionNode.execute(ctx({ operation: 'append_blocks', credential: cred, target_id: 'page9', children: '[]', baseUrl: BASE })))
      .rejects.toThrow(/non-empty/);
  });

  it('requires credential + target before network and maps API errors', async () => {
    const calls = stubFetch({ status: 200, payload: {} });
    await expect(notionNode.execute(ctx({ operation: 'query_database', target_id: 'db', baseUrl: BASE }))).rejects.toThrow(/credential/);
    await expect(notionNode.execute(ctx({ operation: 'query_database', credential: cred, target_id: '', baseUrl: BASE }))).rejects.toThrow(/target_id/);
    expect(calls).toHaveLength(0);
    stubFetch({ status: 401, payload: { message: 'API token is invalid.' } });
    await expect(notionNode.execute(ctx({ operation: 'query_database', credential: cred, target_id: 'db', baseUrl: BASE })))
      .rejects.toThrow(/401 API token is invalid/);
  });
});
