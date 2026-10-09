import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Canonical MCP tool names. The settings page validates against this list. */
export const MCP_TOOL_NAMES = [
  'list_nodes', 'describe_node', 'find_node',
  'list_workflows', 'get_workflow', 'create_workflow', 'update_workflow', 'delete_workflow',
  'run_workflow', 'test_node',
  'create_custom_node', 'delete_custom_node', 'rollback_custom_node', 'set_custom_node_enabled',
  'export_workflow', 'import_workflow', 'list_executions', 'get_execution', 'list_credentials',
];

export interface McpConfig {
  /** Public base URL baked into generated client snippets. */
  flowforgeUrl: string;
  /** Tool names the MCP server will not register. */
  disabledTools: string[];
}

export const DEFAULT_MCP_CONFIG: McpConfig = {
  flowforgeUrl: 'http://localhost:3000',
  disabledTools: [],
};

/** data/mcp-config.json under the repo root (override with MCP_CONFIG_PATH). */
export function mcpConfigPath(repoRoot: string): string {
  if (process.env.MCP_CONFIG_PATH) return process.env.MCP_CONFIG_PATH;
  return join(repoRoot, 'data', 'mcp-config.json');
}

export function loadMcpConfig(repoRoot: string): McpConfig {
  try {
    const raw = readFileSync(mcpConfigPath(repoRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    return {
      flowforgeUrl: typeof parsed.flowforgeUrl === 'string' && parsed.flowforgeUrl ? parsed.flowforgeUrl : DEFAULT_MCP_CONFIG.flowforgeUrl,
      disabledTools: Array.isArray(parsed.disabledTools)
        ? parsed.disabledTools.filter((t): t is string => typeof t === 'string' && MCP_TOOL_NAMES.includes(t))
        : [],
    };
  } catch {
    return { ...DEFAULT_MCP_CONFIG };
  }
}

export function saveMcpConfig(repoRoot: string, config: McpConfig): McpConfig {
  const clean: McpConfig = {
    flowforgeUrl: config.flowforgeUrl?.trim() || DEFAULT_MCP_CONFIG.flowforgeUrl,
    disabledTools: [...new Set((config.disabledTools ?? []).filter((t) => MCP_TOOL_NAMES.includes(t)))],
  };
  const path = mcpConfigPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2));
  return clean;
}

export function mcpDistExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, 'apps', 'mcp', 'dist', 'index.js'));
}
