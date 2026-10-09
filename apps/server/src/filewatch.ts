/** File-watch triggers: run workflows when watched directories change.
 *
 *  Watched dirs are jailed to FLOWFORGE_WATCH_ROOTS (default: <repo>/data/sandbox).
 *  Bursts are debounced per filename. Watchers are reconciled every few seconds
 *  against active workflows, so saves/activations need no restart.
 */
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export function watchRoots(repoRoot: string): string[] {
  const env = (process.env.FLOWFORGE_WATCH_ROOTS ?? '').trim();
  if (env) return env.split(':').map((s) => s.trim()).filter(Boolean);
  return [resolve(repoRoot, 'data', 'sandbox')];
}

/** Resolve a trigger path to an absolute dir inside the allowed roots (created if missing). */
export function resolveWatchDir(path: string, roots: string[]): string {
  const raw = String(path ?? '').trim();
  if (!raw) throw new Error('watch path is required');
  const abs = raw.startsWith('/') ? resolve(raw) : resolve(roots[0] ?? '/nonexistent', raw);
  const ok = roots.some((r) => {
    const root = resolve(r);
    return abs === root || abs.startsWith(root + sep);
  });
  if (!ok) throw new Error(`watch path "${raw}" is outside the allowed roots`);
  if (existsSync(abs) && !statSync(abs).isDirectory()) throw new Error(`watch path "${raw}" is not a directory`);
  mkdirSync(abs, { recursive: true });
  return abs;
}

export function matchName(name: string, filter: string): boolean {
  const f = String(filter ?? '');
  if (!f) return true;
  return String(name ?? '').includes(f);
}

export function clampDebounce(ms: unknown): number {
  const n = Number(ms ?? 500);
  if (!Number.isFinite(n)) return 500;
  return Math.min(Math.max(Math.round(n), 50), 10_000);
}

export interface WatchEvent {
  kind: 'change' | 'rename';
  name: string;
  path: string;
}

export interface WatchOptions {
  filter?: string;
  debounceMs?: number;
  recursive?: boolean;
  onEvent: (ev: WatchEvent) => void;
}

/** One debounced fs.watch. Call stop() to release it. */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(
    readonly dir: string,
    private opts: WatchOptions,
  ) {}

  get running(): boolean {
    return this.watcher !== null;
  }

  start(): void {
    if (this.watcher) return;
    const recursive = !!this.opts.recursive;
    try {
      this.watcher = watch(this.dir, { recursive }, (eventType, filename) => this.handle(eventType, filename));
    } catch {
      // recursive is not supported everywhere (notably some Linux builds) — retry flat.
      if (!recursive) throw new Error(`cannot watch "${this.dir}"`);
      this.watcher = watch(this.dir, (eventType, filename) => this.handle(eventType, filename));
    }
    this.watcher.on('error', () => { /* reconcile loop recreates us */ });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.watcher?.close();
    this.watcher = null;
  }

  private handle(eventType: string, filename: string | Buffer | null) {
    if (this.stopped || filename == null) return;
    const name = String(filename);
    if (!matchName(name, this.opts.filter ?? '')) return;
    const kind = eventType === 'rename' ? 'rename' : 'change';
    const pending = this.timers.get(name);
    if (pending) clearTimeout(pending);
    this.timers.set(name, setTimeout(() => {
      this.timers.delete(name);
      if (!this.stopped) this.opts.onEvent({ kind, name, path: `${this.dir}${sep}${name}` });
    }, clampDebounce(this.opts.debounceMs)));
  }
}
