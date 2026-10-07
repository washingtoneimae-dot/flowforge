/**
 * Reusability rating for custom nodes (0–100 + A–F grade).
 *
 * Static analysis runs at save-time (deterministic, cheap); the usage
 * component is refreshed on a schedule + whenever workflows change, since
 * execution data moves independently of node saves.
 */

export interface DocsTriple {
  action?: string;
  target?: string;
  output?: string;
}

export interface ReuseStatic {
  configurability: number; // 0–30: params-driven vs hardcoded
  permissions: number;      // 0–25: least privilege
  composability: number;    // 0–25: preserves/chains items
  documentation: number;    // 0–5:  structured Action/Target/Output docs
  total: number;            // 0–85
}

export interface ReuseUsage {
  workflows: number;
  recentRuns: number;
  points: number; // 0–15
}

export interface Reusability {
  score: number; // 0–100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  static: ReuseStatic;
  usage: ReuseUsage;
  computed_at: string;
}

export function normalizeDocs(input: unknown): DocsTriple {
  if (!input || typeof input !== 'object') return {};
  const d = input as any;
  const pick = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim().slice(0, 140);
    return t ? t : undefined;
  };
  const out: DocsTriple = {};
  const a = pick(d.action), t = pick(d.target), o = pick(d.output);
  if (a) out.action = a;
  if (t) out.target = t;
  if (o) out.output = o;
  return out;
}

/** One-line contract for agents and cards: "Action target → output". */
export function contractLine(docs: DocsTriple, fallback = ''): string {
  const parts = [docs.action, docs.target].filter(Boolean).join(' ');
  if (!parts) return fallback;
  return docs.output ? `${parts} → ${docs.output}` : parts;
}

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

export function analyzeStatic(
  code: string,
  permissions: { network: string[]; kv: boolean; files: boolean },
  docs: DocsTriple,
): ReuseStatic {
  // Configurability: distinct params.X refs rewarded, hardcoded URLs docked.
  const paramRefs = new Set<string>();
  for (const m of code.matchAll(/params\.([A-Za-z_$][\w$]*)|\bparams\[\s*['"]([^'"]+)['"]\s*\]/g)) {
    paramRefs.add(m[1] ?? m[2]);
  }
  const urls = new Set(code.match(/https?:\/\/[^\s"'`]+/g) ?? []);
  const configurability = clamp(0, 30, 6 + 6 * paramRefs.size - 6 * urls.size);

  // Permission footprint: least privilege wins; wildcards cost double.
  const exact = permissions.network.filter((h) => !h.startsWith('*.')).length;
  const wild = permissions.network.length - exact;
  const permissionScore = clamp(0, 25,
    25 - (permissions.kv ? 2 : 0) - (permissions.files ? 2 : 0)
    - Math.min(8, 2 * exact) - Math.min(10, 5 * wild));

  // Composability: spread-preserve + map + branches rewarded; destructive literals docked.
  const spread = /\.\.\.\s*(it|i|item)\.json/.test(code);
  const maps = /\.map\s*\(/.test(code);
  const branches = /\bbranches\b/.test(code);
  const destructive = /return\s*\[\s*\{/.test(code) && !spread;
  const composability = clamp(0, 25,
    (spread ? 15 : 0) + (maps ? 5 : 0) + (branches ? 5 : 0) - (destructive ? 10 : 0));

  // Documentation: full Action/Target/Output triple.
  const filled = [docs.action, docs.target, docs.output].filter(Boolean).length;
  const documentation = filled === 3 ? 5 : filled > 0 ? 2 : 0;

  return { configurability, permissions: permissionScore, composability, documentation, total: configurability + permissionScore + composability + documentation };
}

export function usagePoints(workflows: number, recentRuns: number): ReuseUsage {
  const w = workflows <= 0 ? 0 : workflows === 1 ? 6 : workflows === 2 ? 9 : 12;
  const points = Math.min(15, w + (recentRuns > 0 ? 3 : 0));
  return { workflows, recentRuns, points };
}

export function gradeFor(score: number): Reusability['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

export function computeReusability(
  code: string,
  permissions: { network: string[]; kv: boolean; files: boolean },
  docs: DocsTriple,
  workflows: number,
  recentRuns: number,
): Reusability {
  const static_ = analyzeStatic(code, permissions, docs);
  const usage = usagePoints(workflows, recentRuns);
  const score = Math.min(100, static_.total + usage.points);
  return { score, grade: gradeFor(score), static: static_, usage, computed_at: new Date().toISOString() };
}
