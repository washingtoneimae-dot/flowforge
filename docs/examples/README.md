# Examples

## Device health report (`device-health.flowforge.json`)

A 10-node workflow that monitors this machine. Import it via the topbar
**Import** button (needs the `healthGrade` custom node below, or replace that
node with a Code node):

```
manualTrigger
  → Python "Collect device stats"  (disk via shutil, load, /proc/meminfo, ~/Downloads count)
  → Crypto (run UUID)
  → healthGrade (custom: ok / warning / critical + message)
  → If grade != ok
      ├─ true  → Send Email (dry-run, logs to server console)
      └─ false → Set Fields ("all clear" note)
  → Merge → Python "Write report" (data/sandbox/device-health.md)
  → File (list sandbox to confirm)
```

Verified live: `success` on all 10 nodes, report written with real values
(40.4% disk → `warning` → mail branch taken).

## Health Grade (`healthGrade.custom-node.json`)

Custom node created in Library → + New node. Params `warnAt` / `critAt`
(percent), outputs the item plus `grade` and `message`. Import by POSTing the
file to `/api/custom-nodes`:

```bash
curl -X POST localhost:3000/api/custom-nodes \
  -H 'Content-Type: application/json' \
  -d @docs/examples/healthGrade.custom-node.json
```
