/** Shared export/import format for workflows. Used by the server routes and tested here. */

export interface WorkflowExportDoc {
  format: 'flowforge-workflow';
  version: 1;
  name: string;
  definition: {
    nodes: Array<{ id: string; type: string; position: { x: number; y: number }; params: Record<string, unknown> }>;
    edges: Array<{ from: string; to: string; fromIndex?: number }>;
  };
}

export function toExportDoc(name: string, definition: unknown): WorkflowExportDoc {
  const def = parseDefinition(definition);
  return { format: 'flowforge-workflow', version: 1, name: String(name ?? 'Untitled workflow'), definition: def };
}

/** Accept an export doc, a `{ name, definition }` payload, or a bare `{ nodes, edges }` definition. */
export function parseImportDoc(body: unknown): { name: string; definition: WorkflowExportDoc['definition'] } {
  if (!body || typeof body !== 'object') throw new Error('import body must be an object');
  const b = body as any;
  // Bare definition: { nodes, edges }
  if (Array.isArray(b.nodes) && Array.isArray(b.edges)) {
    return { name: String(b.name ?? 'Imported workflow'), definition: parseDefinition(b) };
  }
  // Export doc or { name, definition }
  if (b.definition !== undefined) {
    return { name: String(b.name ?? 'Imported workflow'), definition: parseDefinition(b.definition) };
  }
  throw new Error('import needs { nodes, edges } or { name, definition }');
}

function parseDefinition(def: unknown): WorkflowExportDoc['definition'] {
  if (!def || typeof def !== 'object') throw new Error('definition must be an object');
  const d = def as any;
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) throw new Error('definition needs nodes[] and edges[]');
  const nodes = d.nodes.map((n: any, i: number) => {
    if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') {
      throw new Error(`node[${i}] needs string id and type`);
    }
    return {
      id: n.id,
      type: n.type,
      position: {
        x: Number(n.position?.x ?? 0) || 0,
        y: Number(n.position?.y ?? 0) || 0,
      },
      params: (n.params && typeof n.params === 'object' ? n.params : {}) as Record<string, unknown>,
    };
  });
  const ids = new Set(nodes.map((n: { id: string }) => n.id));
  const edges = d.edges.map((e: any, i: number) => {
    if (!e || typeof e.from !== 'string' || typeof e.to !== 'string') {
      throw new Error(`edge[${i}] needs string from and to`);
    }
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`edge[${i}] references unknown node`);
    return { from: e.from, to: e.to, fromIndex: Number(e.fromIndex ?? 0) || 0 };
  });
  return { nodes, edges };
}
