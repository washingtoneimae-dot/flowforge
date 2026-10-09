import { defineNode } from '@flowforge/node-sdk';
import { approvalNode } from './approval.js';
import { githubNode } from './github.js';
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
  description: 'Runs the workflow on demand from the editor → passes run items through (or one { ok: true } item).',
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
  description: 'Starts the workflow on requests to /hook/:path → emits { method, query, body, headers }.',
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
  description: 'Starts the workflow on a schedule → emits { scheduled: true, at }. Set a 5-field cron expression, or leave it empty for every-N-seconds.',
  version: 1,
  kind: 'trigger',
  icon: 'clock',
  inputs: ['none'],
  outputs: ['main'],
  properties: [
    { key: 'intervalSeconds', displayName: 'Interval (seconds)', type: 'number', default: 60, required: true, description: 'Used when Cron expression is empty' },
    { key: 'cron', displayName: 'Cron expression (minute hour dom month dow)', type: 'string', default: '', description: 'e.g. "*/15 9-17 * * mon-fri". Wins over Interval when set' },
  ],
  execute(ctx) {
    return ctx.items.length ? ctx.items : [{ json: { triggeredAt: new Date().toISOString() } }];
  },
});

/* ---------------------------------- actions ---------------------------------- */

export const httpRequest = defineNode({
  key: 'httpRequest',
  displayName: 'HTTP Request',
  description: 'Sends an HTTP request with {{ }}-aware URL/headers/body → appends { status, ok, data } per item.',
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
    { key: 'credential', displayName: 'Credential (optional)', type: 'credential', default: '', credentialType: 'token', description: 'Named secret from Settings → Credentials; sets Authorization unless headers already do' },
  ],
  async execute(ctx) {
    const { method = 'GET', url: rawUrl, headers: rawHeaders, body: rawBody } = ctx.params as any;
    const url = rawUrl ? String(rawUrl) : '';
    if (!url) throw ctx.error('URL is required');
    const out: any[] = [];
    for (const item of ctx.items) {
      const resolvedUrl = String(ctx.expr(url, item) ?? '');
      if (!resolvedUrl) throw ctx.error('URL resolved to empty');
      const headersStr = rawHeaders ? String(ctx.expr(rawHeaders, item) ?? '') : '';
      let headers: Record<string, string> = {};
      try { headers = headersStr ? JSON.parse(headersStr) : {}; } catch { throw ctx.error('Headers must be valid JSON (after resolving expressions)'); }
      const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
      const cred = (ctx.params as any).credential;
      if (!hasAuth && cred && typeof cred === 'object') {
        if (typeof cred.token === 'string' && cred.token) headers.Authorization = `Bearer ${cred.token}`;
        else if (typeof cred.username === 'string' && typeof cred.password === 'string') {
          headers.Authorization = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`;
        }
      }
      const bodyStr = rawBody && method !== 'GET' ? String(ctx.expr(rawBody, item) ?? '') : '';
      const res = await fetch(resolvedUrl, {
        method: String(method),
        headers: Object.keys(headers).length ? headers : undefined,
        body: bodyStr || undefined,
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
  description: 'Merges a JSON object into each item ({{ }}-aware values) → same items with new fields.',
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
    const out: any[] = [];
    for (const it of ctx.items) {
      const resolved = String(ctx.expr(String((ctx.params as any).fields ?? '{}'), it) ?? '{}');
      try { extra = JSON.parse(resolved); } catch { throw ctx.error('Fields must be valid JSON (after resolving expressions)'); }
      out.push({ json: { ...it.json, ...extra } });
    }
    return out;
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
  description: 'Splits items on a condition → output 0 true, output 1 false.',
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
  description: 'Routes each item by matching value against cases → one output per case, last is default.',
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
  description: 'Keeps matching items and drops the rest → output 0 kept, output 1 discarded.',
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
  description: 'Combines multiple input streams → one stream with every item.',
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
  description: 'Runs sandboxed JavaScript with items in scope → must return an array of items.',
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
  description: 'Runs a Python script with items via FLOW_ITEMS → must print a JSON array of items.',
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
  description: 'Does nothing → passes items through unchanged.',
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
  description: 'Pauses the run for N ms (max 30s) → same items, delayed.',
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
  description: 'Expands an array field into one item per element → many items.',
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
  description: 'Folds all items into one → single item { <field>: [...], count }.',
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
  description: 'Stamps each item with the current time → same items plus the time field.',
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
  description: 'Hashes a value or mints a UUID → same items plus the output field.',
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
    const { action = 'uuid', value: rawValue = '$json', field = 'crypto' } = ctx.params as any;
    return ctx.items.map((it) => {
      const s = String(rawValue ?? '');
      const resolved = s.includes('{{') ? ctx.expr(rawValue, it) : resolveValue(rawValue, it.json);
      let out: string;
      if (action === 'uuid') out = crypto.randomUUID();
      else out = crypto.createHash(action === 'md5' ? 'md5' : 'sha256').update(String(resolved ?? '')).digest('hex');
      return { json: { ...it.json, [String(field)]: out } };
    });
  },
});

export const jsonParseNode = defineNode({
  key: 'jsonParse',
  displayName: 'JSON Parse',
  description: 'Parses a JSON-string field into an object → same items with the field parsed.',
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
  description: 'Sends an email (dry-run without SMTP env vars) → same items plus a delivery record.',
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
    const { to: rawTo, subject: rawSubject, body: rawBody } = ctx.params as any;
    return ctx.items.map((it) => {
      const to = String(ctx.expr(rawTo ?? '', it) ?? '');
      const subject = String(ctx.expr(rawSubject ?? '', it) ?? '');
      const body = String(ctx.expr(rawBody ?? '', it) ?? '');
      if (!to) throw ctx.error('"to" is required');
      const configured = !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
      console.log(`[sendEmail] ${configured ? 'SMTP' : 'dry-run'} → to=${to} subject=${subject}`);
      return { json: { ...it.json, email: { dryRun: !configured, to, subject, body } } };
    });
  },
});

const sandboxDir = () => join(process.cwd(), 'data/sandbox');

export const fileOpsNode = defineNode({
  key: 'fileOps',
  displayName: 'File',
  description: 'Reads, writes, or lists files (sandbox or absolute path) → same items plus the result.',
  version: 1,
  kind: 'action',
  icon: 'folder',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'operation', displayName: 'Operation', type: 'options', default: 'read', options: [{ name: 'Read', value: 'read' }, { name: 'Write', value: 'write' }, { name: 'List', value: 'list' }] },
    { key: 'path', displayName: 'Path', type: 'file', fileScope: 'device', default: 'hello.txt' },
    { key: 'content', displayName: 'Content (write only)', type: 'code', default: '' },
  ],
  async execute(ctx) {
    const { operation = 'read', path: rawPath = '', content: rawContent = '' } = ctx.params as any;
    const out: any[] = [];
    for (const it of ctx.items) {
      const p = String(ctx.expr(rawPath, it) ?? '');
      const content = String(ctx.expr(rawContent, it) ?? '');
      const abs = isAbsolute(p) ? p : resolve(sandboxDir(), p);
      if (operation === 'list') {
        await mkdir(abs, { recursive: true });
        const entries = await readdir(abs, { withFileTypes: true });
        out.push({ json: { ...it.json, files: entries.map((e) => e.name) } });
        continue;
      }
      if (operation === 'write') {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
        out.push({ json: { ...it.json, written: abs, bytes: content.length } });
        continue;
      }
      const data = await readFile(abs, 'utf8');
      out.push({ json: { ...it.json, path: abs, content: data } });
    }
    return out;
  },
});

/* ------------------------------ script markers ------------------------------ */

export const scriptStart = defineNode({
  key: 'scriptStart',
  displayName: 'Script Start',
  description: 'Opens a named script block (same Block ID as its End) → passes items through; collapsible on canvas.',
  version: 1,
  kind: 'action',
  category: 'code',
  icon: 'chevron-right',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'blockId', displayName: 'Block ID (must match Script End)', type: 'string', default: 'my-script', required: true },
  ],
  execute(ctx) {
    return ctx.items;
  },
});

export const scriptEnd = defineNode({
  key: 'scriptEnd',
  displayName: 'Script End',
  description: 'Closes a named script block → passes items through; blocks nest inside each other.',
  version: 1,
  kind: 'action',
  category: 'code',
  icon: 'chevron-left',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'blockId', displayName: 'Block ID (must match Script Start)', type: 'string', default: 'my-script', required: true },
  ],
  execute(ctx) {
    return ctx.items;
  },
});

/** Library categories for built-in nodes. Custom nodes carry their own. */
export const nodeCategories: Record<string, string> = {
  manualTrigger: 'triggers', webhookTrigger: 'triggers', cronTrigger: 'triggers',
  if: 'logic', switch: 'logic', filter: 'logic', merge: 'logic',
  setFields: 'data', splitOut: 'data', aggregate: 'data', jsonParse: 'data', datetime: 'data', crypto: 'data',
  code: 'code', pythonCode: 'code', scriptStart: 'code', scriptEnd: 'code',
  httpRequest: 'network', sendEmail: 'network', github: 'network',
  fileOps: 'files',
  noOp: 'flow', wait: 'flow', approval: 'flow',
};

export const coreNodes = [
  manualTrigger, webhookTrigger, cronTrigger,
  httpRequest, setFields, ifNode, switchNode, filterNode, mergeNode,
  codeNode, pythonCodeNode, scriptStart, scriptEnd,
  noOpNode, waitNode, approvalNode, splitOutNode, aggregateNode,
  datetimeNode, cryptoNode, jsonParseNode, sendEmailNode, fileOpsNode, githubNode,
];

export { githubNode, GITHUB_DEFAULT_BASE } from './github.js';

export { approvalNode, setApprovalHandler, getApprovalHandler, APPROVAL_MAX_TIMEOUT_MINUTES } from './approval.js';
export type { ApprovalRequest, ApprovalDecision, ApprovalHandler } from './approval.js';
