import { defineNode } from '@flowforge/node-sdk';

/** Notion API integration (v2022-06-25): create pages, append blocks, query
 *  databases. One call per input item; JSON params are {{ }}-aware.
 *  Auth comes from a resolved credential ({ token }).
 */
export const NOTION_DEFAULT_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2022-06-25';

type Op = 'create_page' | 'append_blocks' | 'query_database';

function authHeader(cred: unknown): string {
  if (cred && typeof cred === 'object' && typeof (cred as any).token === 'string' && (cred as any).token) {
    return `Bearer ${(cred as any).token}`;
  }
  return '';
}

export const notionNode = defineNode({
  key: 'notion',
  displayName: 'Notion',
  description: 'Writes and reads Notion (create pages, append blocks, query databases) → one response item per input item.',
  version: 1,
  kind: 'action',
  icon: 'braces',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      key: 'operation', displayName: 'Operation', type: 'options', default: 'query_database',
      options: [
        { name: 'Query database', value: 'query_database' },
        { name: 'Create page', value: 'create_page' },
        { name: 'Append blocks', value: 'append_blocks' },
      ],
    },
    { key: 'credential', displayName: 'Credential', type: 'credential', default: '', credentialType: 'token', description: 'Notion integration token from Settings → Credentials' },
    { key: 'target_id', displayName: 'Database / page ID', type: 'string', required: true, default: '', description: 'Database id (query/create-in-db) or page id (create-in-page/append)' },
    {
      key: 'parent_type', displayName: 'Create in (create op)', type: 'options', default: 'database',
      options: [{ name: 'Database', value: 'database' }, { name: 'Page', value: 'page' }],
    },
    { key: 'properties', displayName: 'Properties (JSON, create op)', type: 'json', default: '{}', description: '{{ }}-aware Notion properties object' },
    { key: 'children', displayName: 'Blocks (JSON array, create/append)', type: 'json', default: '[]', description: '{{ }}-aware Notion block children' },
    { key: 'page_size', displayName: 'Page size (query op, max 100)', type: 'number', default: 20 },
    { key: 'baseUrl', displayName: 'API base URL', type: 'string', default: NOTION_DEFAULT_BASE },
  ],
  async execute(ctx) {
    const p = ctx.params as any;
    const op = String(p.operation ?? 'query_database') as Op;
    if (!['create_page', 'append_blocks', 'query_database'].includes(op)) {
      throw ctx.error(`unknown Notion operation "${op}"`);
    }
    const auth = authHeader(p.credential);
    if (!auth) throw ctx.error('a Notion credential ({ token }) is required');
    const target = String(p.target_id ?? '').replace(/-/g, '');
    if (!target) throw ctx.error('target_id (database or page ID) is required');
    const base = String(p.baseUrl ?? NOTION_DEFAULT_BASE).replace(/\/$/, '') || NOTION_DEFAULT_BASE;
    const headers = { Accept: 'application/json', 'Notion-Version': NOTION_VERSION, Authorization: auth };

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: any;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        const msg = typeof data?.message === 'string' ? data.message : text.slice(0, 200);
        throw ctx.error(`Notion ${op} failed: ${res.status} ${msg}`);
      }
      return data;
    };

    const asJson = (raw: unknown, what: string) => {
      try {
        const v = JSON.parse(String(raw ?? (what === 'blocks' ? '[]' : '{}')));
        return v;
      } catch { throw ctx.error(`${what} must be valid JSON (after resolving expressions)`); }
    };

    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const out: any[] = [];
    for (const item of items) {
      if (op === 'query_database') {
        const pageSize = Math.min(Math.max(Number(p.page_size ?? 20) || 20, 1), 100);
        const data = await call('POST', `/databases/${target}/query`, { page_size: pageSize });
        out.push({ json: { operation: op, results: data?.results ?? [], has_more: !!data?.has_more } });
      } else if (op === 'create_page') {
        const parentType = String(p.parent_type ?? 'database');
        const properties = asJson(ctx.expr(String(p.properties ?? '{}'), item), 'properties');
        const children = asJson(ctx.expr(String(p.children ?? '[]'), item), 'blocks');
        if (!Array.isArray(children)) throw ctx.error('children must be a JSON array of blocks');
        const data = await call('POST', '/pages', {
          parent: parentType === 'page' ? { page_id: target } : { database_id: target },
          properties,
          ...(children.length ? { children } : {}),
        });
        out.push({ json: { operation: op, id: data?.id, url: data?.url, page: data } });
      } else {
        const children = asJson(ctx.expr(String(p.children ?? '[]'), item), 'blocks');
        if (!Array.isArray(children) || children.length === 0) throw ctx.error('children must be a non-empty JSON array of blocks');
        const data = await call('PATCH', `/blocks/${target}/children`, { children });
        out.push({ json: { operation: op, results: data?.results ?? [] } });
      }
    }
    return out;
  },
});
