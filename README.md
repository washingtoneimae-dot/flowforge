# Flowforge

Open-source workflow automation platform (n8n/Zapier-style). Self-hosted, single-binary-friendly, and built so anyone can publish their own node types as npm packages.

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
graph level-by-level: independent nodes run concurrently (bounded by a
concurrency cap), every node has a timeout, item batches stream from node to
node instead of materializing whole payloads, and execution history is pruned
(SQLite WAL, last 200 runs per workflow).

## Built-in nodes

| Node | Kind | Description |
|---|---|---|
| Webhook Trigger | trigger | Starts a flow on `/hook/:path` |
| Cron Trigger | trigger | Starts a flow every N seconds |
| HTTP Request | action | GET/POST/PUT/DELETE with JSON headers/body |
| Set / Edit Fields | action | Merge fields into each item |
| If | action | Branch output 0 = true, 1 = false |
| Code (JavaScript) | action | Sandboxed `vm` code with 5s timeout |

## Writing your own node

Any npm package named `flowforge-node-*` (or `@scope/flowforge-node-*`)
installed alongside the server is auto-loaded at startup. A node is one file:

```ts
import { defineNode } from '@flowforge/node-sdk';

export default defineNode({
  key: 'myFirstNode',
  displayName: 'My First Node',
  description: 'Uppercases every item',
  version: 1,
  kind: 'action',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'field', displayName: 'Field to upcase', type: 'string', default: 'text' },
  ],
  async execute(ctx) {
    const field = String(ctx.params.field ?? 'text');
    return ctx.items.map((it) => ({ json: { ...it.json, [field]: String(it.json[field] ?? '').toUpperCase() } }));
  },
});
```

- `properties` automatically renders the parameter UI in the editor.
- Multi-output nodes return `{ branches: [itemsA, itemsB] }` and set `outputs: ['main','main']`.
- Publish to npm, `pnpm add flowforge-node-my-first` in the server workspace, restart. No registry config needed.

## License

MIT
