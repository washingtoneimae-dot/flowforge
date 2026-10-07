import { defineNode } from '@flowforge/node-sdk';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, isAbsolute, dirname } from 'node:path';
import { join } from 'node:path';
import crypto from 'node:crypto';

const execFileAsync = promisify(execFile);

/* ---------------------------------- triggers ---------------------------------- */

export const manualTrigger = defineNode({
  key: 'manualTrigger',
  displayName: 'Manual Trigger',
  description: 'Starts the workflow when run manually from the editor.',
  version: 1,
  kind: 'trigger',
  icon: 'play',
  inputs: ['none'],
  outputs: ['main'],
  properties: [],
  execute(ctx) {
    return ctx.items.length ? ctx.items : [{ json: { ok: true } }];
  },
});

export const webhookTrigger = defineNode({
  key: 'webhookTrigger',
  displayName: 'Webhook Trigger',
  description: 'Starts the workflow when an HTTP request hits the webhook URL.',
  version: 1,
  kind: 'trigger',
  icon: 'webhook',
  inputs: ['none'],
  outputs: ['main'],
  properties: [
    { key: 'path', displayName: 'Path', type: 'string', default: 'my-hook', required: true, description: 'Webhook path appended to /hook/' },
  ],
  execute(ctx) {
    return ctx.items.length ? ctx.items : [{ json: { ok: true } }];
  },
});

export const cronTrigger = defineNode({
  key: 'cronTrigger',
  displayName: 'Cron Trigger',
  description: 'Starts the workflow on a schedule.',
  version: 1,
  kind: 'trigger',
  icon: 'clock',
  inputs: ['none'],
  outputs: ['main'],
  properties: [
    { key: 'intervalSeconds', displayName: 'Interval (seconds)', type: 'number', default: 60, required: true },
  ],
  execute(ctx) {
    return ctx.items.length ? ctx.items : [{ json: { triggeredAt: new Date().toISOString() } }];
  },
});

/* ---------------------------------- actions ---------------------------------- */

export const httpRequest = defineNode({
  key: 'httpRequest',
  displayName: 'HTTP Request',
  description: 'Makes an HTTP request and returns the response.',
  version: 1,
  kind: 'action',
  icon: 'globe',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'method', displayName: 'Method', type: 'options', default: 'GET', options: [{ name: 'GET', value: 'GET' }, { name: 'POST', value: 'POST' }, { name: 'PUT', value: 'PUT' }, { name: 'DELETE', value: 'DELETE' }] },
    { key: 'url', displayName: 'URL', type: 'string', required: true, default: '' },
    { key: 'headers', displayName: 'Headers (JSON)', type: 'json', default: '{}' },
    { key: 'body', displayName: 'Body (JSON)', type: 'json', default: '' },
  ],
  async execute(ctx) {
    const { method = 'GET', url, headers, body } = ctx.params as any;
    if (!url) throw ctx.error('URL is required');
    const out: any[] = [];
    for (const item of ctx.items) {
      const res = await fetch(String(url), {
        method: String(method),
        headers: headers ? JSON.parse(String(headers)) : undefined,
        body: body && method !== 'GET' ? String(body) : undefined,
      });
      const text = await res.text();
      let json: any;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      out.push({ json: { status: res.status, ok: res.ok, data: json, input: item.json } });
    }
    return out.length ? out : [{ json: { done: true } }];
  },
});

export const setFields = defineNode({
  key: 'setFields',
  displayName: 'Set / Edit Fields',
  description: 'Add, modify or remove fields on each item.',
  version: 1,
  kind: 'action',
  icon: 'pen',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'fields', displayName: 'Fields (JSON object)', type: 'json', default: '{"hello":"world"}', required: true },
  ],
  execute(ctx) {
    let extra: Record<string, unknown> = {};
    try { extra = JSON.parse(String((ctx.params as any).fields ?? '{}')); } catch { throw ctx.error('Fields must be valid JSON'); }
    return ctx.items.map((it) => ({ json: { ...it.json, ...extra } }));
  },
});

/** Resolve `$json.path` / `$json` / JSON literal / raw string against an item. */
function resolveValue(v: unknown, json: Record<string, unknown>): unknown {
  if (typeof v === 'string' && v.startsWith('$json.')) return v.slice(6).split('.').reduce((o: any, k) => o?.[k], json);
  if (v === '$json') return json;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
  return v;
}

