# Plan

## Decisions (2026-10-07)

- **License/Philosophy**: MIT, open from day one. "Nothing too small, nothing too
  large" — a workflow is nodes. Nodes are `execute(ctx)` functions. Code nodes
  (JS/Python) are first-class nodes, not a cop-out.
- **Stack**: TypeScript monorepo (pnpm workspaces). Engine separated from server
  and UI so it can be embedded anywhere. `node:sqlite` for zero-dependency
  persistence. React Flow for the canvas. Express for HTTP.
- **Item model**: mirror n8n — an array of `{ json }` objects flows between
  nodes. This keeps interop simple and makes code nodes natural.

## Current scope (v0.1)

- [x] Engine: DAG executor, concurrency cap, per-node timeout, branch routing,
      error/skip propagation
- [x] Server: REST API, `/hook/:path` webhooks, 1s-tick cron scheduler, SQLite
- [x] 20 built-in nodes (see README)
- [x] Minimalist black/white/grey editor: palette, canvas, inspector, run panel
- [x] Vitest suite for engine and core nodes
- [x] Auto-loading of `flowforge-node-*` community packages
- [x] Export/import of workflow JSON (`*.flowforge.json`, validated)
- [x] Single-node test run (inspector + `POST /api/nodes/:key/test`)
- [x] Node Library: categories, search, enable/disable, custom-node creator with code editor + draft test
- [x] Script Start/End markers: collapsible, nestable script blocks
- [x] MCP server: agents browse/describe nodes, CRUD + run workflows, author custom nodes
- [x] Settings page: MCP status, client configs (Claude Code/Desktop), public URL, tool toggles
- [x] Capability sandbox: declared network/kv/files permissions on custom nodes, enforced at runtime
- [x] Trust ladder (draft/tested/approved) + authorship + versioning with rollback
- [x] Reuse-before-create: scored node search over catalog + usage (API, MCP, editor suggest)
- [x] Structured node docs (Action/Target/Output) + reusability rating (static at save, usage on schedule)
- [x] Schema-driven inspector (boolean/file types) + per-item {{ }} expressions
- [x] Blast radius: per-node timeout/item limits, kill switch, trigger gating

## Next

- [ ] Drag nodes from palette onto canvas (currently click-to-add)
- [ ] Per-node run output preview in the inspector
- [x] Real cron expressions (5-field matcher; interval-seconds still the default when empty)
- [x] Credentials store (AES-256-GCM table, names-only API, run-time resolution, usage audit)
- [ ] Official node packages: Slack, Discord, GitHub (built in) — Notion, Google Sheets next
- [ ] Example community node repo + template
- [ ] Per-node run output preview in the inspector (test-run exists, last-run preview next)
