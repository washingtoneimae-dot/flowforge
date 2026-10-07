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

export interface WorkflowRow { id: string; name: string; definition: string; active: number; created_at: string; updated_at: string; }
export interface ExecutionRow { id: string; workflow_id: string; status: string; result: string; started_at: string; finished_at: string; }
export interface CustomNodeRow { key: string; display_name: string; description: string; category: string; properties: string; code: string; icon: string; created_at: string; updated_at: string; }
