import express from 'express';
import { db, WorkflowRow, ExecutionRow } from './db.js';
import { nodeRegistry, resolveNode, isCustomNode, categoryOf, refreshCustomNodes } from './registry.js';
import { validateCustomNode, runCustomCode, listCustomNodeRows, normalizePermissions, parseRowPermissions, parseRowDocs, saveCustomNode, rollbackCustomNode, approveCustomNode, setCustomNodeEnabled, checkCustomTrust, rowToApi, getCustomNodeRow, refreshUsageScores } from './customNodes.js';
import { searchNodes, workflowUsage } from './nodeSearch.js';
import { contractLine } from './reusability.js';
import { resolveRoot, listFiles, importFiles } from './files.js';
import { evaluateExpression } from '@flowforge/engine';
import { loadMcpConfig, saveMcpConfig, mcpDistExists, MCP_TOOL_NAMES } from '@flowforge/node-sdk';
import { toExportDoc, parseImportDoc } from './workflowIo.js';
import { diffDefinitions } from './workflowDiff.js';
import { shouldFireCron, cronMinuteKey } from './cron.js';
import { watchRoots, resolveWatchDir, clampDebounce, FileWatcher } from './filewatch.js';
import { ApprovalStore } from './approvals.js';
import {
  getCredKey, encryptFields, validateCredentialInput,
  listCredentials, insertCredential, updateCredential, deleteCredential,
  getCredentialFields, resolveCredentialRefs,
} from './credentials.js';
import { setApprovalHandler } from '@flowforge/nodes-core';
import { executeWorkflow, Workflow } from '@flowforge/engine';
import { mkdirSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const jsonSmall = express.json({ limit: '2mb' });
app.use((req, res, next) => {
  // Large uploads carry their own limit on the route below.
  if (req.path === '/api/files/import') return next();
  return jsonSmall(req, res, next);
});

// Repo root (server runs from apps/server/dist or apps/server/src).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Credentials: AES-256-GCM via explicit FLOWFORGE_CRED_KEY or a machine-local
// data/.credkey (0600, auto-created). Fail fast on a corrupt explicit key.
let credKey: Buffer;
try {
  credKey = getCredKey(repoRoot);
} catch (e) {
  console.error(`[flowforge] bad credential key: ${(e as Error).message}`);
  process.exit(1);
}

function mcpSettings() {
  const config = loadMcpConfig(repoRoot);
  const distAbs = join(repoRoot, 'apps', 'mcp', 'dist', 'index.js');
  return {
    built: mcpDistExists(repoRoot),
    distPath: distAbs,
    command: 'node',
    args: [distAbs],
    flowforgeUrl: config.flowforgeUrl,
    disabledTools: config.disabledTools,
    tools: MCP_TOOL_NAMES.map((name) => ({ name, enabled: !config.disabledTools.includes(name) })),
  };
}

app.get('/api/settings/mcp', (_req, res) => {
  res.json(mcpSettings());
});

app.put('/api/settings/mcp', (req, res) => {
  try {
    const current = loadMcpConfig(repoRoot);
    const saved = saveMcpConfig(repoRoot, {
      flowforgeUrl: typeof req.body?.flowforgeUrl === 'string' ? req.body.flowforgeUrl : current.flowforgeUrl,
      disabledTools: Array.isArray(req.body?.disabledTools) ? req.body.disabledTools : current.disabledTools,
    });
    res.json({ ...mcpSettings(), flowforgeUrl: saved.flowforgeUrl, disabledTools: saved.disabledTools });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

const id = () => `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

app.get('/api/nodes', (_req, res) => {
  res.json([...nodeRegistry.values()].map((n) => ({
    key: n.key, displayName: n.displayName, description: n.description,
    kind: n.kind, icon: n.icon, version: n.version, category: categoryOf(n),
    custom: isCustomNode(n.key),
    trust: isCustomNode(n.key) ? (() => {
      const r = getCustomNodeRow(n.key);
      if (!r) return undefined;
      let reuse: any = null;
      try { reuse = r.reusability ? JSON.parse(r.reusability) : null; } catch { /* ignore */ }
      return {
        status: r.status ?? 'draft', author: r.author ?? 'human', version: r.version ?? 1,
        disabled: (r.disabled ?? 0) === 1,
        contract: contractLine(parseRowDocs(r)) || undefined,
        reusability: reuse ? { score: reuse.score, grade: reuse.grade } : undefined,
      };
    })() : undefined,
    inputs: n.inputs, outputs: n.outputs, properties: n.properties,
  })));
});

app.get('/api/nodes/search', (req, res) => {
  const q = String(req.query.q ?? '');
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  const category = req.query.category ? String(req.query.category) : undefined;
  const limit = Math.max(1, Math.min(Number(req.query.limit ?? 8) || 8, 25));
  const catalog = [...nodeRegistry.values()]
    .filter((n) => !kind || n.kind === kind)
    .filter((n) => !category || categoryOf(n) === category)
    .map((n) => {
      const base = { key: n.key, displayName: n.displayName, description: n.description ?? '', category: categoryOf(n), kind: n.kind, custom: isCustomNode(n.key) };
      if (!isCustomNode(n.key)) return base;
      const row = getCustomNodeRow(n.key);
      if (!row) return base;
      const docs = parseRowDocs(row);
      let reuse: any = null;
      try { reuse = row.reusability ? JSON.parse(row.reusability) : null; } catch { /* ignore */ }
      return {
        ...base,
        contract: contractLine(docs) || undefined,
        reuseScore: typeof reuse?.score === 'number' ? reuse.score : undefined,
        reuseGrade: typeof reuse?.grade === 'string' ? reuse.grade : undefined,
      };
    });
  const rows = db.prepare('SELECT definition FROM workflows').all() as unknown as Array<{ definition: string }>;
  const defs = rows.map((r) => { try { return JSON.parse(r.definition); } catch { return { nodes: [] }; } });
  res.json(searchNodes(q, catalog, workflowUsage(defs), limit));
});

// ---- custom nodes (created in the Library UI, stored in SQLite) ----

app.get('/api/custom-nodes', (_req, res) => {
  res.json(listCustomNodeRows().map(rowToApi));
});

app.get('/api/custom-nodes/:key/versions', (req, res) => {
  const rows = db.prepare('SELECT key,version,display_name,description,status,author,test_report,created_at FROM custom_node_versions WHERE key=? ORDER BY version DESC').all(req.params.key);
  res.json(rows);
});

app.post('/api/custom-nodes', async (req, res) => {
  try {
    const v = validateCustomNode(req.body);
    if (resolveNode(v.key) && !isCustomNode(v.key)) {
      return res.status(409).json({ error: `key "${v.key}" is already used by a built-in node` });
    }
    const saved = await saveCustomNode(v);
    refreshCustomNodes();
    res.status(201).json({ ok: true, ...saved });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post('/api/custom-nodes/:key/rollback', async (req, res) => {
  try {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version)) return res.status(400).json({ error: 'version must be an integer' });
    const saved = await rollbackCustomNode(req.params.key, version, String(req.body?.author ?? 'human'));
    refreshCustomNodes();
    res.json({ ok: true, ...saved });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post('/api/custom-nodes/:key/approve', (req, res) => {
  try {
    const row = approveCustomNode(req.params.key, String(req.body?.by ?? 'human'));
    res.json({ ok: true, status: row.status });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post('/api/custom-nodes/:key/enable', (req, res) => {
  try {
    const enabled = req.body?.enabled !== false;
    const row = setCustomNodeEnabled(req.params.key, enabled);
    res.json({ ok: true, disabled: (row.disabled ?? 0) === 1 });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.delete('/api/custom-nodes/:key', (req, res) => {
  if (!isCustomNode(req.params.key)) return res.status(404).json({ error: 'not a custom node' });
  db.prepare('DELETE FROM custom_nodes WHERE key=?').run(req.params.key);
  refreshCustomNodes();
  res.json({ ok: true });
});

/** Test an unsaved draft: { code, params, items, permissions } — no DB write. */
app.post('/api/custom-nodes/test', async (req, res) => {
  const code = String(req.body?.code ?? '');
  if (!code.trim()) return res.status(400).json({ error: 'code is required' });
  const params = (req.body?.params && typeof req.body.params === 'object' ? req.body.params : {}) as Record<string, unknown>;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [{ json: {} }];
  const items = rawItems.map((it: any) => (it && typeof it.json === 'object' ? { json: it.json } : { json: (it ?? {}) as Record<string, unknown> }));
  let permissions;
  try { permissions = normalizePermissions(req.body?.permissions); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }
  try {
    const out = await runCustomCode(code, { items, params }, { nodeKey: 'draft', permissions });
    if (out && typeof out === 'object' && Array.isArray((out as any).branches)) return res.json({ branches: (out as any).branches });
    return res.json({ items: out });
  } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
});

/** Import files chosen in the OS picker (base64) into a jailed root. */
app.post('/api/files/import', express.json({ limit: '100mb' }), (req, res) => {
  try {
    const scope = String(req.body?.scope ?? 'sandbox');
    const nodeKey = req.body?.node === undefined ? undefined : String(req.body.node);
    const basePath = String(req.body?.basePath ?? '');
    const { root, label } = resolveRoot(scope, nodeKey);
    const { written, bytes } = importFiles(root, basePath, req.body?.files ?? []);
    res.json({ root: label, written, bytes });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

/** Jailed file browser for `file`-type properties. */
app.get('/api/files', (req, res) => {
  try {
    const scope = String(req.query.scope ?? 'sandbox');
    const nodeKey = req.query.node === undefined ? undefined : String(req.query.node);
    const rel = String(req.query.path ?? '');
    const { root, label, mkdir } = resolveRoot(scope, nodeKey);
    res.json({ root: label, ...listFiles(root, rel, mkdir) });  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post('/api/nodes/:key/test', async (req, res) => {
  const def = resolveNode(req.params.key);
  if (!def) return res.status(404).json({ error: `unknown node: ${req.params.key}` });
  if (def.key === 'approval') {
    return res.status(400).json({ error: 'approval nodes pause for a human decision — test them with a real workflow run instead' });
  }
  const params = (req.body?.params && typeof req.body.params === 'object' ? req.body.params : {}) as Record<string, unknown>;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [{ json: {} }];
  const items = rawItems.map((it: any) => (it && typeof it.json === 'object' ? { json: it.json } : { json: (it ?? {}) as Record<string, unknown> }));
  // Resolve credential names so tested nodes behave like real runs.
  let testParams = params;
  try {
    testParams = resolveCredentialRefs(
      [{ id: 'test', type: def.key, params }], (t) => (t === def.key ? def : undefined) as any,
      (name) => getCredentialFields(credKey, name),
    ).nodes[0].params;
  } catch (e) { return res.status(400).json({ error: `credential resolution failed: ${(e as Error).message}` }); }
  const vars: Record<string, unknown> = {};
  try {
    const out = await withTimeout(
      Promise.resolve(def.execute({ params: testParams, items, vars, workflow: { id: 'test', name: 'node test' }, executionId: 'test', nodeId: def.key, expr: (t, item) => evaluateExpression(t, { $json: item.json, $vars: vars, $params: testParams }), error: (m) => new Error(m) })),
      30_000,
      def.displayName,
    );
    if (out && typeof out === 'object' && Array.isArray((out as any).branches)) {
      return res.json({ branches: (out as any).branches });
    }
    return res.json({ items: out });
  } catch (e) { return res.status(400).json({ error: (e as Error).message }); }
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Node "${label}" timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

app.get('/api/workflows', (_req, res) => {
  const rows = db.prepare('SELECT id,name,active,created_at,updated_at FROM workflows ORDER BY updated_at DESC').all();
  res.json(rows);
});

app.post('/api/workflows/import', (req, res) => {
  try {
    const { name, definition } = parseImportDoc(req.body);
    const now = new Date().toISOString();
    const wfId = id();
    db.prepare('INSERT INTO workflows (id,name,definition,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
      .run(wfId, name, JSON.stringify(definition), now, now);
    res.status(201).json({ id: wfId, name, definition, active: 1, created_at: now, updated_at: now });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/workflows/:id/export', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id) as WorkflowRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    const doc = toExportDoc(row.name, JSON.parse(row.definition));
    res.setHeader('Content-Disposition', `attachment; filename="${row.name.replace(/[^a-z0-9-_]+/gi, '_')}.flowforge.json"`);
    res.json(doc);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/workflows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id) as WorkflowRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({ ...row, definition: JSON.parse(row.definition) });
});

// Reusability usage scores: refreshed on workflow changes + every 5 minutes,
// since execution data moves independently of node saves.
function queueUsageRefresh() {
  try { refreshUsageScores(); } catch (err) { console.warn('[reusability] refresh failed:', (err as Error).message); }
}
setInterval(queueUsageRefresh, 5 * 60_000).unref();

app.post('/api/workflows', (req, res) => {
  const name = req.body?.name ?? 'Untitled workflow';
  const definition = req.body?.definition ?? { nodes: [], edges: [] };
  const now = new Date().toISOString();
  const wfId = id();
  db.prepare('INSERT INTO workflows (id,name,definition,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .run(wfId, name, JSON.stringify(definition), now, now);
  queueUsageRefresh();
  res.status(201).json({ id: wfId, name, definition, active: 1, created_at: now, updated_at: now });
});

app.put('/api/workflows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id) as WorkflowRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  const name = req.body?.name ?? row.name;
  const definition = req.body?.definition ?? JSON.parse(row.definition);
  const active = req.body?.active ?? row.active;
  const now = new Date().toISOString();
  let diff = null;
  try {
    diff = diffDefinitions(JSON.parse(row.definition), definition);
  } catch { diff = null; }
  db.prepare('UPDATE workflows SET name=?,definition=?,active=?,updated_at=? WHERE id=?')
    .run(name, JSON.stringify(definition), active, now, req.params.id);
  queueUsageRefresh();
  res.json({ id: req.params.id, name, definition, active, updated_at: now, diff });
});

app.delete('/api/workflows/:id', (req, res) => {
  db.prepare('DELETE FROM workflows WHERE id=?').run(req.params.id);
  queueUsageRefresh();
  res.json({ ok: true });
});

// Live run events (glass-box agent observability). Clients subscribe via SSE;
// runWorkflow broadcasts node start/finish so liveware sees what the agent does.
type RunEvent =
  | { type: 'run-start'; executionId: string; workflowId: string; startedAt: string }
  | { type: 'node-start'; executionId: string; nodeId: string; startedAt: string }
  | { type: 'node-finish'; executionId: string; nodeId: string; status: string; durationMs: number; items?: number; error?: string }
  | { type: 'approval-requested'; executionId: string; workflowId: string; nodeId: string; prompt: string; requestedAt: string }
  | { type: 'approval-decided'; executionId: string; workflowId: string; nodeId: string; approved: boolean; by?: string; expired?: boolean }
  | { type: 'run-finish'; executionId: string; status: string; finishedAt: string };

const runSubscribers = new Map<string, Set<any>>();

function publishRunEvent(workflowId: string, ev: RunEvent) {
  const subs = runSubscribers.get(workflowId);
  if (!subs || subs.size === 0) return;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of [...subs]) {
    try { res.write(line); } catch { subs.delete(res); }
  }
}

// Human-in-the-loop approvals: the approval node suspends its run here until
// a human POSTs a decision. Human-only by design — no MCP tool resolves these.
const approvalStore = new ApprovalStore((ev) => {
  if (ev.type === 'approval-requested') {
    publishRunEvent(ev.workflowId, {
      type: 'approval-requested', executionId: ev.executionId, workflowId: ev.workflowId,
      nodeId: ev.nodeId, prompt: ev.prompt, requestedAt: ev.requestedAt,
    });
  } else {
    publishRunEvent(ev.workflowId, {
      type: 'approval-decided', executionId: ev.executionId, workflowId: ev.workflowId,
      nodeId: ev.nodeId, approved: ev.approved, by: ev.by, expired: ev.expired,
    });
  }
});
setApprovalHandler((req) => approvalStore.wait(req));

async function runWorkflow(wfId: string, initialItems: unknown[] = [], opts: { manual?: boolean } = {}) {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(wfId) as WorkflowRow | undefined;
  if (!row) throw new Error('workflow not found');
  const def = JSON.parse(row.definition);
  // Trust ladder: disabled/draft custom nodes never run; tested-only nodes
  // run manually but never on automatic triggers (webhook/cron).
  const trust = checkCustomTrust((def.nodes ?? []).map((n: any) => n.type));
  if (trust.disabled.length) throw new Error(`custom node(s) disabled: ${trust.disabled.join(', ')}`);
  if (trust.draft.length) throw new Error(`custom node(s) not yet tested: ${trust.draft.join(', ')} — run their self-test first`);
  if (!opts.manual && trust.tested.length) {
    throw new Error(`custom node(s) not approved for automatic runs: ${trust.tested.join(', ')} — approve them in the Library`);
  }
  // Resolve credential names → secret field objects. Stored definitions and
  // execution records keep names only when nodes don't echo them into items.
  let runNodes = def.nodes;
  let credsUsed: string[] = [];
  try {
    const r = resolveCredentialRefs(def.nodes ?? [], (t) => resolveNode(t) as any, (name) => getCredentialFields(credKey, name));
    runNodes = r.nodes;
    credsUsed = r.used;
  } catch (e) {
    throw new Error(`credential resolution failed: ${(e as Error).message}`);
  }
  const wfResolved: Workflow = { id: row.id, name: row.name, nodes: runNodes, edges: def.edges };
  const executionId = `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  publishRunEvent(wfId, { type: 'run-start', executionId, workflowId: wfId, startedAt: new Date().toISOString() });
  const result = await executeWorkflow(wfResolved, resolveNode, {
    initialItems: initialItems as any,
    concurrency: 4,
    executionId,
    onNodeStart: (s) => publishRunEvent(wfId, { type: 'node-start', executionId, nodeId: s.nodeId, startedAt: s.startedAt }),
    onNodeFinish: (r) => publishRunEvent(wfId, {
      type: 'node-finish', executionId, nodeId: r.nodeId, status: r.status,
      durationMs: r.durationMs, items: r.items?.length, error: r.error,
    }),
  });
  publishRunEvent(wfId, { type: 'run-finish', executionId, status: result.status, finishedAt: result.finishedAt });
  db.prepare('INSERT INTO executions (id,workflow_id,status,result,started_at,finished_at) VALUES (?,?,?,?,?,?)')
    .run(result.executionId, wfId, result.status, JSON.stringify(result), result.startedAt, result.finishedAt);
  // simple retention: keep last 200 executions per workflow
  db.prepare('DELETE FROM executions WHERE workflow_id=? AND id NOT IN (SELECT id FROM executions WHERE workflow_id=? ORDER BY started_at DESC LIMIT 200)')
    .run(wfId, wfId);
  return { ...result, trust: { testedUnapproved: trust.tested }, credentials: { used: credsUsed } };
}

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const result = await runWorkflow(req.params.id, req.body?.items ?? [], { manual: true });
    res.json(result);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get('/api/executions', (req, res) => {
  const wfId = req.query.workflowId as string | undefined;
  const rows = wfId
    ? db.prepare('SELECT * FROM executions WHERE workflow_id=? ORDER BY started_at DESC LIMIT 50').all(wfId)
    : db.prepare('SELECT * FROM executions ORDER BY started_at DESC LIMIT 50').all();
  res.json(rows);
});

app.get('/api/executions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM executions WHERE id=?').get(req.params.id) as ExecutionRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    return res.json({ ...row, result: JSON.parse(row.result) });
  } catch {
    return res.json(row);
  }
});

