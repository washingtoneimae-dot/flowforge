import express from 'express';
import { db, WorkflowRow, ExecutionRow } from './db.js';
import { nodeRegistry, resolveNode } from './registry.js';
import { toExportDoc, parseImportDoc } from './workflowIo.js';
import { executeWorkflow, Workflow } from '@flowforge/engine';
import { mkdirSync, watch } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
app.use(express.json({ limit: '2mb' }));

const id = () => `wf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

app.get('/api/nodes', (_req, res) => {
  res.json([...nodeRegistry.values()].map((n) => ({
    key: n.key, displayName: n.displayName, description: n.description,
    kind: n.kind, icon: n.icon, version: n.version,
    inputs: n.inputs, outputs: n.outputs, properties: n.properties,
  })));
});

app.post('/api/nodes/:key/test', async (req, res) => {
  const def = resolveNode(req.params.key);
  if (!def) return res.status(404).json({ error: `unknown node: ${req.params.key}` });
  const params = (req.body?.params && typeof req.body.params === 'object' ? req.body.params : {}) as Record<string, unknown>;
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [{ json: {} }];
  const items = rawItems.map((it: any) => (it && typeof it.json === 'object' ? { json: it.json } : { json: (it ?? {}) as Record<string, unknown> }));
  try {
    const out = await withTimeout(
      Promise.resolve(def.execute({ params, items, vars: {}, workflow: { id: 'test', name: 'node test' }, error: (m) => new Error(m) })),
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

app.post('/api/workflows', (req, res) => {
  const name = req.body?.name ?? 'Untitled workflow';
  const definition = req.body?.definition ?? { nodes: [], edges: [] };
  const now = new Date().toISOString();
  const wfId = id();
  db.prepare('INSERT INTO workflows (id,name,definition,active,created_at,updated_at) VALUES (?,?,?,1,?,?)')
    .run(wfId, name, JSON.stringify(definition), now, now);
  res.status(201).json({ id: wfId, name, definition, active: 1, created_at: now, updated_at: now });
});

app.put('/api/workflows/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(req.params.id) as WorkflowRow | undefined;
  if (!row) return res.status(404).json({ error: 'not found' });
  const name = req.body?.name ?? row.name;
  const definition = req.body?.definition ?? JSON.parse(row.definition);
  const active = req.body?.active ?? row.active;
  const now = new Date().toISOString();
  db.prepare('UPDATE workflows SET name=?,definition=?,active=?,updated_at=? WHERE id=?')
    .run(name, JSON.stringify(definition), active, now, req.params.id);
  res.json({ id: req.params.id, name, definition, active, updated_at: now });
});

app.delete('/api/workflows/:id', (req, res) => {
  db.prepare('DELETE FROM workflows WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

async function runWorkflow(wfId: string, initialItems: unknown[] = []) {
  const row = db.prepare('SELECT * FROM workflows WHERE id=?').get(wfId) as WorkflowRow | undefined;
  if (!row) throw new Error('workflow not found');
  const def = JSON.parse(row.definition);
  const wf: Workflow = { id: row.id, name: row.name, nodes: def.nodes, edges: def.edges };
  const result = await executeWorkflow(wf, resolveNode, { initialItems: initialItems as any, concurrency: 4 });
  db.prepare('INSERT INTO executions (id,workflow_id,status,result,started_at,finished_at) VALUES (?,?,?,?,?,?)')
    .run(result.executionId, wfId, result.status, JSON.stringify(result), result.startedAt, result.finishedAt);
  // simple retention: keep last 200 executions per workflow
  db.prepare('DELETE FROM executions WHERE workflow_id=? AND id NOT IN (SELECT id FROM executions WHERE workflow_id=? ORDER BY started_at DESC LIMIT 200)')
    .run(wfId, wfId);
  return result;
}

app.post('/api/workflows/:id/run', async (req, res) => {
  try {
    const result = await runWorkflow(req.params.id, req.body?.items ?? []);
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
      } catch (e) { return res.status(500).json({ error: (e as Error).message }); }
    }
  }
  res.status(404).json({ error: 'no active workflow for this webhook path' });
});

// Cron scheduler (simple setInterval loop, 1s tick, checks intervalSeconds)
const cronState = new Map<string, number>();
setInterval(async () => {
  const rows = db.prepare('SELECT * FROM workflows WHERE active=1').all() as unknown as WorkflowRow[];
  const now = Date.now();
  for (const row of rows) {
    const def = JSON.parse(row.definition);
    const trigger = def.nodes.find((n: any) => resolveNode(n.type)?.key === 'cronTrigger');
    if (!trigger) continue;
    const interval = Number(trigger.params?.intervalSeconds ?? 60) * 1000;
    const last = cronState.get(row.id) ?? 0;
    if (now - last >= interval) {
      cronState.set(row.id, now);
      runWorkflow(row.id, [{ json: { scheduled: true, at: new Date().toISOString() } }]).catch(() => {});
    }
  }
}, 1000).unref();

// Serve built web app
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
app.use(express.static(webDist));
app.get('*', (_req, res, next) => {
  res.sendFile(join(webDist, 'index.html'), (err) => { if (err) next(); });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`[flowforge] server on http://localhost:${port}`));
