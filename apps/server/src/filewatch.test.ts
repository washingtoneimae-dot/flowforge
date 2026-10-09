import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { watchRoots, resolveWatchDir, matchName, clampDebounce, FileWatcher } from './filewatch.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ff-watch-'));

describe('watchRoots', () => {
  it('defaults to the repo sandbox and honors env roots', () => {
    expect(watchRoots('/repo')).toEqual([join('/repo', 'data', 'sandbox')]);
    process.env.FLOWFORGE_WATCH_ROOTS = '/a:/b';
    try {
      expect(watchRoots('/repo')).toEqual(['/a', '/b']);
    } finally {
      delete process.env.FLOWFORGE_WATCH_ROOTS;
    }
  });
});

describe('resolveWatchDir', () => {
  it('jails relative and absolute paths to the roots', () => {
    const root = freshRoot();
    const dir = resolveWatchDir('watches/inbox', [root]);
    expect(dir).toBe(join(root, 'watches', 'inbox'));
    expect(() => resolveWatchDir('../escape', [root])).toThrow(/outside/);
    expect(() => resolveWatchDir('/etc', [root])).toThrow(/outside/);
    expect(() => resolveWatchDir('', [root])).toThrow(/required/);
  });
  it('rejects files, accepts nested roots', () => {
    const root = freshRoot();
    const f = join(root, 'f.txt');
    writeFileSync(f, 'x');
    expect(() => resolveWatchDir('f.txt', [root])).toThrow(/not a directory/);
    const sub = join(root, 'sub');
    mkdirSync(sub);
    expect(resolveWatchDir(sub, [root, '/other'])).toBe(sub);
  });
});

describe('matchName / clampDebounce', () => {
  it('matches substrings, empty matches all', () => {
    expect(matchName('a.json', '')).toBe(true);
    expect(matchName('a.json', '.json')).toBe(true);
    expect(matchName('a.txt', '.json')).toBe(false);
  });
  it('clamps debounce into 50–10000', () => {
    expect(clampDebounce(500)).toBe(500);
    expect(clampDebounce(1)).toBe(50);
    expect(clampDebounce(999999)).toBe(10_000);
    expect(clampDebounce('nope')).toBe(500);
  });
});

describe('FileWatcher', () => {
  it('fires debounced events for real file changes', async () => {
    const root = freshRoot();
    const events: any[] = [];
    const w = new FileWatcher(root, { filter: '', debounceMs: 50, onEvent: (e) => events.push(e) });
    w.start();
    expect(w.running).toBe(true);
    try {
      writeFileSync(join(root, 'a.txt'), '1');
      writeFileSync(join(root, 'a.txt'), '2'); // burst → one event
      await new Promise((r) => setTimeout(r, 400));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ name: 'a.txt', path: join(root, 'a.txt') });
    } finally {
      w.stop();
      expect(w.running).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('honors the filename filter', async () => {
    const root = freshRoot();
    const events: any[] = [];
    const w = new FileWatcher(root, { filter: '.json', debounceMs: 50, onEvent: (e) => events.push(e) });
    w.start();
    try {
      writeFileSync(join(root, 'skip.txt'), 'x');
      writeFileSync(join(root, 'take.json'), '{}');
      await new Promise((r) => setTimeout(r, 400));
      expect(events.map((e) => e.name)).toEqual(['take.json']);
    } finally {
      w.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stays silent after stop', async () => {
    const root = freshRoot();
    const events: any[] = [];
    const w = new FileWatcher(root, { debounceMs: 50, onEvent: (e) => events.push(e) });
    w.start();
    w.stop();
    writeFileSync(join(root, 'late.txt'), 'x');
    await new Promise((r) => setTimeout(r, 250));
    expect(events).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});
