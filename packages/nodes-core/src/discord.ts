import { defineNode } from '@flowforge/node-sdk';

/** Post messages to Discord via a channel webhook (or a credential holding one).
 *  One call per input item; content is {{ }}-aware so runs can template alerts.
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

export const discordNode = defineNode({
  key: 'discord',
  displayName: 'Discord',
  description: 'Posts a message to Discord via a channel webhook → one delivery receipt per input item.',
  version: 1,
  kind: 'action',
  icon: 'mail',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'credential', displayName: 'Credential (optional)', type: 'credential', default: '', credentialType: 'webhook', description: 'Named secret holding { webhook } — preferred over pasting the URL' },
    { key: 'webhookUrl', displayName: 'Webhook URL', type: 'string', default: '', description: 'https://discord.com/api/webhooks/... (unused when Credential is set)' },
    { key: 'content', displayName: 'Content ({{ }}-aware)', type: 'string', required: true, default: '' },
    { key: 'username', displayName: 'Username (override)', type: 'string', default: '' },
  ],
  async execute(ctx) {
    const p = ctx.params as any;
    const url = webhookOf(p);
    if (!url) throw ctx.error('a Discord webhook is required — set Credential or Webhook URL');
    if (!/^https:\/\//.test(url)) throw ctx.error('Discord webhook URL must be https://');
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const out: any[] = [];
    for (const item of items) {
      const content = String(ctx.expr(String(p.content ?? ''), item) ?? '');
      if (!content.trim()) throw ctx.error('content is required');
      if (content.length > 2000) throw ctx.error('Discord content must be ≤ 2000 chars');
      const username = String(p.username ?? '').trim();
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ...(username ? { username } : {}) }),
      });
      const text = await res.text();
      if (!res.ok) throw ctx.error(`Discord post failed: ${res.status} ${text.slice(0, 200)}`);
      let receipt: any = null;
      try { receipt = text ? JSON.parse(text) : null; } catch { receipt = { raw: text }; }
      out.push({ json: { operation: 'post_message', ok: true, id: receipt?.id, content } });
    }
    return out;
  },
});
