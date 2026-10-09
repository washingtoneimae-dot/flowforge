import { describe, it, expect } from 'vitest';
import { applyRunEvent, initialLiveState } from './live.js';

describe('applyRunEvent', () => {
  it('starts a run and clears previous node state', () => {
    const s1 = applyRunEvent(initialLiveState, { type: 'run-start', executionId: 'e1', workflowId: 'w', startedAt: 't' });
    expect(s1).toMatchObject({ executionId: 'e1', running: true });
    expect(s1.nodes).toEqual({});
  });

  it('marks nodes running then finished with timings', () => {
    let s = applyRunEvent(initialLiveState, { type: 'run-start', executionId: 'e1', workflowId: 'w', startedAt: 't' });
    s = applyRunEvent(s, { type: 'node-start', executionId: 'e1', nodeId: 'n1', startedAt: 't' });
    expect(s.nodes.n1.status).toBe('running');
    s = applyRunEvent(s, { type: 'node-finish', executionId: 'e1', nodeId: 'n1', status: 'success', durationMs: 12, items: 3 });
    expect(s.nodes.n1).toMatchObject({ status: 'success', durationMs: 12, items: 3 });
    s = applyRunEvent(s, { type: 'run-finish', executionId: 'e1', status: 'success', finishedAt: 't' });
    expect(s.running).toBe(false);
    expect(s.status).toBe('success');
  });

  it('adopts a newer execution when events arrive out of band', () => {
    let s = applyRunEvent(initialLiveState, { type: 'run-start', executionId: 'e1', workflowId: 'w', startedAt: 't' });
    s = applyRunEvent(s, { type: 'node-start', executionId: 'e2', nodeId: 'n9', startedAt: 't' });
    expect(s.executionId).toBe('e2');
    expect(s.nodes.n9.status).toBe('running');
  });

  it('ignores run-finish for a stale execution', () => {
    let s = applyRunEvent(initialLiveState, { type: 'run-start', executionId: 'e2', workflowId: 'w', startedAt: 't' });
    s = applyRunEvent(s, { type: 'run-finish', executionId: 'e1', status: 'error', finishedAt: 't' });
    expect(s.running).toBe(true);
    expect(s.executionId).toBe('e2');
  });

  it('ignores subscribed pings', () => {
    expect(applyRunEvent(initialLiveState, { type: 'subscribed', workflowId: 'w' })).toEqual(initialLiveState);
  });
});
