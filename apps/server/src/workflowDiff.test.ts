import { describe, it, expect } from 'vitest';
import { diffDefinitions, diffIsEmpty } from './workflowDiff.js';

const n = (id: string, type = 'code', params: any = {}) => ({ id, type, position: { x: 0, y: 0 }, params });

describe('diffDefinitions', () => {
  it('returns empty diff for identical definitions', () => {
    const d = { nodes: [n('a')], edges: [{ from: 'a', to: 'b' }] } as any;
    // add missing target so shape is valid for diff (diff does not validate)
    d.nodes.push(n('b', 'code'));
    const out = diffDefinitions(d, JSON.parse(JSON.stringify(d)));
    expect(diffIsEmpty(out)).toBe(true);
  });

  it('detects added/removed/changed nodes and edges', () => {
    const oldDef = { nodes: [n('a'), n('b', 'code', { x: 1 })], edges: [{ from: 'a', to: 'b' }] } as any;
    const newDef = {
      nodes: [n('a'), n('c', 'httpRequest', { url: 'https://x' })],
      edges: [{ from: 'a', to: 'c' }],
    } as any;
    // 'b' removed, 'c' added; edge changed
    const out = diffDefinitions(oldDef, newDef);
    expect(out.nodesAdded).toEqual(['c']);
    expect(out.nodesRemoved).toEqual(['b']);
    expect(out.edgesAdded).toEqual(['a->c#0']);
    expect(out.edgesRemoved).toEqual(['a->b#0']);
  });

  it('detects param/type/position changes', () => {
    const oldDef = { nodes: [n('a', 'code', { x: 1 })], edges: [] } as any;
    const withParamChange = { nodes: [n('a', 'code', { x: 2 })], edges: [] } as any;
    expect(diffDefinitions(oldDef, withParamChange).nodesChanged).toEqual([{ id: 'a', fields: ['params'] }]);

    const withTypeChange = { nodes: [n('a', 'python', { x: 1 })], edges: [] } as any;
    expect(diffDefinitions(oldDef, withTypeChange).nodesChanged[0].fields).toContain('type');

    const withPosChange = { nodes: [{ ...n('a', 'code', { x: 1 }), position: { x: 5, y: 0 } }], edges: [] } as any;
    expect(diffDefinitions(oldDef, withPosChange).nodesChanged[0].fields).toContain('position');
  });
});
