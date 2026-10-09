#!/usr/bin/env node
/**
 * Flowforge MCP server (stdio).
 *
 * Exposes Flowforge to AI agents as tools: browse the node catalog, create and
 * edit workflows, run them, test single nodes, and author custom nodes.
 * Talks to a running Flowforge server over HTTP (FLOWFORGE_URL).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMcpConfig } from '@flowforge/node-sdk';
import { normalizeDefinition, summarizeRun } from './workflow.js';

const BASE = (process.env.FLOWFORGE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function ff<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data as T;
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

/** Node instance as an agent may supply it — ids/positions auto-filled when omitted. */
const NodeInstanceSchema = z.object({
  id: z.string().optional().describe('Unique id within the workflow (auto-assigned n1, n2… if omitted)'),
  type: z.string().describe('Node type key, e.g. "manualTrigger", "httpRequest", "code"'),
  params: z.record(z.any()).optional().describe('Node parameters (see describe_node for the schema)'),
  position: z.object({ x: z.number(), y: z.number() }).optional().describe('Canvas position (auto-laid-out if omitted)'),
});

const EdgeSchema = z.object({
  from: z.string().describe('Source node id'),
  to: z.string().describe('Target node id'),
  fromIndex: z.number().int().min(0).optional().describe('Output branch index for multi-output nodes (If: 0=true, 1=false)'),
});

const server = new McpServer({ name: 'flowforge', version: '0.1.0' });

// Tools disabled on the Settings page are never registered (restart MCP to apply).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const disabledTools = new Set(loadMcpConfig(repoRoot).disabledTools);
type ToolHandler = (args: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
const tool = (name: string, description: string, shape: any, handler: ToolHandler) => {
  if (disabledTools.has(name)) {
    console.error(`[flowforge-mcp] tool disabled by settings: ${name}`);
    return;
  }
  server.tool(name, description, shape, handler);
};

tool(
  'list_nodes',
  'List available node types. Filter by category (triggers, logic, data, code, network, files, flow, custom), kind (trigger, action) or free-text search.',
  { category: z.string().optional(), kind: z.string().optional(), search: z.string().optional() },
  async ({ category, kind, search }) => {
    const nodes: any[] = await ff('/api/nodes');
    const q = search?.toLowerCase();
    return text(nodes
      .filter((n) => !category || (n.category ?? 'other') === category)
      .filter((n) => !kind || n.kind === kind)
      .filter((n) => !q || n.displayName.toLowerCase().includes(q) || n.key.toLowerCase().includes(q) || (n.description ?? '').toLowerCase().includes(q))
      .map((n) => ({ key: n.key, displayName: n.displayName, description: n.description, kind: n.kind, category: n.category, custom: n.custom, outputs: n.outputs?.length ?? 1 })));
  },
);

tool(
  'describe_node',
  'Full schema for one node type: its parameters (key, type, required, defaults, options) plus inputs/outputs. Call this before create_workflow or test_node.',
  { key: z.string().describe('Node type key, e.g. "httpRequest"') },
  async ({ key }) => {
    const nodes: any[] = await ff('/api/nodes');
    const def = nodes.find((n) => n.key === key);
    if (!def) throw new Error(`unknown node: ${key}`);
    return text(def);
  },
);

tool(
  'find_node',
  'Reuse-before-create: find existing nodes matching a plain-language need ("send a slack message", "turn json into rows"). Scored by name/description/category plus real usage across workflows. Call this before create_custom_node.',
  {
    query: z.string().describe('What the node should do, in plain words'),
    kind: z.string().optional().describe('Filter: trigger or action'),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
  },
  async ({ query, kind, category, limit }) => {
    const p = new URLSearchParams({ q: query, limit: String(limit ?? 8) });
    if (kind) p.set('kind', kind);
    if (category) p.set('category', category);
    return text(await ff(`/api/nodes/search?${p}`));
  },
);

tool(
  'list_workflows',
  'List stored workflows (id, name, active flag).',
  {},
  async () => text(await ff('/api/workflows')),
);

tool(
  'get_workflow',
  'Fetch one workflow including its full node/edge definition.',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}`)),
);

tool(
  'create_workflow',
  'Create a workflow. Node ids and canvas positions are optional — omit them for quick drafts. Edge fromIndex selects the output branch on multi-output nodes.',
  {
    name: z.string().describe('Workflow name'),
    nodes: z.array(NodeInstanceSchema).describe('Node instances in execution order'),
    edges: z.array(EdgeSchema).describe('Connections between node ids'),
  },
  async ({ name, nodes, edges }) => text(await ff('/api/workflows', 'POST', { name, definition: normalizeDefinition({ nodes, edges }) })),
);

tool(
  'update_workflow',
  'Replace the definition (and optionally name/active flag) of an existing workflow.',
  {
    id: z.string(),
    name: z.string().optional(),
    nodes: z.array(NodeInstanceSchema).optional(),
    edges: z.array(EdgeSchema).optional(),
    active: z.boolean().optional(),
  },
  async ({ id, name, nodes, edges, active }) => {
    const body: any = {};
    if (name !== undefined) body.name = name;
    if (active !== undefined) body.active = active ? 1 : 0;
    if (nodes !== undefined || edges !== undefined) {
      const current: any = await ff(`/api/workflows/${id}`);
      const cur = current.definition ?? { nodes: [], edges: [] };
      body.definition = normalizeDefinition({
        nodes: nodes ?? cur.nodes.map((n: any) => ({ id: n.id, type: n.type, params: n.params, position: n.position })),
        edges: edges ?? cur.edges,
      });
    }
    return text(await ff(`/api/workflows/${id}`, 'PUT', body));
  },
);

tool(
  'delete_workflow',
  'Delete a workflow and its definition.',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}`, 'DELETE')),
);

