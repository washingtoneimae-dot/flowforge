import { defineNode } from '@flowforge/node-sdk';

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
    { key: 'left', displayName: 'Left value (JSON path e.g. $json.status or literal)', type: 'string', required: true, default: '$json.ok' },
    { key: 'operator', displayName: 'Operator', type: 'options', default: 'equals', options: [{ name: 'equals', value: 'equals' }, { name: 'notEquals', value: 'notEquals' }, { name: 'greaterThan', value: 'greaterThan' }, { name: 'contains', value: 'contains' }] },
    { key: 'right', displayName: 'Right value', type: 'string', default: 'true' },
  ],
  execute(ctx) {
    const { left, operator, right } = ctx.params as any;
    const resolve = (v: string, json: any) => {
      if (typeof v === 'string' && v.startsWith('$json.')) return v.slice(6).split('.').reduce((o: any, k: string) => o?.[k], json);
      if (v === '$json') return json;
      try { return JSON.parse(v); } catch { return v; }
    };
    const trueItems: any[] = [];
    const falseItems: any[] = [];
    for (const it of ctx.items) {
      const l = resolve(left, it.json);
      const r = resolve(right, it.json);
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

import vm from 'node:vm';

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

export const coreNodes = [webhookTrigger, cronTrigger, httpRequest, setFields, ifNode, codeNode];
