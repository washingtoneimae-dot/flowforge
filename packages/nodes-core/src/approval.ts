import { defineNode } from '@flowforge/node-sdk';
import type { FlowItem } from '@flowforge/node-sdk';

/** What the node asks a human to decide. */
export interface ApprovalRequest {
  executionId: string;
  nodeId: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  /** Max wait in minutes (server enforces the timer). */
  timeoutMinutes: number;
  itemCount: number;
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  comment?: string;
}

/** Implemented by the host (Flowforge server). Embedded engines have none. */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

let handler: ApprovalHandler | null = null;

/** Called once by the server at boot. Never called by agents. */
export function setApprovalHandler(h: ApprovalHandler | null) {
  handler = h;
}

export function getApprovalHandler(): ApprovalHandler | null {
  return handler;
}

/** Max human-wait the params accept (minutes). The engine backstop is 25h. */
export const APPROVAL_MAX_TIMEOUT_MINUTES = 1440;

export const approvalNode = defineNode({
  key: 'approval',
  displayName: 'Approval',
  description: 'Pauses the run until a human approves or rejects it in the UI → output 0 = approved, 1 = rejected.',
  version: 1,
  kind: 'action',
  inputs: ['main'],
  outputs: ['main', 'main'],
  /** Backstop only — the server settles (or expires) the wait first. */
  timeoutMs: 25 * 3600_000,
  properties: [
    { key: 'prompt', displayName: 'Prompt', type: 'string', default: 'Approve this run?', description: 'What the human sees in the approval banner' },
    { key: 'timeoutMinutes', displayName: 'Wait up to (minutes)', type: 'number', default: 60, description: 'Run errors when nobody decides in time (1–1440)' },
  ],
  async execute(ctx) {
    const wait = getApprovalHandler();
    if (!wait) {
      throw ctx.error('approvals are not configured on this host — human decisions need the Flowforge server');
    }
    const prompt = String((ctx.params as any).prompt ?? '').trim() || 'Approve this run?';
    let timeoutMinutes = Number((ctx.params as any).timeoutMinutes ?? 60);
    if (!Number.isFinite(timeoutMinutes)) timeoutMinutes = 60;
    timeoutMinutes = Math.min(Math.max(Math.round(timeoutMinutes), 1), APPROVAL_MAX_TIMEOUT_MINUTES);
    const decision = await wait({
      executionId: ctx.executionId ?? 'unknown',
      nodeId: ctx.nodeId ?? 'unknown',
      workflowId: ctx.workflow.id,
      workflowName: ctx.workflow.name,
      prompt,
      timeoutMinutes,
      itemCount: ctx.items.length,
    });
    const items: FlowItem[] = ctx.items.length ? ctx.items : [{ json: {} }];
    if (decision.approved) return { branches: [items, []] };
    return { branches: [[], items] };
  },
});
