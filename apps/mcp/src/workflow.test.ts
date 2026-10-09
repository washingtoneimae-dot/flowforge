import { describe, it, expect } from 'vitest';
import { normalizeDefinition, summarizeRun } from './workflow.js';

describe('normalizeDefinition', () => {
  it('fills ids and positions', () => {
    const d = normalizeDefinition({ nodes: [{ type: 'manualTrigger' }, { type: 'code', params: { code: 'return items;' } }], edges: [{ from: 'n1', to: 'n2' }] });
    expect(d.nodes[0].id).toBe('n1');
    expect(d.nodes[1].position.x).toBeGreaterThan(100);
    expect(d.edges).toEqual([{ from: 'n1', to: 'n2', fromIndex: 0 }]);
  });
  it('rejects dangling edges', () => {
    expect(() => normalizeDefinition({ nodes: [{ type: 'code' }], edges: [{ from: 'n1', to: 'nope' }] })).toThrow(/unknown node id/);
  });
});

describe('summarizeRun', () => {
  it('compacts results with previews', () => {
    const s = summarizeRun({
      executionId: 'e1', status: 'success',
      results: [
        { nodeId: 'n1', status: 'success', items: [{ json: { a: 1 } }], durationMs: 12 },
        { nodeId: 'n2', status: 'error', error: 'boom', durationMs: 3 },
      ],
    });
    expect(s.status).toBe('success');
    expect(s.nodes[0]).toMatchObject({ nodeId: 'n1', items: 1, durationMs: 12 });
    expect(s.nodes[0].preview[0]).toContain('"a":1');
    expect(s.nodes[1].error).toBe('boom');
  });
  it('truncates huge items', () => {
    const s = summarizeRun({ executionId: 'e', status: 'success', results: [{ nodeId: 'n', status: 'success', items: [{ json: { big: 'x'.repeat(5000) } }] }] });
    expect(s.nodes[0].preview[0]).toMatch(/truncated/);
  });
});
