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
  mcp/          @flowforge/mcp        — MCP server so AI agents can operate Flowforge
```

Workflows are a DAG of node instances with typed edges. The engine executes the
graph with bounded concurrency, per-node timeouts, branch routing (If/Switch/Filter
route items to different output handles), and execution history persisted in SQLite
(WAL, last 200 runs per workflow). Automatic triggers: webhooks (`/hook/:path`),
cron (interval or 5-field expression), and file-watch (dirs jailed to
`FLOWFORGE_WATCH_ROOTS`, default `data/sandbox`, debounced per file).

Terminology: the **Canvas** is the home view where workflows are built and run
(orchestration); the **Library** is the node workshop where nodes are authored,
tested, approved, and versioned.

## Built-in nodes

| Node | Kind | Description |
|---|---|---|
| Manual Trigger | trigger | Starts the workflow from the editor |
| Webhook Trigger | trigger | Starts a flow on `/hook/:path` |
| Cron Trigger | trigger | Starts a flow on a schedule (cron expression or every N seconds) |
| File Watch Trigger | trigger | Starts a flow when files change in a watched dir (debounced) |
| HTTP Request | action | GET/POST/PUT/DELETE with JSON headers/body |
| GitHub | action | GitHub REST API: issues, PRs, comments, workflow dispatches |
| Slack | action | Post messages via incoming webhook (credential or URL, one call per item) |
| Discord | action | Post messages via channel webhook (credential or URL, ≤2000 chars) |
| Notion | action | Query databases, create pages, append blocks (one call per item) |
| Telegram | action | Send messages via a bot (credential or token, ≤4096 chars) |
| RSS Feed | action | Read RSS/Atom feeds → one item per entry (title, link, date, summary) |
| Set / Edit Fields | action | Merge fields into each item |
| If | action | Branch output 0 = true, 1 = false |
| Switch | action | Route by case value, default falls through |
| Filter | action | Keep matching items / discard the rest |
| Merge | action | Combine multiple input streams |
| Code (JavaScript) | action | Sandboxed `vm` code with 5s timeout |
| Python | action | Run a Python script, items via `FLOW_ITEMS` |
| Script Start / Script End | action | Mark a collapsible, nestable script block (same Block ID) |
| NoOp | action | Pass-through |
| Wait | action | Pause the flow |
| Approval | action | Pause until a human approves/rejects in the UI (output 0 = approved, 1 = rejected) |
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

## Node Library

Topbar **Library**: every node in one place, grouped by category
(triggers, logic, data, code, network, files, flow, custom), with search.
From a card you can **Add** it to the canvas, **Disable** it (hidden from the
palette, remembered in the browser), and for your own nodes **Edit/Delete**.

**+ New node**: key, display name, description, category, inspector fields
(properties JSON), icon (emoji or uploaded picture, shown left of the node —
pictures render grayscaled to match the theme), and a Monaco code editor (JS highlighting, dark, bundled
locally — works offline, lazy-loaded). Same contract as the Code node —
`items` and `params` in scope, return items or `{ branches }` — with a
**Run test** button that executes the draft without saving. Saved nodes are
stored in SQLite, hot-loaded into the registry, and usable in workflows
immediately. Custom nodes are actions only (triggers need server wiring).
Each custom card has **Export** (`key.custom-node.json`) and the Library header
has **Import** — share nodes as files, same as workflows.

**Authoring vs orchestration:** the Library is the workshop (full Monaco,
permissions, examples, versions). The workflow canvas is the control plane —
a custom node there is a black box showing only its declared parameters
(code and JSON render as plain mono textareas, never an editor), plus its
trust line (version · status · author · ♻ score) and an **Edit code in
Library →** teleport. One-off scripts belong in the built-in Code/Python
nodes, whose code is edited as plain text on the canvas.

All `code`/`json` inspector fields (Code, Python, JSON bodies, …) also use
Monaco now: JavaScript/Python/JSON highlighting, `vs-dark` to match the theme.

```
GET    /api/custom-nodes        — list your nodes (with code)
POST   /api/custom-nodes        — create/update { key, displayName, description, category, properties, code }
DELETE /api/custom-nodes/:key   — delete
POST   /api/custom-nodes/test   — test a draft { code, params, items }
```

## Script blocks (collapse / expand, nestable)

For pure-code-style grouping without leaving the canvas: drop a **Script
Start** and a **Script End** with the same **Block ID** around any nodes.
Select either marker → **Collapse to one node** (or Expand). The block renders
as a single black node with a live count; outgoing edges rewire to it with a
dashed line. Put one Start/End pair inside another to nest scripts. Markers
are pass-throughs at runtime, so execution is unaffected. Collapsed state is
saved in the workflow (`definition.collapsed`).

## AI agents (MCP)

`apps/mcp` is a Model Context Protocol server (stdio) so agents can operate
Flowforge: browse/describe nodes, create/update/run/delete workflows, test
single nodes, and author custom nodes when needed — node ids and canvas
positions are auto-filled, run output is compacted for agent context.

```bash
pnpm --filter @flowforge/mcp build
```

Point any MCP client at it (Flowforge itself must be running):

```json
{
  "mcpServers": {
    "flowforge": {
      "command": "node",
      "args": ["/home/imae/flowforge/apps/mcp/dist/index.js"],
      "env": { "FLOWFORGE_URL": "http://localhost:3000" }
    }
  }
}
```

19 tools: `list_nodes`, `describe_node`, `find_node`, `list_workflows`, `get_workflow`,
`create_workflow`, `update_workflow`, `delete_workflow`, `run_workflow`,
`test_node`, `create_custom_node`, `delete_custom_node`, `rollback_custom_node`,
`set_custom_node_enabled`, `export_workflow`,
`import_workflow`, `list_executions`, `get_execution`, `list_credentials` — plus a `flowforge://nodes-catalog`
resource. Typical agent loop: `find_node` → `describe_node` →
`create_custom_node` (with examples + author, if no fit) → `run_workflow` →
fix from errors → repeat. Approval stays human: there is deliberately no
approve tool — `POST /api/custom-nodes/:key/approve` is UI/manual only.

