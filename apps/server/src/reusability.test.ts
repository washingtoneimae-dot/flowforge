import { describe, it, expect } from 'vitest';
import { normalizeDocs, contractLine, analyzeStatic, usagePoints, gradeFor, computeReusability } from './reusability.js';

describe('normalizeDocs + contractLine', () => {
  it('trims and caps fields', () => {
    expect(normalizeDocs({ action: ' Fetches price ', target: '', output: 'x'.repeat(200) }).output).toHaveLength(140);
    expect(normalizeDocs(null)).toEqual({});
  });
  it('composes Action Target → Output', () => {
    expect(contractLine({ action: 'Fetches price of', target: 'Bitcoin (CoinGecko)', output: 'appends btc_price to json' }))
      .toBe('Fetches price of Bitcoin (CoinGecko) → appends btc_price to json');
    expect(contractLine({}, 'fallback')).toBe('fallback');
  });
});

describe('analyzeStatic', () => {
  it('rewards params-driven generic code', () => {
    const s = analyzeStatic('const f = params.field; return items.map(i => ({ json: { ...i.json, [f]: 1 } }));', { network: [], kv: false, files: false }, {});
    expect(s.configurability).toBeGreaterThanOrEqual(12);
    expect(s.composability).toBeGreaterThanOrEqual(20);
  });
  it('docks hardcoded URLs', () => {
    const clean = analyzeStatic('return items;', { network: [], kv: false, files: false }, {});
    const hard = analyzeStatic('const r = await fetch("https://api.example.com/x"); return items;', { network: ['api.example.com'], kv: false, files: false }, {});
    expect(hard.configurability).toBeLessThan(clean.configurability);
    expect(hard.permissions).toBeLessThan(25);
  });
  it('penalizes wildcards more than exact hosts', () => {
    const exact = analyzeStatic('return items;', { network: ['a.com'], kv: false, files: false }, {});
    const wild = analyzeStatic('return items;', { network: ['*.a.com'], kv: false, files: false }, {});
    expect(wild.permissions).toBeLessThan(exact.permissions);
  });
  it('rewards least privilege', () => {
    const pure = analyzeStatic('return items;', { network: [], kv: false, files: false }, {});
    expect(pure.permissions).toBe(25);
    const wide = analyzeStatic('return items;', { network: ['a.com', 'b.com'], kv: true, files: true }, {});
    expect(wide.permissions).toBeLessThan(pure.permissions);
  });
  it('docks destructive literals, rewards branches', () => {
    const dest = analyzeStatic('return [{ json: { fixed: 1 } }];', { network: [], kv: false, files: false }, {});
    const rout = analyzeStatic('return { branches: [items, []] };', { network: [], kv: false, files: false }, {});
    expect(dest.composability).toBeLessThan(rout.composability);
  });
  it('rewards the docs triple', () => {
    const none = analyzeStatic('return items;', { network: [], kv: false, files: false }, {});
    const full = analyzeStatic('return items;', { network: [], kv: false, files: false }, { action: 'A', target: 'B', output: 'C' });
    expect(full.documentation).toBe(5);
    expect(none.documentation).toBe(0);
  });
});

describe('usage + grades', () => {
  it('ramps with workflows and recent runs', () => {
    expect(usagePoints(0, 0).points).toBe(0);
    expect(usagePoints(1, 0).points).toBe(6);
    expect(usagePoints(5, 10).points).toBe(15);
  });
  it('grades bands', () => {
    expect(gradeFor(95)).toBe('A');
    expect(gradeFor(80)).toBe('B');
    expect(gradeFor(60)).toBe('C');
    expect(gradeFor(40)).toBe('D');
    expect(gradeFor(10)).toBe('F');
  });
  it('combines static + usage, capped at 100', () => {
    const r = computeReusability('return items.map(i => ({ json: { ...i.json } }));', { network: [], kv: false, files: false }, { action: 'A', target: 'B', output: 'C' }, 5, 10);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.grade).toMatch(/[A-F]/);
  });
});
