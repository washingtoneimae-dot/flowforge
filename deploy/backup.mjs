#!/usr/bin/env node
/** Consistent SQLite snapshot via VACUUM INTO (safe on a live DB) + prune to 7 newest. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.FLOWFORGE_DB ?? join(repoRoot, 'data', 'flowforge.db');
const outDir = join(repoRoot, 'data', 'backups');
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(outDir, `flowforge-${stamp}.db`);
const db = new DatabaseSync(dbPath);
try {
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
} finally {
  db.close();
}

const files = readdirSync(outDir).filter((f) => f.endsWith('.db')).sort();
while (files.length > 7) rmSync(join(outDir, String(files.shift())), { force: true });
console.log(`backup → ${out} (kept ${Math.min(files.length + 1, 7)})`);
