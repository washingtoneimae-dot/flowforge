import vm from 'node:vm';
import type { NodeDefinition, NodeExecuteContext, NodeProperty, FlowItem } from '@flowforge/node-sdk';
import { db, CustomNodeRow, CustomNodeVersionRow } from './db.js';
import { createCapabilities, normalizePermissions, NodePermissions, KvStore, EMPTY_PERMISSIONS } from './capabilities.js';

export type { NodePermissions };
export { normalizePermissions };

export type TrustStatus = 'draft' | 'tested' | 'approved';

export interface NodeLimits {
  /** Per-execution async cap, ms (1000–30000, default 10000). */
  timeoutMs?: number;
  /** Max output items; exceeded → error (1–10000, default 10000). */
  maxItems?: number;
}

export function normalizeLimits(input: unknown): { timeoutMs: number; maxItems: number } {
  if (input === undefined || input === null) return { timeoutMs: 10_000, maxItems: 10_000 };
  if (typeof input !== 'object') throw new Error('limits must be an object');
  const l = input as any;
  const timeoutMs = l.timeoutMs === undefined ? 10_000 : Number(l.timeoutMs);
  const maxItems = l.maxItems === undefined ? 10_000 : Number(l.maxItems);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new Error('limits.timeoutMs must be 1000–30000');
  }
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10_000) {
    throw new Error('limits.maxItems must be 1–10000');
  }
  return { timeoutMs, maxItems };
}

export interface NodeExample {
  name?: string;
  params?: Record<string, unknown>;
  items?: Array<{ json: Record<string, unknown> }>;
}

export function normalizeExamples(input: unknown): NodeExample[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('examples must be an array');
  if (input.length > 20) throw new Error('examples allows at most 20 cases');
  return input.map((e, i) => {
    if (!e || typeof e !== 'object') throw new Error(`examples[${i}] must be an object`);
    const items = (e as any).items ?? [{ json: {} }];
    if (!Array.isArray(items)) throw new Error(`examples[${i}].items must be an array`);
    return {
      name: typeof (e as any).name === 'string' ? (e as any).name : `case ${i + 1}`,
      params: (e as any).params && typeof (e as any).params === 'object' ? (e as any).params : {},
      items: items.map((it: any) => (it && typeof it.json === 'object' ? { json: it.json } : { json: {} })),
    };
  });
}

export interface ExampleResult {
  name: string;
  ok: boolean;
  items?: number;
  error?: string;
}

