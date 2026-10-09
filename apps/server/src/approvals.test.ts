import { describe, it, expect } from 'vitest';
import { ApprovalStore } from './approvals.js';

const req = (over: Partial<Parameters<ApprovalStore['wait']>[0]> = {}) => ({
  executionId: 'e1', nodeId: 'n1', workflowId: 'w1', workflowName: 'wf',
  prompt: 'Ship it?', timeoutMinutes: 60, itemCount: 2, ...over,
});

describe('ApprovalStore', () => {
  it('resolves a wait on decide and lists nothing pending after', async () => {
    const events: any[] = [];
    const store = new ApprovalStore((e) => events.push(e));
    const p = store.wait(req());
    expect(store.list()).toHaveLength(1);
    expect(store.list('w1')).toHaveLength(1);
    expect(store.list('other')).toHaveLength(0);
    expect(store.decide('e1', 'n1', { approved: true, by: 'imae' })).toBe('decided');
    await expect(p).resolves.toMatchObject({ approved: true, by: 'imae' });
    expect(store.list()).toHaveLength(0);
    expect(store.historyList()).toHaveLength(1);
    expect(store.historyList()[0]).toMatchObject({ approved: true, by: 'imae' });
    expect(events.map((e) => e.type)).toEqual(['approval-requested', 'approval-decided']);
  });

  it('returns missing for unknown waits', () => {
    const store = new ApprovalStore();
    expect(store.decide('nope', 'n', { approved: true })).toBe('missing');
  });

  it('expires waits after timeoutMinutes and errors the run', async () => {
    const events: any[] = [];
    const store = new ApprovalStore((e) => events.push(e));
    const p = store.wait(req({ timeoutMinutes: 0.001 })); // ~60ms
    await expect(p).rejects.toThrow(/timed out/);
    expect(store.list()).toHaveLength(0);
    const [h] = store.historyList();
    expect(h).toMatchObject({ expired: true, approved: false });
    expect(events.at(-1)).toMatchObject({ type: 'approval-decided', expired: true });
  });

  it('does not warn on unhandled rejection when expiry fires early', async () => {
    const store = new ApprovalStore();
    // Fire-and-forget: node has not attached handlers yet when the timer hits.
    store.wait(req({ timeoutMinutes: 0.001 }));
    await new Promise((r) => setTimeout(r, 120));
    expect(store.historyList()).toHaveLength(1);
  });

  it('caps history at 100', async () => {
    const store = new ApprovalStore();
    for (let i = 0; i < 105; i++) {
      const p = store.wait(req({ executionId: `e${i}`, nodeId: 'n' }));
      store.decide(`e${i}`, 'n', { approved: i % 2 === 0 });
      await p;
    }
    expect(store.historyList(undefined, 200)).toHaveLength(100);
  });
});
