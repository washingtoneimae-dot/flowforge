import { describe, it, expect } from 'vitest';
import { toExportDoc, parseImportDoc } from './workflowIo.js';

const def = {
  nodes: [{ id: 'a', type: 'setFields', position: { x: 0, y: 0 }, params: { fields: '{}' } }],
  edges: [],
};

describe('workflow export/import', () => {
  it('exports a versioned doc', () => {
    const doc = toExportDoc('My flow', def);
    expect(doc.format).toBe('flowforge-workflow');
    expect(doc.version).toBe(1);
    expect(doc.definition.nodes).toHaveLength(1);
  });

  it('imports its own export', () => {
    const doc = toExportDoc('My flow', def);
    const parsed = parseImportDoc(doc);
    expect(parsed.name).toBe('My flow');
    expect(parsed.definition.nodes[0].id).toBe('a');
  });

  it('imports a bare definition', () => {
    const parsed = parseImportDoc({ nodes: [], edges: [] });
    expect(parsed.definition.nodes).toEqual([]);
  });

  it('rejects edges pointing at unknown nodes', () => {
    expect(() => parseImportDoc({ nodes: [], edges: [{ from: 'x', to: 'y' }] })).toThrow(/unknown node/);
  });

  it('rejects garbage', () => {
    expect(() => parseImportDoc({})).toThrow();
    expect(() => parseImportDoc(null)).toThrow();
    expect(() => parseImportDoc({ nodes: [{ id: 1 }], edges: [] })).toThrow(/id and type/);
  });
});