tool(
  'run_workflow',
  'Execute a workflow now. Returns per-node status, item counts, a 2-item preview per node, and errors.',
  {
    id: z.string(),
    items: z.array(z.any()).optional().describe('Seed items as [{ json: {...} }] (default: empty)'),
  },
  async ({ id, items }) => text(summarizeRun(await ff(`/api/workflows/${id}/run`, 'POST', { items: items ?? [] }))),
);

tool(
  'test_node',
  'Run a single node type with given params and items. Fast way to validate params before wiring a workflow.',
  {
    key: z.string(),
    params: z.record(z.any()).optional(),
    items: z.array(z.any()).optional().describe('Items as [{ json: {...} }] (default: [{}])'),
  },
  async ({ key, params, items }) => text(await ff(`/api/nodes/${key}/test`, 'POST', { params: params ?? {}, items: items ?? [{ json: {} }] })),
);

tool(
  'create_custom_node',
  'Author a new action node. Call find_node first — only create when nothing fits. Code runs sandboxed with `items` and `params` in scope; return items or `{ branches }`. Saves as draft until examples pass (tested), needs human approval for automatic runs. Fill the docs triple so agents can reuse it.',
  {
    key: z.string().describe('Letters/digits/_ only, must not clash with a built-in'),
    displayName: z.string(),
    description: z.string().optional(),
    category: z.string().optional().describe('Library grouping (default "custom")'),
    properties: z.array(z.any()).optional().describe('Inspector fields: [{ key, displayName, type, default, required }]'),
    code: z.string().describe('JavaScript body, e.g. "return items.map(i => ({ json: i.json }));"'),
    icon: z.string().optional().describe('Emoji or data:image/... URL shown left of the node'),
    docs: z.object({
      action: z.string().optional().describe('Action verb phrase, e.g. "Fetches price of"'),
      target: z.string().optional().describe('Target, e.g. "Bitcoin (CoinGecko)"'),
      output: z.string().optional().describe('Output shape, e.g. "appends btc_price to json"'),
    }).optional().describe('Structured description triple — prefer this over free text. Boosts reuse + search.'),
    permissions: z.object({
      network: z.array(z.string()).optional().describe('Allowlisted hosts, e.g. ["api.example.com"] (code gets fetch)'),
      kv: z.boolean().optional().describe('Private key/value store (code gets kv)'),
      files: z.boolean().optional().describe('Scoped files under data/custom/<key>/ (code gets files)'),
    }).optional().describe('Capabilities granted to the code. Default: none.'),
    examples: z.array(z.any()).optional().describe('Self-test cases: [{ name?, params?, items? }]. All must pass for status "tested".'),
    limits: z.object({
      timeoutMs: z.number().optional().describe('Per-run cap in ms, 1000–30000 (default 10000)'),
      maxItems: z.number().optional().describe('Max output items, 1–10000 (default 10000)'),
    }).optional().describe('Blast-radius caps.'),
    author: z.string().optional().describe('Provenance label, e.g. agent name (default "mcp")'),
  },
  async ({ key, displayName, description, category, properties, code, icon, docs, permissions, examples, limits, author }) =>
    text(await ff('/api/custom-nodes', 'POST', { key, displayName, description: description ?? '', category: category ?? 'custom', properties: properties ?? [], code, icon: icon ?? '', docs: docs ?? {}, permissions: permissions ?? {}, examples: examples ?? [], limits: limits ?? {}, author: author ?? 'mcp' })),
);

