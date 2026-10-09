import { defineNode } from '@flowforge/node-sdk';

/** Post messages to Slack via an incoming webhook (or a credential holding one).
 *  One call per input item; text is {{ }}-aware so agents can template alerts.
 */
function webhookOf(params: any): string {
  const cred = params.credential;
  if (cred && typeof cred === 'object') {
    for (const k of ['webhook', 'webhookUrl', 'url']) {
      if (typeof (cred as any)[k] === 'string' && (cred as any)[k]) return String((cred as any)[k]);
    }
  }
  return String(params.webhookUrl ?? '').trim();
}

export const slackNode = defineNode({
  key: 'slack',
  displayName: 'Slack',
  description: 'Posts a message to Slack via an incoming webhook → one delivery receipt per input item.',
  version: 1,
  kind: 'action',
  icon: 'mail',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'credential', displayName: 'Credential (optional)', type: 'credential', default: '', credentialType: 'webhook', description: 'Named secret holding { webhook } — preferred over pasting the URL' },
    { key: 'webhookUrl', displayName: 'Webhook URL', type: 'string', default: '', description: 'https://hooks.slack.com/... (unused when Credential is set)' },
    { key: 'text', displayName: 'Text ({{ }}-aware)', type: 'string', required: true, default: '' },
    { key: 'username', displayName: 'Username (override)', type: 'string', default: '' },
  ],
  async execute(ctx) {
    const p = ctx.params as any;
    const url = webhookOf(p);
    if (!url) throw ctx.error('a Slack webhook is required — set Credential or Webhook URL');
    if (!/^https:\/\//.test(url)) throw ctx.error('Slack webhook URL must be https://');
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const out: any[] = [];
    for (const item of items) {
      const text = String(ctx.expr(String(p.text ?? ''), item) ?? '');
      if (!text.trim()) throw ctx.error('text is required');
      const username = String(p.username ?? '').trim();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...(username ? { username } : {}) }),
      });
      const raw = await res.text();
      if (!res.ok || raw.trim() !== 'ok') {
        throw ctx.error(`Slack post failed: ${res.status} ${raw.slice(0, 200)}`);
      }
      out.push({ json: { operation: 'post_message', ok: true, text } });
    }
    return out;
  },
});
