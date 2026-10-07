import { readdirSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type FilesRoot = { kind: 'sandbox' } | { kind: 'custom'; nodeKey: string };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Resolve a browsable root. Throws on invalid scope/key. */
export function resolveRoot(scope: string, nodeKey: string | undefined): { root: string; label: string; mkdir: boolean } {
  if (scope === 'sandbox') {
    return { root: join(process.cwd(), 'data', 'sandbox'), label: 'data/sandbox', mkdir: true };
  }
  if (scope === 'custom') {
    if (!nodeKey || !KEY_RE.test(nodeKey)) throw new Error('custom scope needs a valid node key');
    return { root: join(process.cwd(), 'data', 'custom', nodeKey), label: `data/custom/${nodeKey}`, mkdir: true };
  }
  if (scope === 'device') {
    return { root: '/', label: 'device (/)', mkdir: false };
  }
  throw new Error(`unknown file scope: ${scope}`);
}

/** List a directory jailed inside root. Returns entries with trailing / for dirs. */
export function listFiles(root: string, rel: string, mkdir = true): { path: string; entries: Array<{ name: string; dir: boolean }> } {
  const abs = resolve(root);
  const target = resolve(abs, rel === '' ? '.' : String(rel ?? ''));
  const inside = abs === sep ? target.startsWith(sep) : target === abs || target.startsWith(abs + sep);
  if (!inside) throw new Error(`path escapes its root: "${rel}"`);
  if (mkdir) mkdirSync(target, { recursive: true });
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .map((e) => ({ name: e.isDirectory() ? `${e.name}/` : e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  } catch (err) {
    throw new Error(`cannot list "${rel || '/'}": ${(err as Error).message}`);
  }
  const relPath = target === abs ? '' : target.slice(abs.length + 1);
  return { path: relPath, entries };
}