Live observability (glass-box): every run broadcasts SSE
`GET /api/workflows/:id/events` (`run-start` / `node-start` / `node-finish` /
`approval-requested` / `approval-decided` / `run-finish` with per-node
`durationMs`), `GET /api/executions/:id` returns the
full execution, and `PUT /api/workflows/:id` returns a `diff`
(nodesAdded/Removed/Changed, edgesAdded/Removed) so liveware sees what the
agent changed.

Setup lives in the UI: topbar **⚙ Settings** shows MCP status (built or not),
generates copy-paste configs for Claude Code / Claude Desktop / generic
clients, stores the public URL, and toggles which tools agents may use
(`GET/PUT /api/settings/mcp`, persisted in `data/mcp-config.json`).

## Capability sandbox (permissions)

Custom-node code runs in a `vm` sandbox with `items`/`params` in scope — and,
only if the node declares them, three capabilities:

| Permission | Code gets | Scope |
|---|---|---|
| `network: ["api.example.com", "*.example.com"]` | `fetch(url, init)` | Host allowlist (exact or `*.` subdomain), http(s) only, 10s timeout, DNS-resolved private IPs rejected (SSRF guard) |
| `kv: true` | `kv.get/set/del/getJson/setJson` | SQLite store namespaced to the node — counters, caches, cursors |
| `files: true` | `files.read/write/list/del` | Jaled to `data/custom/<nodeKey>/` — traversal rejected |

Anything ungranted fails with a clear error (`capability "network" is not
granted — enable it in the node's permissions`) instead of a `ReferenceError`.
Async code is awaited (10s cap on top of the 5s sync cap).

```js
// needs permissions: { network: ["api.coingecko.com"], kv: true }
const seen = kv.getJson('seen') ?? [];
const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
const price = (await r.json()).bitcoin.usd;
const fresh = !seen.includes(price);
if (fresh) kv.setJson('seen', [...seen.slice(-99), price]);
return items.map(i => ({ json: { ...i.json, btc: price, fresh } }));
```

Set permissions in Library → node editor (hosts textarea + checkboxes),
validate them with draft **Run test**, or pass `permissions` to
`POST /api/custom-nodes` / MCP `create_custom_node`. They persist on the node,
travel with export/import, and apply to saved-node tests too.

## Trust ladder, provenance, versions

Every custom node carries a status it must earn:

```
draft → (examples all pass at save) → tested → (human Approve) → approved
```

- **draft**: fresh or edited code. Only the node-test endpoints run it.
  Workflows using it refuse to run — manually or automatically.
- **tested**: declared example I/O (`examples: [{ name, params, items }]`,
  pass = runs without error) passed at save time, with the report stored on
  the node. Manual **Run** works; webhooks/cron refuse (403 / skipped).
- **approved**: a human clicked Approve in the Library. Required for
  webhook/cron/active schedules.
- Any code/properties/permissions/examples change resets to `draft`;
  metadata-only edits keep status. Approve is UI/manual-API only — no MCP
  tool, by design.
- **Provenance**: `author` records who saved each version (`human`,
  `mcp:…`, agent names). **Versions**: every content change snapshots
  (`GET /api/custom-nodes/:key/versions`, rollback re-tests on the way in).

## Reuse-before-create

`GET /api/nodes/search?q=...` (MCP: `find_node`) scores the catalog by
name/key/description/category match **plus real usage** (workflows using each
node), with reasons per hit — so agents (and the Library editor's
auto-suggest) reach for existing nodes instead of minting the eleventh
`upperCase` variant.

Two structures keep the library from becoming a single-use-script graveyard:

- **Structured docs** — every custom node can carry an Action + Target +
  Output-shape triple (`Fetches price of Bitcoin (CoinGecko) → appends
  btc_price to json`), shown on its card and fed to search + MCP
  `describe_node`. Free text stays, but the triple is what routers read.