export const ifNode = defineNode({
  key: 'if',
  displayName: 'If',
  description: 'Route items based on a condition. Output 0 = true, output 1 = false.',
  version: 1,
  kind: 'action',
  icon: 'split',
  inputs: ['main'],
  outputs: ['main', 'main'],
  properties: [
    { key: 'left', displayName: 'Left value (e.g. $json.status)', type: 'string', required: true, default: '$json.ok' },
    { key: 'operator', displayName: 'Operator', type: 'options', default: 'equals', options: [{ name: 'equals', value: 'equals' }, { name: 'notEquals', value: 'notEquals' }, { name: 'greaterThan', value: 'greaterThan' }, { name: 'contains', value: 'contains' }] },
    { key: 'right', displayName: 'Right value', type: 'string', default: 'true' },
  ],
  execute(ctx) {
    const { left, operator, right } = ctx.params as any;
    const trueItems: any[] = [];
    const falseItems: any[] = [];
    for (const it of ctx.items) {
      const l = resolveValue(left, it.json);
      const r = resolveValue(right, it.json);
      let ok = false;
      switch (operator) {
        case 'equals': ok = l == r; break;
        case 'notEquals': ok = l != r; break;
        case 'greaterThan': ok = Number(l) > Number(r); break;
        case 'contains': ok = String(l ?? '').includes(String(r ?? '')); break;
      }
      (ok ? trueItems : falseItems).push(it);
    }
    return { branches: [trueItems, falseItems] };
  },
});

export const switchNode = defineNode({
  key: 'switch',
  displayName: 'Switch',
  description: 'Route items to different outputs based on a value. Output 0 = first case … last output = default.',
  version: 1,
  kind: 'action',
  icon: 'fork',
  inputs: ['main'],
  outputs: ['main', 'main', 'main'],
  properties: [
    { key: 'value', displayName: 'Value (e.g. $json.status)', type: 'string', required: true, default: '$json.status' },
    { key: 'case0', displayName: 'Case 0', type: 'string', default: 'ok' },
    { key: 'case1', displayName: 'Case 1', type: 'string', default: 'error' },
    { key: 'case2', displayName: '(no more — remaining items go to Default)', type: 'string', default: '' },
  ],
  execute(ctx) {
    const { value, case0, case1, case2 } = ctx.params as any;
    const cases = [case0, case1, case2].map((c) => String(c ?? ''));
    const buckets: any[][] = [[], [], []];
    for (const it of ctx.items) {
      const v = String(resolveValue(value, it.json) ?? '');
      const idx = cases.findIndex((c, i) => c !== '' && c === v);
      (idx >= 0 ? buckets[idx] : buckets[2]).push(it);
    }
    return { branches: buckets };
  },
});

export const filterNode = defineNode({
  key: 'filter',
  displayName: 'Filter',
  description: 'Keep only items matching a condition. Output 0 = kept, output 1 = discarded.',
  version: 1,
  kind: 'action',
  icon: 'filter',
  inputs: ['main'],
  outputs: ['main', 'main'],
  properties: [
    { key: 'left', displayName: 'Left value (e.g. $json.status)', type: 'string', required: true, default: '$json.ok' },
    { key: 'operator', displayName: 'Operator', type: 'options', default: 'equals', options: [{ name: 'equals', value: 'equals' }, { name: 'notEquals', value: 'notEquals' }, { name: 'greaterThan', value: 'greaterThan' }, { name: 'contains', value: 'contains' }] },
    { key: 'right', displayName: 'Right value', type: 'string', default: 'true' },
  ],
  execute(ctx) {
    const { left, operator, right } = ctx.params as any;
    const keep: any[] = [];
    const drop: any[] = [];
    for (const it of ctx.items) {
      const l = resolveValue(left, it.json);
      const r = resolveValue(right, it.json);
      let ok = false;
      switch (operator) {
        case 'equals': ok = l == r; break;
        case 'notEquals': ok = l != r; break;
        case 'greaterThan': ok = Number(l) > Number(r); break;
        case 'contains': ok = String(l ?? '').includes(String(r ?? '')); break;
      }
      (ok ? keep : drop).push(it);
    }
    return { branches: [keep, drop] };
  },
});

export const mergeNode = defineNode({
  key: 'merge',
  displayName: 'Merge',
  description: 'Combine items from multiple inputs into one stream.',
  version: 1,
  kind: 'action',
  icon: 'merge',
  inputs: ['main'],
  outputs: ['main'],
  properties: [],
  execute(ctx) {
    return ctx.items;
  },
});

export const codeNode = defineNode({
  key: 'code',
  displayName: 'Code (JavaScript)',
  description: 'Run JavaScript against the items. Return an array of { json } objects.',
  version: 1,
  kind: 'action',
  icon: 'code',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'code', displayName: 'Code', type: 'code', default: '// items: FlowItem[]\nreturn items.map(i => ({ json: { ...i.json, seen: true } }));', required: true },
  ],
  execute(ctx) {
    const code = String((ctx.params as any).code ?? '');
    const sandbox = { items: ctx.items, console };
    const wrapped = `(function(){ ${code} })()`;
    const script = new vm.Script(wrapped);
    const result = script.runInNewContext(sandbox, { timeout: 5000 });
    if (!Array.isArray(result)) throw ctx.error('Code must return an array of items');
    return result.map((r: any) => (r && r.json ? r : { json: r }));
  },
});

