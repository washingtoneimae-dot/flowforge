import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { telegramNode } from './telegram.js';

const ctx = (params: any, items: any[] = [{ json: { n: 5 } }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (respond: { status: number; payload: unknown }) => {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const text = JSON.stringify(respond.payload);
    return { ok: respond.status >= 200 && respond.status < 300, status: respond.status, text: async () => text };
  });
  return calls;
};

describe('telegram node', () => {
  it('sends templated text to the bot endpoint and returns the message id', async () => {
    const calls = stubFetch({ status: 200, payload: { ok: true, result: { message_id: 42 } } });
    const out: any = await telegramNode.execute(ctx({ botToken: 'TOK', chat_id: '123', text: 'hi {{ $json.n }}' }));
    expect(calls[0].url).toBe('https://api.telegram.org/botTOK/sendMessage');
    expect(JSON.parse(calls[0].init.body)).toEqual({ chat_id: '123', text: 'hi 5' });
    expect(out).toEqual([{ json: { operation: 'send_message', ok: true, message_id: 42, text: 'hi 5' } }]);
  });

  it('prefers the credential token', async () => {
    const calls = stubFetch({ status: 200, payload: { ok: true, result: {} } });
    await telegramNode.execute(ctx({ botToken: 'PASTED', credential: { token: 'CRED' }, chat_id: '1', text: 'x' }));
    expect(calls[0].url).toBe('https://api.telegram.org/botCRED/sendMessage');
  });

  it('maps Bot API errors and validates without network', async () => {
    stubFetch({ status: 400, payload: { ok: false, description: 'Bad Request: chat not found' } });
    await expect(telegramNode.execute(ctx({ botToken: 'T', chat_id: '9', text: 'x' }))).rejects.toThrow(/chat not found/);
    const calls = stubFetch({ status: 200, payload: { ok: true, result: {} } });
    await expect(telegramNode.execute(ctx({ chat_id: '1', text: 'x' }))).rejects.toThrow(/bot token/);
    await expect(telegramNode.execute(ctx({ botToken: 'T', chat_id: '', text: 'x' }))).rejects.toThrow(/chat_id/);
    await expect(telegramNode.execute(ctx({ botToken: 'T', chat_id: '1', text: 'y'.repeat(4097) }))).rejects.toThrow(/4096/);
    expect(calls).toHaveLength(0);
  });
});