tool(
  'delete_custom_node',
  'Delete a UI-created custom node.',
  { key: z.string() },
  async ({ key }) => text(await ff(`/api/custom-nodes/${key}`, 'DELETE')),
);

tool(
  'rollback_custom_node',
  'Roll back a custom node to a previous version (content is re-tested on the way in). List versions via the Library UI or GET /api/custom-nodes/:key/versions.',
  {
    key: z.string(),
    version: z.number().int().describe('Version number to restore'),
    author: z.string().optional().describe('Provenance label (default "mcp")'),
  },
  async ({ key, version, author }) => text(await ff(`/api/custom-nodes/${key}/rollback`, 'POST', { version, author: author ?? 'mcp' })),
);

tool(
  'set_custom_node_enabled',
  'Kill switch: disable a misbehaving custom node (workflows using it refuse to run until re-enabled) or re-enable it.',
  {
    key: z.string(),
    enabled: z.boolean().describe('false disables, true re-enables'),
  },
  async ({ key, enabled }) => text(await ff(`/api/custom-nodes/${key}/enable`, 'POST', { enabled })),
);

tool(
  'export_workflow',
  'Export a workflow as a portable JSON document (share it or store it in git).',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}/export`)),
);

tool(
  'import_workflow',
  'Import a workflow from an export document (or bare { nodes, edges }).',
  { document: z.record(z.any()).describe('Export doc, { name, definition } or { nodes, edges }') },
  async ({ document }) => text(await ff('/api/workflows/import', 'POST', document)),
);

tool(
  'list_executions',
  'Recent execution history, optionally filtered to one workflow.',
  { workflowId: z.string().optional() },
  async ({ workflowId }) => text(await ff(workflowId ? `/api/executions?workflowId=${encodeURIComponent(workflowId)}` : '/api/executions')),
);

tool(
  'get_execution',
  'Full detail for one execution: per-node status, item counts, durations, previews and errors. Use after run_workflow or list_executions.',
  { id: z.string().describe('Execution id, e.g. exec_...') },
  async ({ id }) => text(summarizeRun((await ff(`/api/executions/${encodeURIComponent(id)}`))?.result ?? {})),
);

server.resource(
  'node-catalog',
  'flowforge://nodes-catalog',
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(await ff('/api/nodes')) }],
  }),
);

async function main() {
  // Probe the server before accepting MCP traffic — fail fast with a clear message.
  try {
    await ff('/api/nodes');
  } catch (err) {
    console.error(`[flowforge-mcp] cannot reach Flowforge at ${BASE}: ${(err as Error).message}`);
    console.error('[flowforge-mcp] start it first (pnpm start) or set FLOWFORGE_URL');
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  console.error(`[flowforge-mcp] serving Flowforge at ${BASE}`);
}

main().catch((err) => {
  console.error(`[flowforge-mcp] fatal: ${(err as Error).message}`);
  process.exit(1);
});