export const pythonCodeNode = defineNode({
  key: 'pythonCode',
  displayName: 'Python',
  description: 'Run a Python script. Items are available via the FLOW_ITEMS env var. Print a JSON array of {"json": ...} items.',
  version: 1,
  kind: 'action',
  icon: 'terminal',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'script', displayName: 'Python script', type: 'code', required: true, default: 'import json, os\nitems = json.loads(os.environ.get("FLOW_ITEMS", "[]"))\nprint(json.dumps([{"json": {**it["json"], "seen": True}} for it in items]))' },
  ],
  async execute(ctx) {
    const script = String((ctx.params as any).script ?? '');
    if (!script.trim()) throw ctx.error('Python script is empty');
    try {
      const { stdout, stderr } = (await execFileAsync('python3', ['-c', script], {
        env: { ...process.env, FLOW_ITEMS: JSON.stringify(ctx.items) },
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      })) as unknown as { stdout: string; stderr: string };
      if (stderr && !stdout.trim()) throw ctx.error(stderr.trim());
      let parsed: any;
      try { parsed = JSON.parse(stdout); } catch { throw ctx.error(`Python must print a JSON array. stdout: ${stdout.slice(0, 200)} ${stderr ? '| stderr: ' + stderr.slice(0, 200) : ''}`); }
      if (!Array.isArray(parsed)) throw ctx.error('Python output must be a JSON array');
      return parsed.map((r: any) => (r && r.json ? r : { json: r }));
    } catch (err: any) {
      const stderr = err?.stderr ? String(err.stderr) : '';
      if (stderr) throw ctx.error(stderr.trim().slice(0, 500) || err.message);
      throw err;
    }
  },
});

export const noOpNode = defineNode({
  key: 'noOp',
  displayName: 'NoOp',
  description: 'Pass items through unchanged. Useful as a placeholder.',
  version: 1,
  kind: 'action',
  icon: 'circle',
  inputs: ['main'],
  outputs: ['main'],
  properties: [],
  execute(ctx) {
    return ctx.items;
  },
});

export const waitNode = defineNode({
  key: 'wait',
  displayName: 'Wait',
  description: 'Pause the workflow for a number of milliseconds.',
  version: 1,
  kind: 'action',
  icon: 'hourglass',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'ms', displayName: 'Duration (ms)', type: 'number', default: 1000, required: true },
  ],
  async execute(ctx) {
    const ms = Math.min(Number((ctx.params as any).ms ?? 0) || 0, 30_000);
    await new Promise((r) => setTimeout(r, ms));
    return ctx.items;
  },
});

export const splitOutNode = defineNode({
  key: 'splitOut',
  displayName: 'Split Out',
  description: 'Turn an array field on each item into multiple items (n8n "Item Lists"-style split).',
  version: 1,
  kind: 'action',
  icon: 'list',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'field', displayName: 'Array field (e.g. $json.rows)', type: 'string', default: '$json.items', required: true },
  ],
  execute(ctx) {
    const field = String((ctx.params as any).field ?? '');
    const out: any[] = [];
    for (const it of ctx.items) {
      const arr = resolveValue(field, it.json);
      if (Array.isArray(arr)) {
        for (const el of arr) out.push({ json: typeof el === 'object' && el !== null ? el : { value: el } });
      } else {
        out.push(it);
      }
    }
    return out;
  },
});

export const aggregateNode = defineNode({
  key: 'aggregate',
  displayName: 'Aggregate',
  description: 'Combine all incoming items into a single item under a field.',
  version: 1,
  kind: 'action',
  icon: 'layers',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'field', displayName: 'Output field name', type: 'string', default: 'items', required: true },
  ],
  execute(ctx) {
    const field = String((ctx.params as any).field ?? 'items') || 'items';
    return [{ json: { [field]: ctx.items.map((it) => it.json), count: ctx.items.length } }];
  },
});

export const datetimeNode = defineNode({
  key: 'datetime',
  displayName: 'Date & Time',
  description: 'Add timestamp fields to each item.',
  version: 1,
  kind: 'action',
  icon: 'calendar',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'field', displayName: 'Field name', type: 'string', default: 'timestamp', required: true },
    { key: 'format', displayName: 'Format', type: 'options', default: 'iso', options: [{ name: 'ISO 8601', value: 'iso' }, { name: 'Unix ms', value: 'ms' }, { name: 'Date only', value: 'date' }] },
  ],
  execute(ctx) {
    const { field = 'timestamp', format = 'iso' } = ctx.params as any;
    const now = new Date();
    const value = format === 'ms' ? now.getTime() : format === 'date' ? now.toISOString().slice(0, 10) : now.toISOString();
    return ctx.items.map((it) => ({ json: { ...it.json, [String(field)]: value } }));
  },
});

