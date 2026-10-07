# Flowforge

Open-source workflow automation platform — a self-hosted, hackable alternative to
Zapier and n8n with a monochrome, minimalist editor.

**Philosophy:** nothing is too small and nothing is too large. A workflow can be a
single tiny `Set Fields` node, or a large graph where some nodes are plain
no-code nodes and others are arbitrary code (JavaScript or Python). Every node is
just a small package implementing one `execute()` function, so anyone can publish
their own.

## Quick start

```bash
pnpm install
pnpm build
pnpm start        # http://localhost:3000
```

Development with hot reload:

```bash
pnpm dev          # server (tsx watch) + web (vite) in parallel
```

Tests:

```bash
pnpm test         # vitest: engine + node tests
```

## Architecture

pnpm monorepo:

```
packages/
  node-sdk/     @flowforge/node-sdk   — defineNode() + shared types
  engine/       @flowforge/engine     — DAG executor (concurrency-limited, timeouts, branch routing)
  nodes-core/   @flowforge/nodes-core — built-in nodes
apps/
  server/       @flowforge/server     — REST API, webhooks (/hook/:path), cron scheduler, SQLite storage
  web/          @flowforge/web        — React canvas editor (@xyflow/react)
```

Workflows are a DAG of node instances with typed edges. The engine executes the
graph with bounded concurrency, per-node timeouts, branch routing (If/Switch/Filter
route items to different output handles), and execution history persisted in SQLite
(WAL, last 200 runs per workflow).

## Built-in nodes

| Node | Kind | Description |
|---|---|---|
| Manual Trigger | trigger | Starts the workflow from the editor |
| Webhook Trigger | trigger | Starts a flow on `/hook/:path` |
| Cron Trigger | trigger | Starts a flow every N seconds |
| HTTP Request | action | GET/POST/PUT/DELETE with JSON headers/body |
| Set / Edit Fields | action | Merge fields into each item |
| If | action | Branch output 0 = true, 1 = false |
| Switch | action | Route by case value, default falls through |
| Filter | action | Keep matching items / discard the rest |
| Merge | action | Combine multiple input streams |
| Code (JavaScript) | action | Sandboxed `vm` code with 5s timeout |
| Python | action | Run a Python script, items via `FLOW_ITEMS` |
| NoOp | action | Pass-through |
| Wait | action | Pause the flow |
| Split Out | action | Fan an array field into many items |
| Aggregate | action | Fold all items into one |
| Date & Time | action | Add timestamps |
| Crypto | action | UUID / SHA-256 / MD5 |
| JSON Parse | action | Parse a JSON string field |
| Send Email | action | Dry-run unless SMTP env vars are set |
| File | action | Read/write/list files under `data/sandbox` |

## Writing your own node

```ts
import { defineNode } from '@flowforge/node-sdk';

export default defineNode({
  key: 'myNode',
  displayName: 'My Node',
  description: 'What it does',
  version: 1,
  kind: 'action',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'greeting', displayName: 'Greeting', type: 'string', default: 'hello' },
  ],
  execute(ctx) {
    const g = String(ctx.params.greeting);
    return ctx.items.map((it) => ({ json: { ...it.json, greeting: g } }));
  },
});
```

Publish it as `flowforge-node-*` (or `@scope/flowforge-node-*`) on npm, or drop it
into `node_modules`, and the server picks it up automatically at boot.

`ctx.items` is an array of `{ json }` objects — the same item shape n8n uses, so
data flows between nodes without conversion.

## Testing a single node

Select a node → **Run test** in the inspector. Edit the test input
(`[{ "json": {} }, ...]`), and the node's `execute()` runs with its current
params (30s timeout). Also available as API:

```
POST /api/nodes/:key/test — { params: {...}, items: [{ json: {...} }] }
```

Node unit tests live next to the code (`packages/nodes-core/src/index.test.ts`,
`packages/engine/src/index.test.ts`) — run with `pnpm test`.

## Export / import

Topbar **Export** downloads the current workflow as
`*.flowforge.json` (`{ format, version, name, definition }`).
**Import** uploads such a file (bare `{ nodes, edges }` also accepted):

```
GET  /api/workflows/:id/export — download versioned doc
POST /api/workflows/import     — validate + create, rejects dangling edges
```

## API overview

```
GET    /api/nodes                 — list registered node types
POST   /api/nodes/:key/test       — run one node with { params, items }
GET    /api/workflows             — list workflows
POST   /api/workflows             — create
POST   /api/workflows/import     — import from export doc
GET    /api/workflows/:id         — read one
GET    /api/workflows/:id/export — download export doc
PUT    /api/workflows/:id         — update (name, definition, active)
DELETE /api/workflows/:id         — delete
POST   /api/workflows/:id/run     — execute now ({ items: [...] })
GET    /api/executions?workflowId — execution history
ALL    /hook/:path                — webhook trigger
```

## Roadmap

See [docs/PLAN.md](docs/PLAN.md).
