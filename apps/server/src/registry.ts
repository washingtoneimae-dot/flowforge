import type { NodeDefinition } from '@flowforge/node-sdk';
import { coreNodes, nodeCategories } from '@flowforge/nodes-core';
import { loadCustomNodes } from './customNodes.js';
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const registry = new Map<string, NodeDefinition>();
/** Keys contributed by UI-created custom nodes (rebuilt on every refresh). */
const customKeys = new Set<string>();

// 1. Built-in nodes
for (const n of coreNodes) registry.set(n.key, n);

// 2. Community / third-party node packages:
//    any installed package named flowforge-node-* or @*/flowforge-node-*
//    that has a default export (a NodeDefinition or NodeDefinition[]).
function loadExternal() {
  const candidates: string[] = [];
  const nm = join(process.cwd(), 'node_modules');
  const scan = (dir: string, scoped = false) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (scoped) {
        candidates.push(`${entry}`);
        continue;
      }
      if (entry.startsWith('@')) { scan(join(dir, entry), true); continue; }
      if (entry.startsWith('flowforge-node-')) candidates.push(entry);
    }
  };
  scan(nm);
  const req = createRequire(import.meta.url);
  for (const name of candidates) {
    try {
      const mod = req(name);
      const defs = mod.default ?? mod;
      const arr = Array.isArray(defs) ? defs : [defs];
      for (const d of arr as NodeDefinition[]) {
        if (d?.key && typeof d.execute === 'function') registry.set(d.key, d);
      }
      console.log(`[registry] loaded node package: ${name}`);
    } catch (err) {
      console.warn(`[registry] failed to load ${name}:`, (err as Error).message);
    }
  }
}

try { loadExternal(); } catch { /* ignore */ }

/** (Re)load UI-created custom nodes from SQLite. Custom keys win on conflict. */
export function refreshCustomNodes() {
  for (const k of customKeys) registry.delete(k);
  customKeys.clear();
  for (const n of loadCustomNodes()) {
    if (registry.has(n.key)) {
      console.warn(`[registry] custom node key "${n.key}" is taken — skipped`);
      continue;
    }
    registry.set(n.key, n);
    customKeys.add(n.key);
  }
}

try { refreshCustomNodes(); } catch { /* ignore — e.g. fresh DB */ }

export const nodeRegistry = registry;
export const resolveNode = (type: string) => registry.get(type);
export const isCustomNode = (key: string) => customKeys.has(key);
export const categoryOf = (def: NodeDefinition) => def.category ?? nodeCategories[def.key] ?? 'other';
