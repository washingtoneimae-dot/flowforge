import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpConfig, saveMcpConfig, MCP_TOOL_NAMES } from './mcpConfig.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ff-mcp-'));

describe('mcpConfig', () => {
  it('returns defaults when no file exists', () => {
    const c = loadMcpConfig(freshRoot());
    expect(c.flowforgeUrl).toBe('http://localhost:3000');
    expect(c.disabledTools).toEqual([]);
  });
  it('round-trips save/load and drops unknown tools', () => {
    const root = freshRoot();
    const saved = saveMcpConfig(root, { flowforgeUrl: 'https://flow.example.com', disabledTools: ['run_workflow', 'nope' as any] });
    expect(saved.disabledTools).toEqual(['run_workflow']);
    expect(loadMcpConfig(root)).toEqual(saved);
  });
  it('recovers from corrupt files', () => {
    const root = freshRoot();
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'mcp-config.json'), '{broken');
    expect(loadMcpConfig(root).flowforgeUrl).toBe('http://localhost:3000');
  });
  it('knows all 18 tools', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(18);
  });
});
