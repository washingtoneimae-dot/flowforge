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

## Next

- [ ] Drag nodes from palette onto canvas (currently click-to-add)
- [ ] Per-node run output preview in the inspector
- [ ] Real cron expressions (currently interval seconds)
- [ ] Credentials store (env today; encrypted table later)
- [ ] Official node packages: Slack, Discord, GitHub, Notion, Google Sheets
- [ ] Example community node repo + template
- [ ] Import/export of workflow JSON
