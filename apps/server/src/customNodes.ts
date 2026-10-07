import vm from 'node:vm';
import type { NodeDefinition, NodeExecuteContext, NodeProperty, FlowItem } from '@flowforge/node-sdk';
import { db, CustomNodeRow } from './db.js';
import { createCapabilities, normalizePermissions, NodePermissions, KvStore, EMPTY_PERMISSIONS } from './capabilities.js';

export type { NodePermissions };
export { normalizePermissions };

export const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const MAX_KEY_LEN = 48;

const PROP_TYPES = new Set(['string', 'number', 'boolean', 'options', 'collection', 'json', 'code']);

export interface CustomNodeInput {
  key: string;
  displayName: string;
  description?: string;
  category?: string;
  properties?: NodeProperty[];
  code: string;
  /** Emoji/short text or a data:image/... URL (≤200KB). Shown left of the node. */
  icon?: string;
}

/** Validate a custom-node payload. Throws on the first problem. Returns normalized input. */
export function validateCustomNode(body: unknown): { key: string; displayName: string; description: string; category: string; properties: NodeProperty[]; code: string; icon: string; permissions: NodePermissions } {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const b = body as any;
  const key = String(b.key ?? '');
  if (!KEY_RE.test(key) || key.length > MAX_KEY_LEN) {
    throw new Error('key must start with a letter and contain only letters, digits, _ (max 48)');
  }
  const displayName = String(b.displayName ?? '').trim();
  if (!displayName) throw new Error('displayName is required');
  const code = String(b.code ?? '');
  if (!code.trim()) throw new Error('code is required');
  const properties = b.properties ?? [];
  if (!Array.isArray(properties)) throw new Error('properties must be an array');
  for (const [i, p] of properties.entries()) {
    if (!p || typeof p.key !== 'string' || !p.key) throw new Error(`properties[${i}].key is required`);
    if (typeof p.displayName !== 'string' || !p.displayName) throw new Error(`properties[${i}].displayName is required`);
    if (!PROP_TYPES.has(p.type)) throw new Error(`properties[${i}].type must be one of ${[...PROP_TYPES].join(', ')}`);
  }
  const icon = b.icon === undefined || b.icon === null ? '' : String(b.icon);
  if (icon.length > 200_000) throw new Error('icon is too large (max ~200KB)');
  if (icon && !icon.startsWith('data:image/') && [...icon].length > 16) {
    throw new Error('icon must be an emoji/short label or an uploaded image');
  }
  return {
    key,
    displayName,
    description: String(b.description ?? ''),
    category: String(b.category ?? 'custom') || 'custom',
    properties: properties as NodeProperty[],
    code,
    icon,
    permissions: normalizePermissions(b.permissions),
  };
}

/**
 * Run user-supplied node code in a sandbox. Same contract as the Code node
 * (`items`, `params` in scope; return items or `{ branches }`), plus declared
 * capabilities: `fetch` (allowlisted hosts), `kv`, `files`. May await.
 */
export async function runCustomCode(
  code: string,
  ctx: Pick<NodeExecuteContext, 'items' | 'params'>,
  capsOpts: {
    nodeKey?: string;
    permissions?: NodePermissions;
    fetchImpl?: typeof fetch;
    dnsLookup?: (host: string) => Promise<string[]>;
    kvStore?: KvStore;
    filesRoot?: string;
  } = {},
): Promise<unknown> {
  const { nodeKey = 'adhoc', permissions = EMPTY_PERMISSIONS, ...rest } = capsOpts;
  const caps = createCapabilities({ nodeKey, permissions, ...rest });
  const sandbox = { items: ctx.items, params: ctx.params, console, fetch: caps.fetch, kv: caps.kv, files: caps.files };
  const wrapped = `(async function(){ ${code} })()`;
  const result = new vm.Script(wrapped).runInNewContext(sandbox, { timeout: 5000 });
  const out = result && typeof result.then === 'function'
    ? await Promise.race([
        result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Code timed out after 10000ms')), 10_000)),
      ])
    : result;
  if (out && typeof out === 'object' && Array.isArray((out as any).branches)) {
    const branches = (out as any).branches as unknown[];
    for (const [i, b] of branches.entries()) {
      if (!Array.isArray(b)) throw new Error(`branches[${i}] must be an array`);
    }
    return { branches: (branches as FlowItem[][]).map((arr) => arr.map((r: any) => (r && r.json ? r : { json: r }))) };
  }
  if (!Array.isArray(out)) throw new Error('Code must return an array of items (or { branches: [...] })');
  return (out as any[]).map((r: any) => (r && r.json ? r : { json: r }));
}

export function parseRowPermissions(row: CustomNodeRow): NodePermissions {
  try { return normalizePermissions(JSON.parse(row.permissions ?? '{}')); }
  catch { return { ...EMPTY_PERMISSIONS }; }
}

export function rowToDefinition(row: CustomNodeRow): NodeDefinition {
  let properties: NodeProperty[] = [];
  try {
    const parsed = JSON.parse(row.properties);
    if (Array.isArray(parsed)) properties = parsed;
  } catch { /* treat as [] */ }
  const code = row.code;
  const permissions = parseRowPermissions(row);
  return {
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    version: 1,
    kind: 'action',
    category: row.category || 'custom',
    icon: row.icon || 'puzzle',
    inputs: ['main'],
    outputs: ['main'],
    properties,
    async execute(ctx) {
      try {
        return await runCustomCode(code, ctx, { nodeKey: row.key, permissions }) as any;
      } catch (err) {
        throw ctx.error((err as Error).message);
      }
    },
  };
}

export function listCustomNodeRows(): CustomNodeRow[] {
  return db.prepare('SELECT * FROM custom_nodes ORDER BY display_name').all() as unknown as CustomNodeRow[];
}

export function loadCustomNodes(): NodeDefinition[] {
  return listCustomNodeRows().map(rowToDefinition);
}