- **Reusability rating** — a 0–100 score + A–F badge (`♻ 92 · A`) combining
  static analysis with live data:
  - *Configurability* (30): `params.*` usage rewarded, hardcoded URLs docked
  - *Permission footprint* (25): least privilege wins, wildcards cost double
  - *Composability* (25): spread-preserving maps and branches rewarded,
    destructive literals docked
  - *Documentation* (5): full triple bonus
  - *Usage* (15): workflows using the node + recent runs
  - Static analysis runs at **save-time**; usage is refreshed by a **5-minute
    scheduler** (and on every workflow save/delete), since execution data
    moves independently of saves. `find_node` boosts high-reuse matches.

## Blast-radius controls

- **Per-node limits** on every custom node: `timeoutMs` (1–30s) and
  `maxItems` (1–10k) — exceeded output errors instead of flooding downstream.
- **Kill switch**: disable a node (Library **Kill** button,
  `POST /api/custom-nodes/:key/enable`, MCP `set_custom_node_enabled`) and
  every workflow using it refuses to run until re-enabled.
- **No runaway loops by construction**: the engine executes a DAG once —
  cycles simply never fire, and untrusted nodes can't reach triggers.

## Testing a single node

Select a node → **Run test** in the inspector. Edit the test input
(`[{ "json": {} }, ...]`), and the node's `execute()` runs with its current
params (30s timeout). Also available as API:

```
POST /api/nodes/:key/test — { params: {...}, items: [{ json: {...} }] }
```

Node unit tests live next to the code (`packages/nodes-core/src/index.test.ts`,
`packages/engine/src/index.test.ts`) — run with `pnpm test`.

## Schema-driven inspector + expressions

The canvas inspector is generated from each node's `properties` schema —
`string`, `number`, `boolean` toggle, `options` dropdown, `json`, `code`,
and `file` (type `/file` in any Canvas text field — or Browse — to summon
the file explorer: Sandbox / Device / node-jail tabs, breadcrumbs, folder
pick, and drag-drop or File…/Folder… upload straight from your OS, which
lands jailed and injects the path at your cursor). Agents only ever write
`execute()` + the schema; the UI comes free. The canvas uses plain fields
throughout (Monaco lives only in the Library workshop).

Every text-like field takes **`{{ }}` expressions**, resolved per item at
runtime with `$json`, `$vars`, `$params` in scope (full JS, 1s cap):

```
https://api.example.com/users/{{ $json.id }}
{{ $json.n * 2 }} · {{ ($params.prefix ?? "u") + "-" + $json.id }}
```

A whole-value `{{ }}` preserves types (numbers stay numbers); mixed text
interpolates. The `{{}}` toggle on each field marks expression mode. Nodes
opt in via `ctx.expr(template, item)` — custom-node sandboxes get `expr`
too. Legacy `$json.path` shorthand still works in condition/value fields.

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
GET    /api/executions/:id        — one execution with parsed result
GET    /api/workflows/:id/events  — SSE live run events (run-start/node-start/node-finish/approval-*/run-finish)
GET    /api/approvals?workflowId  — pending human approvals
GET    /api/approvals/history     — decided approval history
POST   /api/approvals/:executionId/:nodeId — human decision { approved, by?, comment? }
GET    /api/credentials           — credential names + types (never values)
POST   /api/credentials           — create { name, type, fields }
PUT    /api/credentials/:name     — update type/fields
DELETE /api/credentials/:name     — delete
ALL    /hook/:path                — webhook trigger
```

## Credentials store

Secrets live in `Settings → Credentials`, encrypted at rest with AES-256-GCM
(key from `FLOWFORGE_CRED_KEY`, else an auto-created machine-local
`data/.credkey`). Nodes declare `credential`-type params (HTTP Request has
one for `Authorization`); workflows store the **name**, the server resolves
the value at run time, and each run records which credentials it used
(`credentials.used`, shown in the run panel and MCP summaries). Agents get
`list_credentials` (names only) — there is deliberately no tool that reads
values. Notes: custom-node save-time examples do **not** resolve credentials
(draft code only ever sees names); anything a node outputs — including remote
response bodies — lands in execution history like any other data, so treat
runs as secret-capable, keep secrets out of mapped fields, and pair sensitive
flows with an Approval node and least-privilege credentials.
```

## Human-in-the-loop approvals

Drop an **Approval** node where an agent must not proceed alone. The run
pauses, the canvas paints the node `waiting` and shows an approval banner
(over SSE + 10s polling fallback), and a human clicks **Approve** (continues
on output 0) or **Reject** (continues on output 1, e.g. into a notification).
`timeoutMinutes` (1–1440, default 60) errors the run when nobody decides;
webhook callers wait until the decision. Decisions are human-only by design:
there is deliberately no MCP tool for them, same as custom-node Approve.
```

## Roadmap

See [docs/PLAN.md](docs/PLAN.md).
