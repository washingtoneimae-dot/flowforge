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

server.tool(
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

server.tool(
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

server.tool(
  'list_workflows',
  'List stored workflows (id, name, active flag).',
  {},
  async () => text(await ff('/api/workflows')),
);

server.tool(
  'get_workflow',
  'Fetch one workflow including its full node/edge definition.',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}`)),
);

server.tool(
  'create_workflow',
  'Create a workflow. Node ids and canvas positions are optional — omit them for quick drafts. Edge fromIndex selects the output branch on multi-output nodes.',
  {
    name: z.string().describe('Workflow name'),
    nodes: z.array(NodeInstanceSchema).describe('Node instances in execution order'),
    edges: z.array(EdgeSchema).describe('Connections between node ids'),
  },
  async ({ name, nodes, edges }) => text(await ff('/api/workflows', 'POST', { name, definition: normalizeDefinition({ nodes, edges }) })),
);

server.tool(
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

server.tool(
  'delete_workflow',
  'Delete a workflow and its definition.',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}`, 'DELETE')),
);

server.tool(
  'run_workflow',
  'Execute a workflow now. Returns per-node status, item counts, a 2-item preview per node, and errors.',
  {
    id: z.string(),
    items: z.array(z.any()).optional().describe('Seed items as [{ json: {...} }] (default: empty)'),
  },
  async ({ id, items }) => text(summarizeRun(await ff(`/api/workflows/${id}/run`, 'POST', { items: items ?? [] }))),
);

server.tool(
  'test_node',
  'Run a single node type with given params and items. Fast way to validate params before wiring a workflow.',
  {
    key: z.string(),
    params: z.record(z.any()).optional(),
    items: z.array(z.any()).optional().describe('Items as [{ json: {...} }] (default: [{}])'),
  },
  async ({ key, params, items }) => text(await ff(`/api/nodes/${key}/test`, 'POST', { params: params ?? {}, items: items ?? [{ json: {} }] })),
);

server.tool(
  'create_custom_node',
  'Author a new action node. Code runs sandboxed with `items` and `params` in scope; return items or `{ branches }`. Usable in workflows immediately under `key`.',
  {
    key: z.string().describe('Letters/digits/_ only, must not clash with a built-in'),
    displayName: z.string(),
    description: z.string().optional(),
    category: z.string().optional().describe('Library grouping (default "custom")'),
    properties: z.array(z.any()).optional().describe('Inspector fields: [{ key, displayName, type, default, required }]'),
    code: z.string().describe('JavaScript body, e.g. "return items.map(i => ({ json: i.json }));"'),
  },
  async ({ key, displayName, description, category, properties, code }) =>
    text(await ff('/api/custom-nodes', 'POST', { key, displayName, description: description ?? '', category: category ?? 'custom', properties: properties ?? [], code })),
);

server.tool(
  'delete_custom_node',
  'Delete a UI-created custom node.',
  { key: z.string() },
  async ({ key }) => text(await ff(`/api/custom-nodes/${key}`, 'DELETE')),
);

server.tool(
  'export_workflow',
  'Export a workflow as a portable JSON document (share it or store it in git).',
  { id: z.string() },
  async ({ id }) => text(await ff(`/api/workflows/${id}/export`)),
);

server.tool(
  'import_workflow',
  'Import a workflow from an export document (or bare { nodes, edges }).',
  { document: z.record(z.any()).describe('Export doc, { name, definition } or { nodes, edges }') },
  async ({ document }) => text(await ff('/api/workflows/import', 'POST', document)),
);

server.tool(
  'list_executions',
  'Recent execution history, optionally filtered to one workflow.',
  { workflowId: z.string().optional() },
  async ({ workflowId }) => text(await ff(workflowId ? `/api/executions?workflowId=${encodeURIComponent(workflowId)}` : '/api/executions')),
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
