import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { db } from './db.js';

/** Declared permissions for a custom node. Stored as JSON on the node row. */
export interface NodePermissions {
  /** Allowlisted outbound hosts, e.g. ["api.example.com", "*.example.com"]. Empty = no network. */
  network: string[];
  /** Private key/value store for the node. */
  kv: boolean;
  /** Scoped file access under data/custom/<nodeKey>/. */
  files: boolean;
}

export const EMPTY_PERMISSIONS: NodePermissions = { network: [], kv: false, files: false };

const HOST_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** Normalize unknown input into permissions. Throws on invalid shapes. */
export function normalizePermissions(input: unknown): NodePermissions {
  if (input === undefined || input === null) return { ...EMPTY_PERMISSIONS };
  if (typeof input !== 'object') throw new Error('permissions must be an object');
  const p = input as any;
  const network = p.network ?? [];
  if (!Array.isArray(network)) throw new Error('permissions.network must be an array of hosts');
  if (network.length > 100) throw new Error('permissions.network allows at most 100 hosts');
  const hosts = network.map((h) => {
    const host = String(h).trim().toLowerCase();
    if (!HOST_RE.test(host)) throw new Error(`permissions.network: bad host "${h}"`);
    return host;
  });
  return { network: hosts, kv: p.kv === true, files: p.files === true };
}

/** Exact or `*.domain` suffix match (case-insensitive). */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  return allow.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      a === 0
    );
  }
  if (isIP(ip) === 6) {
    const h = ip.toLowerCase();
    return (
      h === '::1' || h === '::' ||
      h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
    );
  }
  return false;
}

/* ---------------------------------- kv ---------------------------------- */

export interface KvStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  del(key: string): void;
  getJson<T = unknown>(key: string): T | undefined;
  setJson(key: string, value: unknown): void;
}

const withJson = (base: Pick<KvStore, 'get' | 'set' | 'del'>): KvStore => ({
  ...base,
  getJson(key) {
    const raw = base.get(key);
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  },
  setJson(key, value) { base.set(key, JSON.stringify(value)); },
});

export function memoryKv(): KvStore {
  const m = new Map<string, string>();
  return withJson({
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    del: (k) => { m.delete(k); },
  });
}

export function sqliteKv(nodeKey: string): KvStore {
  const now = () => new Date().toISOString();
  return withJson({
    get: (k) => (db.prepare('SELECT v FROM custom_kv WHERE node_key=? AND k=?').get(nodeKey, k) as any)?.v,
    set: (k, v) => {
      db.prepare('INSERT INTO custom_kv (node_key,k,v,updated_at) VALUES (?,?,?,?) ON CONFLICT(node_key,k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at')
        .run(nodeKey, k, v, now());
    },
    del: (k) => { db.prepare('DELETE FROM custom_kv WHERE node_key=? AND k=?').run(nodeKey, k); },
  });
}

/* --------------------------------- files --------------------------------- */

export interface FilesApi {
  read(path: string): string;
  write(path: string, content: string): { bytes: number };
  list(path?: string): string[];
  del(path: string): boolean;
}

export function scopedFiles(root: string): FilesApi {
  const abs = resolve(root);
  const resolveSafe = (rel: string): string => {
    const p = resolve(abs, rel === '' ? '.' : String(rel ?? ''));
    if (p !== abs && !p.startsWith(abs + sep)) throw new Error(`files: path escapes the sandbox: "${rel}"`);
    return p;
  };
  return {
    read: (path) => readFileSync(resolveSafe(path), 'utf8'),
    write: (path, content) => {
      const p = resolveSafe(path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, String(content), 'utf8');
      return { bytes: String(content).length };
    },
    list: (path = '') => readdirSync(resolveSafe(path), { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)),
    del: (path) => {
      const p = resolveSafe(path);
      rmSync(p, { recursive: true, force: true });
      return true;
    },
  };
}

/* ------------------------------- capabilities ------------------------------- */

export interface CapsOptions {
  nodeKey: string;
  permissions: NodePermissions;
  fetchImpl?: typeof fetch;
  dnsLookup?: (host: string) => Promise<string[]>;
  kvStore?: KvStore;
  filesRoot?: string;
}

const defaultDns = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((r) => r.address);

/**
 * Build the sandbox globals for a custom node. All three are always present so
 * misuse fails with a helpful permission error instead of a ReferenceError.
 */
export function createCapabilities(opts: CapsOptions) {
  const perms = opts.permissions;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dnsLookup = opts.dnsLookup ?? defaultDns;
  const kv = opts.kvStore ?? sqliteKv(opts.nodeKey);
  const filesRoot = opts.filesRoot ?? join(process.cwd(), 'data', 'custom', opts.nodeKey);

  const need = (what: string) => {
    throw new Error(`capability "${what}" is not granted — enable it in the node's permissions`);
  };

  const gatedFetch = async (url: unknown, init?: RequestInit): Promise<Response> => {
    if (!perms.network.length) need('network');
    let u: URL;
    try { u = new URL(String(url)); } catch { throw new Error(`fetch: invalid URL`); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('fetch: only http(s) URLs are allowed');
    if (!hostAllowed(u.hostname, perms.network)) {
      throw new Error(`fetch: host "${u.hostname}" is not allowlisted (permissions.network)`);
    }
    const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
    if (!local) {
      let addrs: string[] = [];
      try { addrs = await dnsLookup(u.hostname); } catch { throw new Error(`fetch: cannot resolve "${u.hostname}"`); }
      if (addrs.some(isPrivateIp)) throw new Error(`fetch: "${u.hostname}" resolves to a private address (SSRF protection)`);
    }
    return fetchImpl(u.toString(), { ...init, signal: AbortSignal.timeout(10_000) });
  };

  const guardedKv: KvStore = perms.kv ? kv : withJson({
    get: () => need('kv') as never,
    set: () => need('kv') as never,
    del: () => need('kv') as never,
  });

  const guardedFiles: FilesApi = perms.files ? scopedFiles(filesRoot) : {
    read: () => need('files') as never,
    write: () => need('files') as never,
    list: () => need('files') as never,
    del: () => need('files') as never,
  };

  return { fetch: gatedFetch, kv: guardedKv, files: guardedFiles };
}