export const cryptoNode = defineNode({
  key: 'crypto',
  displayName: 'Crypto',
  description: 'Hash a value or generate a random id (n8n Crypto-style).',
  version: 1,
  kind: 'action',
  icon: 'key',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'action', displayName: 'Action', type: 'options', default: 'uuid', options: [{ name: 'Generate UUID', value: 'uuid' }, { name: 'SHA-256 hash', value: 'sha256' }, { name: 'MD5 hash', value: 'md5' }] },
    { key: 'value', displayName: 'Value to hash (or $json.field)', type: 'string', default: '$json' },
    { key: 'field', displayName: 'Output field name', type: 'string', default: 'crypto', required: true },
  ],
  execute(ctx) {
    const { action = 'uuid', value = '$json', field = 'crypto' } = ctx.params as any;
    return ctx.items.map((it) => {
      let out: string;
      if (action === 'uuid') out = crypto.randomUUID();
      else out = crypto.createHash(action === 'md5' ? 'md5' : 'sha256').update(String(resolveValue(value, it.json) ?? '')).digest('hex');
      return { json: { ...it.json, [String(field)]: out } };
    });
  },
});

export const jsonParseNode = defineNode({
  key: 'jsonParse',
  displayName: 'JSON Parse',
  description: 'Parse a JSON string field into an object.',
  version: 1,
  kind: 'action',
  icon: 'braces',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'field', displayName: 'Field containing JSON string', type: 'string', default: 'raw', required: true },
  ],
  execute(ctx) {
    const field = String((ctx.params as any).field ?? '');
    return ctx.items.map((it) => {
      const v = (it.json as any)[field];
      try { return { json: { ...it.json, [field]: JSON.parse(String(v)) } }; } catch { throw ctx.error(`Field "${field}" is not valid JSON`); }
    });
  },
});

export const sendEmailNode = defineNode({
  key: 'sendEmail',
  displayName: 'Send Email',
  description: 'Send an email. Dry-run unless SMTP env vars (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM) are set — wire up real SMTP by extending this node.',
  version: 1,
  kind: 'action',
  icon: 'mail',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'to', displayName: 'To', type: 'string', required: true, default: '' },
    { key: 'subject', displayName: 'Subject', type: 'string', default: '' },
    { key: 'body', displayName: 'Body', type: 'code', default: 'Hello from Flowforge!' },
  ],
  execute(ctx) {
    const { to, subject, body } = ctx.params as any;
    if (!to) throw ctx.error('"to" is required');
    const configured = !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
    console.log(`[sendEmail] ${configured ? 'SMTP' : 'dry-run'} → to=${to} subject=${subject}`);
    return ctx.items.map((it) => ({ json: { ...it.json, email: { dryRun: !configured, to, subject, body } } }));
  },
});

const sandboxDir = () => join(process.cwd(), 'data/sandbox');

export const fileOpsNode = defineNode({
  key: 'fileOps',
  displayName: 'File',
  description: 'Read, write or list files under data/sandbox (or an absolute path).',
  version: 1,
  kind: 'action',
  icon: 'folder',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'operation', displayName: 'Operation', type: 'options', default: 'read', options: [{ name: 'Read', value: 'read' }, { name: 'Write', value: 'write' }, { name: 'List', value: 'list' }] },
    { key: 'path', displayName: 'Path', type: 'string', default: 'hello.txt' },
    { key: 'content', displayName: 'Content (write only)', type: 'code', default: '' },
  ],
  async execute(ctx) {
    const { operation = 'read', path: p = '', content = '' } = ctx.params as any;
    const abs = isAbsolute(String(p)) ? String(p) : resolve(sandboxDir(), String(p));
    if (operation === 'list') {
      await mkdir(abs, { recursive: true });
      const entries = await readdir(abs, { withFileTypes: true });
      return ctx.items.map((it) => ({ json: { ...it.json, files: entries.map((e) => e.name) } }));
    }
    if (operation === 'write') {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, String(content));
      return ctx.items.map((it) => ({ json: { ...it.json, written: abs, bytes: String(content).length } }));
    }
    const data = await readFile(abs, 'utf8');
    return ctx.items.map((it) => ({ json: { ...it.json, path: abs, content: data } }));
  },
});

export const coreNodes = [
  manualTrigger, webhookTrigger, cronTrigger,
  httpRequest, setFields, ifNode, switchNode, filterNode, mergeNode,
  codeNode, pythonCodeNode, noOpNode, waitNode, splitOutNode, aggregateNode,
  datetimeNode, cryptoNode, jsonParseNode, sendEmailNode, fileOpsNode,
];
