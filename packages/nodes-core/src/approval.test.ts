import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { approvalNode, setApprovalHandler } from './approval.js';

const ctx = (params: any, items: any[] = [{ json: { a: 1 } }]) => ({
  params, items, vars: {},
  workflow: { id: 'w', name: 'wf' },
  executionId: 'exec_test', nodeId: 'n1',
  error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

describe('approval node', () => {
  it('routes items to branch 0 when approved', async () => {
    setApprovalHandler(async (req) => {
      expect(req.prompt).toBe('Ship it?');
      expect(req.executionId).toBe('exec_test');
      return { approved: true, by: 'human' };
    });
    try {
      const out: any = await approvalNode.execute(ctx({ prompt: 'Ship it?', timeoutMinutes: 60 }));
      expect(out.branches[0]).toEqual([{ json: { a: 1 } }]);
      expect(out.branches[1]).toEqual([]);
    } finally {
      setApprovalHandler(null);
    }
  });

  it('routes items to branch 1 when rejected', async () => {
    setApprovalHandler(async () => ({ approved: false, by: 'human', comment: 'nope' }));
    try {
      const out: any = await approvalNode.execute(ctx({}));
      expect(out.branches[0]).toEqual([]);
      expect(out.branches[1]).toEqual([{ json: { a: 1 } }]);
    } finally {
      setApprovalHandler(null);
    }
  });

  it('refuses to wait when no host handler is registered', async () => {
    setApprovalHandler(null);
    await expect(approvalNode.execute(ctx({}))).rejects.toThrow(/not configured/);
  });

  it('propagates host-side expiry as an error', async () => {
    setApprovalHandler(async () => { throw new Error('approval "x" timed out after 1 minute(s) — no human decision'); });
    try {
      await expect(approvalNode.execute(ctx({}))).rejects.toThrow(/timed out/);
    } finally {
      setApprovalHandler(null);
    }
  });
});
