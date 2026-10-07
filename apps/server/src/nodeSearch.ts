/** Keyword "find me a node that does X" search with usage weighting. */

export interface CatalogNode {
  key: string;
  displayName: string;
  description: string;
  category: string;
  kind: string;
  custom: boolean;
}

export interface ScoredNode extends CatalogNode {
  score: number;
  reasons: string[];
  usage: number;
}

const tokens = (s: string): string[] =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export function scoreNode(query: string, node: CatalogNode, usage: number): ScoredNode {
  const qs = tokens(query);
  const name = node.displayName.toLowerCase();
  const desc = (node.description ?? '').toLowerCase();
  const key = node.key.toLowerCase();
  const cat = (node.category ?? '').toLowerCase();
  let score = 0;
  const reasons: string[] = [];
  for (const q of qs) {
    if (key === q) { score += 10; reasons.push(`key matches "${q}"`); }
    else if (key.includes(q)) { score += 6; reasons.push(`key contains "${q}"`); }
    if (name.split(/[^a-z0-9]+/).includes(q)) { score += 5; reasons.push(`name matches "${q}"`); }
    else if (name.includes(q)) { score += 3; reasons.push(`name contains "${q}"`); }
    if (desc.includes(q)) { score += 2; reasons.push(`description mentions "${q}"`); }
    if (cat === q) { score += 2; reasons.push(`category "${q}"`); }
  }
  const useBonus = Math.min(usage, 5);
  if (useBonus > 0 && score > 0) {
    score += useBonus;
    reasons.push(`used in ${usage} workflow${usage === 1 ? '' : 's'}`);
  }
  return { ...node, score, reasons, usage };
}

export function searchNodes(query: string, catalog: CatalogNode[], usage: Map<string, number>, limit = 8): ScoredNode[] {
  if (!query.trim()) return [];
  return catalog
    .map((n) => scoreNode(query, n, usage.get(n.key) ?? 0))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score || b.usage - a.usage)
    .slice(0, Math.max(1, Math.min(limit, 25)));
}

/** Count workflows whose definition references each node type. */
export function workflowUsage(definitions: Array<{ nodes: Array<{ type: string }> }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const def of definitions) {
    const seen = new Set<string>();
    for (const n of def.nodes ?? []) {
      if (n?.type && !seen.has(n.type)) {
        seen.add(n.type);
        m.set(n.type, (m.get(n.type) ?? 0) + 1);
      }
    }
  }
  return m;
}