// Credentials: names + types are public to the UI/MCP; values never leave node execution.
app.get('/api/credentials', (_req, res) => {
  res.json(listCredentials());
});

app.post('/api/credentials', (req, res) => {
  try {
    const v = validateCredentialInput(req.body);
    const meta = insertCredential(v.name, v.type, encryptFields(credKey, v.fields));
    res.status(201).json(meta);
  } catch (e) {
    const code = /already exists/.test((e as Error).message) ? 409 : 400;
    res.status(code).json({ error: (e as Error).message });
  }
});

app.put('/api/credentials/:name', (req, res) => {
  try {
    const b = req.body ?? {};
    const type = b.type === undefined ? undefined : String(b.type).trim().slice(0, 32) || 'token';
    let enc: string | undefined;
    if (b.fields !== undefined) {
      const v = validateCredentialInput({ name: req.params.name, fields: b.fields });
      enc = encryptFields(credKey, v.fields);
    }
    const meta = updateCredential(req.params.name, type, enc);
    if (!meta) return res.status(404).json({ error: 'not found' });
    res.json(meta);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.delete('/api/credentials/:name', (req, res) => {
  if (!deleteCredential(req.params.name)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// Human decisions for approval nodes. No MCP tool touches these — liveware only.
app.get('/api/approvals', (req, res) => {
  const wfId = req.query.workflowId as string | undefined;
  res.json(approvalStore.list(wfId));
});

app.get('/api/approvals/history', (req, res) => {
  const wfId = req.query.workflowId as string | undefined;
  const limit = Number(req.query.limit ?? 50);
  res.json(approvalStore.historyList(wfId, Number.isFinite(limit) ? limit : 50));
});

app.post('/api/approvals/:executionId/:nodeId', (req, res) => {
  const { approved, by, comment } = req.body ?? {};
  if (typeof approved !== 'boolean') return res.status(400).json({ error: 'approved must be a boolean' });
  const outcome = approvalStore.decide(req.params.executionId, req.params.nodeId, {
    approved,
    by: typeof by === 'string' ? by.slice(0, 80) : undefined,
    comment: typeof comment === 'string' ? comment.slice(0, 500) : undefined,
  });
  if (outcome === 'missing') return res.status(410).json({ error: 'no pending approval for this execution/node (decided, expired, or unknown)' });
  res.json({ ok: true, approved });
});

// SSE: live node-level progress for one workflow's runs.
app.get('/api/workflows/:id/events', (req, res) => {  const wfId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  (res as any).flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'subscribed', workflowId: wfId })}\n\n`);
  let subs = runSubscribers.get(wfId);
  if (!subs) { subs = new Set(); runSubscribers.set(wfId, subs); }
  subs.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
  hb.unref?.();
  req.on('close', () => { subs!.delete(res); clearInterval(hb); });
});

// Dynamic webhook routes — match any registered webhookTrigger node path
app.all('/hook/:path', async (req, res) => {
  const rows = db.prepare('SELECT * FROM workflows WHERE active=1').all() as unknown as WorkflowRow[];
  for (const row of rows) {
    const def = JSON.parse(row.definition);
    const trigger = def.nodes.find((n: any) => {
      const nodeDef = resolveNode(n.type);
      return nodeDef?.key === 'webhookTrigger' && (n.params?.path ?? 'my-hook') === req.params.path;
    });
    if (trigger) {
      const items = [{ json: { method: req.method, query: req.query, body: req.body, headers: req.headers } }];
      try {
        const result = await runWorkflow(row.id, items);
        return res.json({ ok: true, executionId: result.executionId, status: result.status });
      } catch (e) {
        const msg = (e as Error).message;
        const code = /not approved|not yet tested|disabled/.test(msg) ? 403 : 500;
        return res.status(code).json({ error: msg });
      }
    }
  }
  res.status(404).json({ error: 'no active workflow for this webhook path' });
});

// Cron scheduler (1s tick): interval-seconds triggers plus 5-field cron
// expressions (fire-once-per-minute via cronMinuteKey guard).
const cronState = new Map<string, number | string>();
setInterval(async () => {
  const rows = db.prepare('SELECT * FROM workflows WHERE active=1').all() as unknown as WorkflowRow[];
  const now = Date.now();
  const nowDate = new Date(now);
  for (const row of rows) {
    const def = JSON.parse(row.definition);
    const trigger = def.nodes.find((n: any) => resolveNode(n.type)?.key === 'cronTrigger');
    if (!trigger) continue;
    const expr = String(trigger.params?.cron ?? '').trim();
    if (expr) {
      const last = cronState.get(row.id);
      if (shouldFireCron(expr, typeof last === 'string' ? last : undefined, nowDate)) {
        const key = cronMinuteKey(nowDate);
        cronState.set(row.id, key);
        runWorkflow(row.id, [{ json: { scheduled: true, at: nowDate.toISOString(), cron: expr } }])
          .catch((err) => console.warn(`[cron] skipped ${row.id}: ${(err as Error).message}`));
      }
      continue;
    }
    const interval = Number(trigger.params?.intervalSeconds ?? 60) * 1000;
    const last = cronState.get(row.id);
    const lastMs = typeof last === 'number' ? last : 0;
    if (now - lastMs >= interval) {
      cronState.set(row.id, now);
      runWorkflow(row.id, [{ json: { scheduled: true, at: new Date().toISOString() } }])
        .catch((err) => console.warn(`[cron] skipped ${row.id}: ${(err as Error).message}`));
    }
  }
}, 1000).unref();

// File-watch triggers: reconcile watchers against active workflows every 5s.
// A change runs the workflow with [{ event, name, path, at }]. Trust gating
// applies (tested/approved required for automatic runs), like cron.
const fileWatchers = new Map<string, { key: string; watcher: FileWatcher }>();
setInterval(() => {
  let rows: WorkflowRow[];
  try {
    rows = db.prepare('SELECT * FROM workflows WHERE active=1').all() as unknown as WorkflowRow[];
  } catch { return; }
  const roots = watchRoots(repoRoot);
  const wanted = new Map<string, { key: string; dir: string; filter: string; debounceMs: number; recursive: boolean; wfId: string }>();
  for (const row of rows) {
    let def: any;
    try { def = JSON.parse(row.definition); } catch { continue; }
    const trigger = (def.nodes ?? []).find((n: any) => resolveNode(n.type)?.key === 'fileWatchTrigger');
    if (!trigger) continue;
    const filter = String(trigger.params?.filter ?? '');
    const debounceMs = clampDebounce(trigger.params?.debounceMs);
    const recursive = trigger.params?.recursive === true;
    let dir: string;
    try {
      dir = resolveWatchDir(String(trigger.params?.path ?? ''), roots);
    } catch (e) {
      console.warn(`[watch] skipped ${row.id}: ${(e as Error).message}`);
      continue;
    }
    wanted.set(row.id, { key: JSON.stringify({ dir, filter, debounceMs, recursive }), dir, filter, debounceMs, recursive, wfId: row.id });
  }
  for (const [wfId, want] of wanted) {
    const cur = fileWatchers.get(wfId);
    if (cur && cur.key === want.key && cur.watcher.running) continue;
    cur?.watcher.stop();
    const watcher = new FileWatcher(want.dir, {
      filter: want.filter,
      debounceMs: want.debounceMs,
      recursive: want.recursive,
      onEvent: (ev) => {
        runWorkflow(want.wfId, [{ json: { event: 'file', kind: ev.kind, name: ev.name, path: ev.path, at: new Date().toISOString() } }])
          .catch((err) => console.warn(`[watch] skipped ${want.wfId}: ${(err as Error).message}`));
      },
    });
    try {
      watcher.start();
    } catch (e) {
      console.warn(`[watch] cannot watch ${want.dir}: ${(e as Error).message}`);
      continue;
    }
    fileWatchers.set(wfId, { key: want.key, watcher });
  }
  for (const [wfId, cur] of [...fileWatchers]) {
    if (!wanted.has(wfId)) {
      cur.watcher.stop();
      fileWatchers.delete(wfId);
    }
  }
}, 5000).unref();

// Serve built web app
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use(express.static(webDist));
app.get('*', (_req, res, next) => {
  res.sendFile(join(webDist, 'index.html'), (err) => { if (err) next(); });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`[flowforge] server on http://localhost:${port}`));
