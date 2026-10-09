import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.env.FLOWFORGE_DB ?? new URL('../../../data/flowforge.db', import.meta.url).pathname;
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exec_workflow ON executions(workflow_id);
CREATE TABLE IF NOT EXISTS custom_nodes (
  key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',
  properties TEXT NOT NULL DEFAULT '[]',
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

try {
  db.exec(`ALTER TABLE custom_nodes ADD COLUMN icon TEXT NOT NULL DEFAULT ''`);
} catch { /* column already exists */ }
try {
  db.exec(`ALTER TABLE custom_nodes ADD COLUMN permissions TEXT NOT NULL DEFAULT '{"network":[],"kv":false,"files":false}'`);
} catch { /* column already exists */ }
for (const col of [
  `status TEXT NOT NULL DEFAULT 'draft'`,
  `author TEXT NOT NULL DEFAULT 'human'`,
  `version INTEGER NOT NULL DEFAULT 1`,
  `examples TEXT NOT NULL DEFAULT '[]'`,
  `test_report TEXT`,
  `limits TEXT NOT NULL DEFAULT '{}'`,
  `disabled INTEGER NOT NULL DEFAULT 0`,
]) {
  try { db.exec(`ALTER TABLE custom_nodes ADD COLUMN ${col}`); } catch { /* exists */ }
}
for (const col of [
  `docs TEXT NOT NULL DEFAULT '{}'`,
  `reusability TEXT`,
]) {
  try { db.exec(`ALTER TABLE custom_nodes ADD COLUMN ${col}`); } catch { /* exists */ }
}
db.exec(`
CREATE TABLE IF NOT EXISTS custom_node_versions (
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'custom',
  properties TEXT NOT NULL DEFAULT '[]',
  code TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '{}',
  examples TEXT NOT NULL DEFAULT '[]',
  limits TEXT NOT NULL DEFAULT '{}',
  docs TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  author TEXT NOT NULL DEFAULT 'human',
  test_report TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, version)
);
CREATE TABLE IF NOT EXISTS custom_kv (
  node_key TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_key, k)
);
CREATE TABLE IF NOT EXISTS credentials (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'token',
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`);

try {
  db.exec(`ALTER TABLE custom_node_versions ADD COLUMN docs TEXT NOT NULL DEFAULT '{}'`);
} catch { /* column already exists */ }

export interface WorkflowRow { id: string; name: string; definition: string; active: number; created_at: string; updated_at: string; }
export interface ExecutionRow { id: string; workflow_id: string; status: string; result: string; started_at: string; finished_at: string; }
export interface CustomNodeRow { key: string; display_name: string; description: string; category: string; properties: string; code: string; icon: string; permissions: string; status: string; author: string; version: number; examples: string; test_report: string | null; limits: string; disabled: number; docs: string; reusability: string | null; created_at: string; updated_at: string; }
export interface CustomNodeVersionRow { key: string; version: number; display_name: string; description: string; category: string; properties: string; code: string; icon: string; permissions: string; examples: string; limits: string; docs: string; status: string; author: string; test_report: string | null; created_at: string; }
