/** Pure helpers for the MCP server: workflow normalization and run summaries. */

export interface DraftNode {
  id?: string;
  type: string;
  params?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface DraftEdge {
  from: string;
  to: string;
  fromIndex?: number;
}

/** Fill in node ids/positions and validate edge endpoints. */
export function normalizeDefinition(input: { nodes: DraftNode[]; edges: DraftEdge[] }) {
  const nodes = input.nodes.map((n, i) => ({
    id: n.id ?? `n${i + 1}`,
    type: n.type,
    position: n.position ?? { x: 100 + (i % 3) * 260, y: 100 + Math.floor(i / 3) * 180 },
    params: n.params ?? {},
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (input.edges ?? []).map((e) => {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new Error(`edge ${e.from} -> ${e.to} references an unknown node id`);
    return { from: e.from, to: e.to, fromIndex: e.fromIndex ?? 0 };
  });
  return { nodes, edges };
}

/** Compact an execution result for agent context: counts + short previews. */
export function summarizeRun(result: any) {
  const cap = (v: unknown, n = 2000) => {
    const s = JSON.stringify(v);
    return s.length > n ? `${s.slice(0, n)}…(truncated)` : s;
  };
  return {
    executionId: result.executionId,
    status: result.status,
    credentialsUsed: result.credentials?.used ?? [],
    nodes: (result.results ?? []).map((r: any) => ({
      nodeId: r.nodeId,
      status: r.status,
      items: typeof r.items?.length === 'number' ? r.items.length : undefined,
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
      error: r.error,
      preview: r.items?.slice(0, 2).map((it: any) => cap(it?.json)) ?? undefined,
    })),
  };
}
