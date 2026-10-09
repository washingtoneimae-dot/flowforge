export * from './mcpConfig.js';

/** A unit of data flowing through the workflow. Mirrors n8n's `{ json }` shape. */
export interface FlowItem {
  json: Record<string, unknown>;
  binary?: Record<string, { data: string; mimeType: string; fileName?: string }>;
}

export type MaybePromise<T> = T | Promise<T>;

/** Options passed to a node's execute(). */
export interface NodeExecuteContext {
  /** Parameters configured by the user for this node instance. */
  params: Record<string, unknown>;
  /** Everything the trigger (or previous run) produced. */
  items: FlowItem[];
  /** Key/value store for shared execution state. */
  vars: Record<string, unknown>;
  /** Workflow metadata. */
  workflow: { id: string; name: string };
  /** Current execution id (set by the engine; 'test' for single-node tests). */
  executionId?: string;
  /** Id of the node instance being executed. */
  nodeId?: string;
  /** Resolve `{{ }}` expressions against one item (`$json`, `$vars`, `$params` in scope). */
  expr(template: unknown, item: FlowItem): unknown;
  /** Throw a typed node error instead of a generic one. */
  error(message: string): Error;
}

export type NodePropertyType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'options'
  | 'collection'
  | 'json'
  | 'code'
  | 'file'
  | 'credential';

export interface NodeProperty {
  key: string;
  displayName: string;
  type: NodePropertyType;
  default?: unknown;
  required?: boolean;
  description?: string;
  /** For type: 'options' */
  options?: Array<{ name: string; value: string | number | boolean }>;
  /** For type: 'collection' — nested fields */
  properties?: NodeProperty[];
  /** For type: 'file' — which jail the browser lists */
  fileScope?: 'sandbox' | 'custom' | 'device';
  /** For type: 'credential' — hint for the picker (e.g. 'token', 'userpass') */
  credentialType?: string;
}

export interface NodeDefinition {
  key: string;
  displayName: string;
  description: string;
  version: number;
  /** 'trigger' nodes start a workflow; 'action' nodes transform data. */
  kind: 'trigger' | 'action';
  /** Library grouping: triggers, logic, data, code, network, files, flow, custom. */
  category?: string;
  /** Lucide/emoji icon hint, resolved by the UI when available. */
  icon?: string;
  inputs: ('main' | 'none')[];
  outputs: ('main' | 'boolean' | 'throw')[];
  properties: NodeProperty[];
  /** Per-node run cap in ms. Overrides the engine default (30s) — used by
   *  long-waiting nodes such as Approval. */
  timeoutMs?: number;
  execute(ctx: NodeExecuteContext): MaybePromise<FlowItem[] | BranchOutput>;
}

/** For nodes with multiple outputs (e.g. If: true/false). */
export interface BranchOutput {
  branches: FlowItem[][];
}

export function defineNode(def: NodeDefinition): NodeDefinition {
  if (!def.key || !def.execute) throw new Error('Node must have a key and execute()');
  return def;
}
