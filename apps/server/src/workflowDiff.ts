/** Workflow diff for agent observability: what changed between two definitions. */

export interface DiffNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
}

export interface DiffEdge {
  from: string;
  to: string;
  fromIndex?: number;
}

export interface WorkflowDefinition {
  nodes: DiffNode[];
  edges: DiffEdge[];
  [k: string]: unknown;
}

export interface WorkflowDiff {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: Array<{ id: string; fields: string[] }>;
  edgesAdded: string[];
  edgesRemoved: string[];
}

const edgeKey = (e: DiffEdge) => `${e.from}->${e.to}#${e.fromIndex ?? 0}`;

function paramsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}

function posEqual(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return (a?.x ?? 0) === (b?.x ?? 0) && (a?.y ?? 0) === (b?.y ?? 0);
}

export function diffDefinitions(oldDef: WorkflowDefinition, newDef: WorkflowDefinition): WorkflowDiff {
  const o = new Map((oldDef?.nodes ?? []).map((n) => [n.id, n]));
  const n = new Map((newDef?.nodes ?? []).map((x) => [x.id, x]));
  const nodesAdded = [...n.keys()].filter((id) => !o.has(id));
  const nodesRemoved = [...o.keys()].filter((id) => !n.has(id));
  const nodesChanged: WorkflowDiff['nodesChanged'] = [];
  for (const id of [...o.keys()].filter((k) => n.has(k))) {
    const a = o.get(id)!;
    const b = n.get(id)!;
    const fields: string[] = [];
    if (a.type !== b.type) fields.push('type');
    if (!paramsEqual(a.params, b.params)) fields.push('params');
    if (!posEqual(a.position, b.position)) fields.push('position');
    if (fields.length) nodesChanged.push({ id, fields });
  }
  const oe = new Set((oldDef?.edges ?? []).map(edgeKey));
  const ne = new Set((newDef?.edges ?? []).map(edgeKey));
  return {
    nodesAdded,
    nodesRemoved,
    nodesChanged,
    edgesAdded: [...ne].filter((k) => !oe.has(k)),
    edgesRemoved: [...oe].filter((k) => !ne.has(k)),
  };
}

export function diffIsEmpty(d: WorkflowDiff): boolean {
  return (
    d.nodesAdded.length === 0 &&
    d.nodesRemoved.length === 0 &&
    d.nodesChanged.length === 0 &&
    d.edgesAdded.length === 0 &&
    d.edgesRemoved.length === 0
  );
}
