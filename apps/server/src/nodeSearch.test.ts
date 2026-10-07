import { describe, it, expect } from 'vitest';
import { scoreNode, searchNodes, workflowUsage } from './nodeSearch.js';

const catalog = [
  { key: 'upperCase', displayName: 'Uppercase', description: 'Uppercase a text field', category: 'data', kind: 'action', custom: true },
  { key: 'sendEmail', displayName: 'Send Email', description: 'Send an email message', category: 'network', kind: 'action', custom: false },
  { key: 'crypto', displayName: 'Crypto', description: 'Hash a value or generate id', category: 'data', kind: 'action', custom: false },
];

describe('searchNodes', () => {
  it('finds by description keywords', () => {
    const r = searchNodes('send a message', catalog, new Map());
    expect(r[0].key).toBe('sendEmail');
  });
  it('prefers exact key matches', () => {
    const r = searchNodes('crypto', catalog, new Map());
    expect(r[0].key).toBe('crypto');
  });
  it('weights past usage as tiebreak', () => {
    const usage = new Map([['sendEmail', 4]]);
    const r = searchNodes('email message text', catalog, usage);
    expect(r[0].key).toBe('sendEmail');
    expect(r[0].reasons.join(' ')).toMatch(/workflow/);
  });
  it('returns nothing for empty or unmatched queries', () => {
    expect(searchNodes('', catalog, new Map())).toEqual([]);
    expect(searchNodes('zzzznothing', catalog, new Map())).toEqual([]);
  });
});

describe('workflowUsage', () => {
  it('counts workflows per node type once each', () => {
    const m = workflowUsage([
      { nodes: [{ type: 'a' }, { type: 'a' }, { type: 'b' }] },
      { nodes: [{ type: 'a' }] },
    ]);
    expect(m.get('a')).toBe(2);
    expect(m.get('b')).toBe(1);
  });
});
