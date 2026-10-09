/** Human-in-the-loop approvals. In-memory by design: a restart drops pending
 *  waits (their runs are in-memory too), so there is nothing stale to resume.
 *  Decisions stay human-only — no MCP tool resolves these.
 */
import type { ApprovalRequest } from '@flowforge/nodes-core';

export interface ApprovalDecisionInput {
  approved: boolean;
  by?: string;
  comment?: string;
}

export interface ApprovalPending extends ApprovalRequest {
  requestedAt: string;
  expiresAt: string;
}

export interface ApprovalRecord extends ApprovalPending {
  decidedAt: string;
  approved: boolean;
  by?: string;
  comment?: string;
  expired?: boolean;
}

export type ApprovalStoreEvent =
  | { type: 'approval-requested'; workflowId: string; executionId: string; nodeId: string; prompt: string; requestedAt: string }
  | { type: 'approval-decided'; workflowId: string; executionId: string; nodeId: string; approved: boolean; by?: string; expired?: boolean };

const keyOf = (executionId: string, nodeId: string) => `${executionId}:${nodeId}`;
const HISTORY_CAP = 100;

interface Entry {
  pending: ApprovalPending;
  resolve: (d: { approved: boolean; by?: string; comment?: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalStore {
  private pending = new Map<string, Entry>();
  private history: ApprovalRecord[] = [];

  constructor(
    private emit: (ev: ApprovalStoreEvent) => void = () => {},
    private now: () => number = () => Date.now(),
  ) {}

  /** Called by the approval node via the registered handler. Resolves on decide(), rejects on expiry. */
  wait(req: ApprovalRequest): Promise<{ approved: boolean; by?: string; comment?: string }> {
    const key = keyOf(req.executionId, req.nodeId);
    // Same key twice means the older run is gone — drop it quietly.
    const stale = this.pending.get(key);
    if (stale) {
      clearTimeout(stale.timer);
      this.pending.delete(key);
      stale.reject(new Error('superseded by a newer wait'));
    }
    const requestedAt = new Date(this.now()).toISOString();
    const expiresAt = new Date(this.now() + req.timeoutMinutes * 60_000).toISOString();
    let entry!: Entry;
    const promise = new Promise<{ approved: boolean; by?: string; comment?: string }>((resolve, reject) => {
      const timer = setTimeout(() => this.expire(key), req.timeoutMinutes * 60_000);
      // Test doubles may use unref-able handles; real timers keep the process alive only while runs wait.
      (timer as any)?.unref?.();
      entry = { pending: { ...req, requestedAt, expiresAt }, resolve, reject, timer };
    });
    // Attach a noop catch guard synchronously so an expiry that fires before
    // the node awaits still counts as handled (avoids unhandled rejection).
    promise.catch(() => {});
    this.pending.set(key, entry);
    this.emit({ type: 'approval-requested', workflowId: req.workflowId, executionId: req.executionId, nodeId: req.nodeId, prompt: req.prompt, requestedAt });
    return promise;
  }

  /** Human decision from POST /api/approvals/:executionId/:nodeId. */
  decide(executionId: string, nodeId: string, input: ApprovalDecisionInput): 'decided' | 'missing' {
    const key = keyOf(executionId, nodeId);
    const entry = this.pending.get(key);
    if (!entry) return 'missing';
    clearTimeout(entry.timer);
    this.pending.delete(key);
    const decidedAt = new Date(this.now()).toISOString();
    this.pushHistory({ ...entry.pending, decidedAt, approved: input.approved, by: input.by, comment: input.comment });
    this.emit({ type: 'approval-decided', workflowId: entry.pending.workflowId, executionId, nodeId, approved: input.approved, by: input.by });
    entry.resolve({ approved: input.approved, by: input.by, comment: input.comment });
    return 'decided';
  }

  list(workflowId?: string): ApprovalPending[] {
    const all = [...this.pending.values()].map((e) => e.pending);
    return workflowId ? all.filter((p) => p.workflowId === workflowId) : all;
  }

  historyList(workflowId?: string, limit = 50): ApprovalRecord[] {
    const capped = Math.max(1, Math.min(limit || 50, 100));
    const all = workflowId ? this.history.filter((h) => h.workflowId === workflowId) : this.history;
    return all.slice(0, capped);
  }

  private expire(key: string) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    const decidedAt = new Date(this.now()).toISOString();
    this.pushHistory({ ...entry.pending, decidedAt, approved: false, expired: true });
    this.emit({
      type: 'approval-decided', workflowId: entry.pending.workflowId,
      executionId: entry.pending.executionId, nodeId: entry.pending.nodeId,
      approved: false, expired: true,
    });
    entry.reject(new Error(`approval "${entry.pending.prompt}" timed out after ${entry.pending.timeoutMinutes} minute(s) — no human decision`));
  }

  private pushHistory(rec: ApprovalRecord) {
    this.history.unshift(rec);
    if (this.history.length > HISTORY_CAP) this.history.length = HISTORY_CAP;
  }
}
