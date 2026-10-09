# Deploying Flowforge (systemd user service + daily backups)

## Install

```bash
mkdir -p ~/.config/systemd/user
cp ~/flowforge/deploy/flowforge.service \
   ~/flowforge/deploy/flowforge-backup.service \
   ~/flowforge/deploy/flowforge-backup.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now flowforge.service
systemctl --user enable --now flowforge-backup.timer
```

Survive logout (this machine currently has linger off):

```bash
sudo loginctl enable-linger $USER
```

## Operate

```bash
systemctl --user status flowforge.service
journalctl --user -u flowforge.service -f
systemctl --user start/stop/restart flowforge.service
systemctl --user list-timers | grep flowforge
node ~/flowforge/deploy/backup.mjs   # manual backup → data/backups/
```

## Configure

Optional `data/flowforge.env` (see comments in `deploy/flowforge.service`):

- `PORT` (default 3000)
- `FLOWFORGE_CRED_KEY` (64 hex chars; default: auto `data/.credkey`, never commit it)
- `FLOWFORGE_WATCH_ROOTS` (colon-separated; default `<repo>/data/sandbox`)

Restore: stop the service, copy a `data/backups/flowforge-*.db` over
`data/flowforge.db` (remove stale `-wal`/`-shm` first), start.

## Dogfood workflows (live in the DB, not git)

- **Morning digest** — daily `0 8 * * *` cron → GitHub `list_issues`
  (public read, no credential) → Code formats markdown → File writes
  `data/sandbox/digest/YYYY-MM-DD.md`. Upgrade path: add a Slack webhook
  credential + Approval node before announcing.
