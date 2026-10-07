import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizePermissions, hostAllowed, isPrivateIp,
  createCapabilities, memoryKv, scopedFiles,
} from './capabilities.js';
import { runCustomCode } from './customNodes.js';

describe('normalizePermissions', () => {
  it('defaults to nothing granted', () => {
    expect(normalizePermissions(undefined)).toEqual({ network: [], kv: false, files: false });
  });
  it('lowercases hosts and keeps flags', () => {
    expect(normalizePermissions({ network: ['API.Example.com', '*.Foo.io'], kv: true, files: 0 }))
      .toEqual({ network: ['api.example.com', '*.foo.io'], kv: true, files: false });
  });
  it('rejects bad hosts', () => {
    expect(() => normalizePermissions({ network: ['not a host!!'] })).toThrow(/bad host/);
    expect(() => normalizePermissions({ network: 'example.com' })).toThrow(/array/);
  });
});

describe('hostAllowed', () => {
  const allow = ['api.example.com', '*.cdn.example.com'];
  it('matches exact and wildcard', () => {
    expect(hostAllowed('api.example.com', allow)).toBe(true);
    expect(hostAllowed('API.EXAMPLE.COM', allow)).toBe(true);
    expect(hostAllowed('a.cdn.example.com', allow)).toBe(true);
    expect(hostAllowed('cdn.example.com', allow)).toBe(false);
    expect(hostAllowed('evil.com', allow)).toBe(false);
    expect(hostAllowed('api.example.com.evil.com', allow)).toBe(false);
  });
});

describe('isPrivateIp', () => {
  it('flags private and loopback ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.5', '169.254.1.1', '::1', 'fc00::1', 'fe80::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    expect(isPrivateIp('172.15.0.1')).toBe(false);
    expect(isPrivateIp('172.32.0.1')).toBe(false);
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('gated fetch', () => {
  const okFetch = (async (url: string) => new Response(`got ${url}`)) as typeof fetch;
  const pubDns = async () => ['93.184.216.34'];
  it('allows allowlisted public hosts', async () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: ['example.com'], kv: false, files: false }, fetchImpl: okFetch, dnsLookup: pubDns });
    const res = await caps.fetch('https://example.com/api');
    expect(await res.text()).toBe('got https://example.com/api');
  });
  it('blocks non-allowlisted hosts', async () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: ['example.com'], kv: false, files: false }, fetchImpl: okFetch, dnsLookup: pubDns });
    await expect(caps.fetch('https://evil.com/')).rejects.toThrow(/not allowlisted/);
  });
  it('blocks SSRF to private addresses', async () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: ['internal.corp'], kv: false, files: false }, fetchImpl: okFetch, dnsLookup: async () => ['10.0.0.5'] });
    await expect(caps.fetch('https://internal.corp/')).rejects.toThrow(/private address/);
  });
  it('rejects non-http protocols', async () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: ['example.com'], kv: false, files: false }, fetchImpl: okFetch, dnsLookup: pubDns });
    await expect(caps.fetch('file:///etc/passwd')).rejects.toThrow(/only http/);
  });
});

describe('kv', () => {
  it('round-trips strings and JSON', () => {
    const kv = memoryKv();
    kv.set('a', '1');
    kv.setJson('b', { x: [1, 2] });
    expect(kv.get('a')).toBe('1');
    expect(kv.getJson('b')).toEqual({ x: [1, 2] });
    kv.del('a');
    expect(kv.get('a')).toBeUndefined();
  });
  it('is denied without the permission', () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: [], kv: false, files: false } });
    expect(() => caps.kv.get('a')).toThrow(/not granted/);
  });
});

describe('scoped files', () => {
  it('reads/writes/lists inside the root and rejects escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'ff-files-'));
    const f = scopedFiles(root);
    expect(f.write('a/b.txt', 'hi').bytes).toBe(2);
    expect(f.read('a/b.txt')).toBe('hi');
    expect(f.list('')).toContain('a/');
    expect(() => f.read('../../etc/passwd')).toThrow(/escapes/);
    expect(() => f.write('/abs', 'x')).toThrow(/escapes/);
  });
  it('is denied without the permission', () => {
    const caps = createCapabilities({ nodeKey: 't', permissions: { network: [], kv: false, files: false } });
    expect(() => caps.files.list()).toThrow(/not granted/);
  });
});

describe('runCustomCode with capabilities', () => {
  it('runs async fetch code with stubbed network', async () => {
    const out: any = await runCustomCode(
      'const r = await fetch("https://example.com/x"); const t = await r.text(); return items.map(i => ({ json: { ...i.json, t } }));',
      { params: {}, items: [{ json: {} }] },
      {
        nodeKey: 't',
        permissions: { network: ['example.com'], kv: false, files: false },
        fetchImpl: (async (u: string) => new Response('hello')) as typeof fetch,
        dnsLookup: async () => ['93.184.216.34'],
      },
    );
    expect(out).toEqual([{ json: { t: 'hello' } }]);
  });
  it('persists kv across runs via injected store', async () => {
    const kvStore = memoryKv();
    const code = 'const n = (kv.getJson("count") ?? 0) + 1; kv.setJson("count", n); return [{ json: { n } }];';
    const base = { params: {}, items: [{ json: {} }] };
    const perms = { network: [], kv: true, files: false };
    expect(await runCustomCode(code, base, { nodeKey: 't', permissions: perms, kvStore })).toEqual([{ json: { n: 1 } }]);
    expect(await runCustomCode(code, base, { nodeKey: 't', permissions: perms, kvStore })).toEqual([{ json: { n: 2 } }]);
  });
  it('exposes expr() in the sandbox', async () => {
    const out: any = await runCustomCode('return [{ json: { u: expr("user-{{ $json.id }}", items[0]) } }];', { params: {}, items: [{ json: { id: 9 } }] });
    expect(out).toEqual([{ json: { u: 'user-9' } }]);
  });
});