/** Run the declared examples. Pass = executes without error. */
export async function runExamples(
  code: string,
  examples: NodeExample[],
  caps: { nodeKey: string; permissions: NodePermissions },
): Promise<ExampleResult[]> {
  const out: ExampleResult[] = [];
  for (const ex of examples) {
    try {
      const r: any = await runCustomCode(code, { items: ex.items ?? [{ json: {} }], params: ex.params ?? {} }, caps);
      const count = Array.isArray(r) ? r.length : (r?.branches ?? []).reduce((n: number, b: unknown[]) => n + b.length, 0);
      out.push({ name: ex.name ?? 'case', ok: true, items: count });
    } catch (err) {
      out.push({ name: ex.name ?? 'case', ok: false, error: (err as Error).message });
    }
  }
  return out;
}

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
export function validateCustomNode(body: unknown): { key: string; displayName: string; description: string; category: string; properties: NodeProperty[]; code: string; icon: string; permissions: NodePermissions; examples: NodeExample[]; limits: { timeoutMs: number; maxItems: number }; author: string } {
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
  const author = String((b as any).author ?? 'human').trim().slice(0, 64) || 'human';
  return {
    key,
    displayName,
    description: String(b.description ?? ''),
    category: String(b.category ?? 'custom') || 'custom',
    properties: properties as NodeProperty[],
    code,
    icon,
    permissions: normalizePermissions(b.permissions),
    examples: normalizeExamples((b as any).examples),
    limits: normalizeLimits((b as any).limits),
    author,
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
    limits?: { timeoutMs?: number; maxItems?: number };
    fetchImpl?: typeof fetch;
    dnsLookup?: (host: string) => Promise<string[]>;
    kvStore?: KvStore;
    filesRoot?: string;
  } = {},
): Promise<unknown> {
  const { nodeKey = 'adhoc', permissions = EMPTY_PERMISSIONS, limits, ...rest } = capsOpts;
  const { timeoutMs, maxItems } = normalizeLimits(limits ?? undefined);
  const caps = createCapabilities({ nodeKey, permissions, ...rest });
  const sandbox = { items: ctx.items, params: ctx.params, console, fetch: caps.fetch, kv: caps.kv, files: caps.files };
  const wrapped = `(async function(){ ${code} })()`;
  const result = new vm.Script(wrapped).runInNewContext(sandbox, { timeout: 5000 });
  const out = result && typeof result.then === 'function'
    ? await Promise.race([
        result,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Code timed out after ${timeoutMs}ms`)), timeoutMs)),
      ])
    : result;
  if (out && typeof out === 'object' && Array.isArray((out as any).branches)) {
    const branches = (out as any).branches as unknown[];
    for (const [i, b] of branches.entries()) {
      if (!Array.isArray(b)) throw new Error(`branches[${i}] must be an array`);
    }
    const mapped = (branches as FlowItem[][]).map((arr) => arr.map((r: any) => (r && r.json ? r : { json: r })));
    const total = mapped.reduce((n, b) => n + b.length, 0);
    if (total > maxItems) throw new Error(`Code returned ${total} items (limit: ${maxItems})`);
    return { branches: mapped };
  }
  if (!Array.isArray(out)) throw new Error('Code must return an array of items (or { branches: [...] })');
  const items = (out as any[]).map((r: any) => (r && r.json ? r : { json: r }));
  if (items.length > maxItems) throw new Error(`Code returned ${items.length} items (limit: ${maxItems})`);
  return items;
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
  const limits = (() => { try { return normalizeLimits(JSON.parse(row.limits ?? '{}')); } catch { return normalizeLimits(undefined); } })();
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
        return await runCustomCode(code, ctx, { nodeKey: row.key, permissions, limits }) as any;
      } catch (err) {
        throw ctx.error((err as Error).message);
      }
    },
  };
}

export function listCustomNodeRows(): CustomNodeRow[] {
  return db.prepare('SELECT * FROM custom_nodes ORDER BY display_name').all() as unknown as CustomNodeRow[];
}

export function getCustomNodeRow(key: string): CustomNodeRow | undefined {
  return db.prepare('SELECT * FROM custom_nodes WHERE key=?').get(key) as unknown as CustomNodeRow | undefined;
}

export function rowToApi(r: CustomNodeRow) {
  const safe = (raw: string | null, fallback: unknown) => {
    try { return JSON.parse(raw ?? ''); } catch { return fallback; }
  };
  return {
    key: r.key, displayName: r.display_name, description: r.description,
    category: r.category, properties: safe(r.properties, []), code: r.code, icon: r.icon ?? '',
    permissions: safe(r.permissions, {}), examples: safe(r.examples, []),
    limits: safe(r.limits, {}), status: r.status ?? 'draft', author: r.author ?? 'human',
    version: r.version ?? 1, disabled: (r.disabled ?? 0) === 1,
    testReport: safe(r.test_report, null),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

type ValidatedNode = ReturnType<typeof validateCustomNode>;

function contentFingerprint(v: ValidatedNode): string {
  return JSON.stringify({ code: v.code, properties: v.properties, permissions: v.permissions, examples: v.examples, limits: v.limits });
}

function rowFingerprint(r: CustomNodeRow): string {
  return JSON.stringify({
    code: r.code,
    properties: (() => { try { return JSON.parse(r.properties); } catch { return []; } })(),
    permissions: parseRowPermissions(r),
    examples: (() => { try { return JSON.parse(r.examples); } catch { return []; } })(),
    limits: (() => { try { return normalizeLimits(JSON.parse(r.limits)); } catch { return normalizeLimits(undefined); } })(),
  });
}

export interface SaveResult {
  key: string;
  version: number;
  status: TrustStatus;
  report: ExampleResult[] | null;
}

/**
 * Save a custom node with versioning + self-test ladder:
 * content change → new version → examples run → 'tested' (all pass) or 'draft'.
 * Metadata-only edits keep status and version.
 */
export async function saveCustomNode(v: ValidatedNode): Promise<SaveResult> {
  const now = new Date().toISOString();
  const existing = getCustomNodeRow(v.key);
  if (existing && rowFingerprint(existing) === contentFingerprint(v)) {
    db.prepare('UPDATE custom_nodes SET display_name=?,description=?,category=?,icon=?,author=?,updated_at=? WHERE key=?')
      .run(v.displayName, v.description, v.category, v.icon, v.author, now, v.key);
    return { key: v.key, version: existing.version, status: (existing.status ?? 'draft') as TrustStatus, report: null };
  }
  const version = (existing?.version ?? 0) + 1;
  const report = await runExamples(v.code, v.examples, { nodeKey: v.key, permissions: v.permissions });
  const status: TrustStatus = v.examples.length > 0 && report.every((r) => r.ok) ? 'tested' : 'draft';
  db.prepare(`INSERT OR REPLACE INTO custom_nodes
    (key,display_name,description,category,properties,code,icon,permissions,examples,limits,status,author,version,test_report,disabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT created_at FROM custom_nodes WHERE key=?),?),?)`)
    .run(v.key, v.displayName, v.description, v.category, JSON.stringify(v.properties), v.code, v.icon,
      JSON.stringify(v.permissions), JSON.stringify(v.examples), JSON.stringify(v.limits),
      status, v.author, version, report.length ? JSON.stringify(report) : null,
      existing?.disabled ?? 0, v.key, existing?.created_at ?? now, now);
  db.prepare(`INSERT INTO custom_node_versions
    (key,version,display_name,description,category,properties,code,icon,permissions,examples,limits,status,author,test_report,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(v.key, version, v.displayName, v.description, v.category, JSON.stringify(v.properties), v.code, v.icon,
      JSON.stringify(v.permissions), JSON.stringify(v.examples), JSON.stringify(v.limits),
      status, v.author, report.length ? JSON.stringify(report) : null, now);
  return { key: v.key, version, status, report: report.length ? report : null };
}

/** Roll back to a previous version's content (re-tested on the way in). */
export async function rollbackCustomNode(key: string, version: number, author: string): Promise<SaveResult> {
  const snap = db.prepare('SELECT * FROM custom_node_versions WHERE key=? AND version=?').get(key, version) as unknown as CustomNodeVersionRow | undefined;
  if (!snap) throw new Error(`no version ${version} for "${key}"`);
  return saveCustomNode(validateCustomNode({
    key: snap.key,
    displayName: snap.display_name,
    description: snap.description,
    category: snap.category,
    properties: JSON.parse(snap.properties),
    code: snap.code,
    icon: snap.icon,
    permissions: JSON.parse(snap.permissions),
    examples: JSON.parse(snap.examples),
    limits: JSON.parse(snap.limits),
    author,
  }));
}

/** Human gate: tested → approved. Only approved nodes run on automatic triggers. */
export function approveCustomNode(key: string, by: string): CustomNodeRow {
  const row = getCustomNodeRow(key);
  if (!row) throw new Error(`unknown custom node: ${key}`);
  if ((row.disabled ?? 0) === 1) throw new Error(`"${key}" is disabled`);
  if ((row.status ?? 'draft') !== 'tested') throw new Error(`"${key}" must pass its self-test first (status: ${row.status ?? 'draft'})`);
  db.prepare('UPDATE custom_nodes SET status=?,author=?,updated_at=? WHERE key=?')
    .run('approved', by.slice(0, 64) || 'human', new Date().toISOString(), key);
  return getCustomNodeRow(key)!;
}

export function setCustomNodeEnabled(key: string, enabled: boolean): CustomNodeRow {
  const row = getCustomNodeRow(key);
  if (!row) throw new Error(`unknown custom node: ${key}`);
  db.prepare('UPDATE custom_nodes SET disabled=?,updated_at=? WHERE key=?')
    .run(enabled ? 0 : 1, new Date().toISOString(), key);
  return getCustomNodeRow(key)!;
}

export interface TrustReport {
  draft: string[];
  tested: string[];
  disabled: string[];
}

/** Which custom node keys in a workflow are not fully trusted. */
export function checkCustomTrust(types: string[]): TrustReport {
  const report: TrustReport = { draft: [], tested: [], disabled: [] };
  const uniq = [...new Set(types)];
  for (const key of uniq) {
    const row = getCustomNodeRow(key);
    if (!row) continue; // unknown types are reported by the engine
    if ((row.disabled ?? 0) === 1) { report.disabled.push(key); continue; }
    const status = (row.status ?? 'draft') as TrustStatus;
    if (status === 'draft') report.draft.push(key);
    else if (status === 'tested') report.tested.push(key);
  }
  return report;
}

export function loadCustomNodes(): NodeDefinition[] {
  return listCustomNodeRows().map(rowToDefinition);
}
