import type { NodeDefinition, FlowItem, NodeExecuteContext, BranchOutput } from '@flowforge/node-sdk';
import { evaluateExpression, scopeFor } from './expr.js';

export { evaluateExpression, scopeFor };

export interface NodeInstance {
  id: string;
  type: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface Edge {
  from: string;
  to: string;
  /** optional output branch index for multi-output nodes */
  fromIndex?: number;
}

export interface Workflow {
  id: string;
  name: string;
  nodes: NodeInstance[];
  edges: Edge[];
}

export interface NodeRunResult {
  nodeId: string;
  status: 'success' | 'error' | 'skipped';
  items?: FlowItem[];
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  status: 'success' | 'error';
  results: NodeRunResult[];
  startedAt: string;
  finishedAt: string;
}

export type NodeResolver = (type: string) => NodeDefinition | undefined;

export interface ExecuteOptions {
  /** Seed data for trigger-less runs (e.g. webhook payload). */
  initialItems?: FlowItem[];
  /** Per-node timeout in ms. */
  nodeTimeoutMs?: number;
  /** Max parallel node executions across the graph. */
  concurrency?: number;
  /** Pre-assigned execution id (generated when omitted) so live subscribers can attach early. */
  executionId?: string;
  onNodeStart?: (info: { nodeId: string; startedAt: string }) => void;
  onNodeFinish?: (r: NodeRunResult) => void;
}

function isBranchOutput(out: unknown): out is BranchOutput {
  return !!out && typeof out === 'object' && Array.isArray((out as BranchOutput).branches);
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Node "${label}" timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Execute a workflow DAG. Nodes at the same depth run concurrently (bounded by
 * `concurrency`). Branch outputs route items to matching edges via fromIndex.
 */
export async function executeWorkflow(
  wf: Workflow,
  resolve: NodeResolver,
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const startedAt = new Date();
  const executionId = opts.executionId ?? `exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const nodeTimeoutMs = opts.nodeTimeoutMs ?? 30_000;
  const concurrency = opts.concurrency ?? 4;
  const results: NodeRunResult[] = [];
  const vars: Record<string, unknown> = {};
  const itemsByNode = new Map<string, FlowItem[]>();
  const incomingCount = new Map<string, number>();
  const produced = new Map<string, FlowItem[][] | null>();

  for (const n of wf.nodes) incomingCount.set(n.id, 0);
  for (const e of wf.edges) incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);

  // Find trigger(s): nodes with no incoming edges, or declared kind trigger
  const triggers = wf.nodes.filter((n) => {
    const def = resolve(n.type);
    const hasIncoming = (incomingCount.get(n.id) ?? 0) > 0;
    return def?.kind === 'trigger' || !hasIncoming;
  });

  const queue: NodeInstance[] = [...triggers];
  for (const t of triggers) itemsByNode.set(t.id, opts.initialItems ?? []);

  let active = 0;
  const pendingCounts = new Map<string, number>(); // per-node received inputs
  for (const n of wf.nodes) pendingCounts.set(n.id, 0);

  await new Promise<void>((resolveP) => {
    const pump = () => {
      while (active < concurrency && queue.length > 0) {
        const n = queue.shift()!;
        active++;
        runNode(n).finally(() => {
          active--;
          if (queue.length === 0 && active === 0) resolveP();
          else pump();
        });
      }
      if (queue.length === 0 && active === 0) resolveP();
    };

    const runNode = async (n: NodeInstance) => {
      const def = resolve(n.type);
      const t0 = Date.now();
      const started = new Date().toISOString();
      opts.onNodeStart?.({ nodeId: n.id, startedAt: started });
      if (!def) {
        finish(n.id, { nodeId: n.id, status: 'error', error: `Unknown node type: ${n.type}`, startedAt: started, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
        return;
      }
      const items = itemsByNode.get(n.id) ?? [];
      const ctx: NodeExecuteContext = {
        params: n.params,
        items,
        vars,
        workflow: { id: wf.id, name: wf.name },
        expr: (template, item) => evaluateExpression(template, scopeFor(item, vars, n.params)),
        error: (m) => new Error(m),
      };
      try {
        const out = await withTimeout(Promise.resolve(def.execute(ctx)), nodeTimeoutMs, def.displayName);
        const branches = isBranchOutput(out) ? out.branches : [out];
        produced.set(n.id, branches);
        const all = branches.flat();
        finish(n.id, { nodeId: n.id, status: 'success', items: all, startedAt: started, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
        // route to successors
        for (const e of wf.edges.filter((e) => e.from === n.id)) {
          const branchItems = branches[e.fromIndex ?? 0] ?? [];
          const existing = itemsByNode.get(e.to) ?? [];
          itemsByNode.set(e.to, existing.concat(branchItems));
          const got = (pendingCounts.get(e.to) ?? 0) + 1;
          pendingCounts.set(e.to, got);
          if (got >= (incomingCount.get(e.to) ?? 1)) {
            const target = wf.nodes.find((x) => x.id === e.to);
            if (target) queue.push(target);
          }
        }
      } catch (err) {
        finish(n.id, { nodeId: n.id, status: 'error', error: (err as Error).message, startedAt: started, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
        // stop downstream of this path
        skipDownstream(n.id);
      }
    };

    const skipDownstream = (id: string) => {
      for (const e of wf.edges.filter((e) => e.from === id)) {
        const target = wf.nodes.find((x) => x.id === e.to);
        if (!target) continue;
        const started = new Date().toISOString();
        finish(e.to, { nodeId: e.to, status: 'skipped', startedAt: started, finishedAt: new Date().toISOString(), durationMs: 0 });
        skipDownstream(e.to);
      }
    };

    const finish = (id: string, r: NodeRunResult) => {
      results.push(r);
      opts.onNodeFinish?.(r);
    };

    pump();
  });

  const finishedAt = new Date();
  return {
    executionId,
    workflowId: wf.id,
    status: results.some((r) => r.status === 'error') ? 'error' : 'success',
    results,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}
