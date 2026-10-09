import { defineNode } from '@flowforge/node-sdk';

/** Send Telegram messages via a bot (Bot API sendMessage).
 *  One call per input item; text is {{ }}-aware. Token belongs in a
 *  credential ({ token }); a pasted param works but lands in the definition.
 */
function tokenOf(params: any): string {
  const cred = params.credential;
  if (cred && typeof cred === 'object' && typeof (cred as any).token === 'string' && (cred as any).token) {
    return String((cred as any).token);
  }
  return String(params.botToken ?? '').trim();
}

export const telegramNode = defineNode({
  key: 'telegram',
  displayName: 'Telegram',
  description: 'Sends a Telegram message via a bot → one message id per input item.',
  version: 1,
  kind: 'action',
  icon: 'mail',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'credential', displayName: 'Credential (optional)', type: 'credential', default: '', credentialType: 'token', description: 'Bot token from Settings → Credentials ({ token }) — preferred' },
    { key: 'botToken', displayName: 'Bot token (or use Credential)', type: 'string', default: '' },
    { key: 'chat_id', displayName: 'Chat ID', type: 'string', required: true, default: '', description: 'User, group, or channel id (get it from @userinfobot / @getmyid_bot)' },
    { key: 'text', displayName: 'Text ({{ }}-aware)', type: 'string', required: true, default: '' },
    { key: 'baseUrl', displayName: 'API base URL', type: 'string', default: 'https://api.telegram.org' },
  ],
  async execute(ctx) {
    const p = ctx.params as any;
    const token = tokenOf(p);
    if (!token) throw ctx.error('a Telegram bot token is required — set Credential or Bot token');
    const chatId = String(p.chat_id ?? '').trim();
    if (!chatId) throw ctx.error('chat_id is required');
    const base = String(p.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '');
    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const out: any[] = [];
    for (const item of items) {
      const text = String(ctx.expr(String(p.text ?? ''), item) ?? '');
      if (!text.trim()) throw ctx.error('text is required');
      if (text.length > 4096) throw ctx.error('Telegram text must be ≤ 4096 chars');
      const res = await fetch(`${base}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const raw = await res.text();
      let data: any;
      try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
      if (!res.ok || data?.ok !== true) {
        throw ctx.error(`Telegram send failed: ${res.status} ${String(data?.description ?? raw).slice(0, 200)}`);
      }
      out.push({ json: { operation: 'send_message', ok: true, message_id: data?.result?.message_id, text } });
    }
    return out;
  },
});
