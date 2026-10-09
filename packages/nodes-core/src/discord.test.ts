import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { discordNode } from './discord.js';

const ctx = (params: any, items: any[] = [{ json: { id: 3 } }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (respond: { status: number; payload: string }) => {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: respond.status >= 200 && respond.status < 300, status: respond.status, text: async () => respond.payload };
  });
  return calls;
};

const HOOK = 'https://discord.com/api/webhooks/123/abc';

describe('discord node', () => {
  it('posts templated content with wait=true and returns the receipt id', async () => {
    const calls = stubFetch({ status: 200, payload: '{"id":"999"}' });
    const out: any = await discordNode.execute(ctx({ webhookUrl: HOOK, content: 'build {{ $json.id }} ok' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${HOOK}?wait=true`);
    expect(JSON.parse(calls[0].init.body)).toEqual({ content: 'build 3 ok' });
    expect(out).toEqual([{ json: { operation: 'post_message', ok: true, id: '999', content: 'build 3 ok' } }]);
  });

  it('prefers the credential webhook', async () => {
    const calls = stubFetch({ status: 200, payload: '{}' });
    await discordNode.execute(ctx({ webhookUrl: 'https://discord.com/api/webhooks/unused', credential: { webhook: HOOK }, content: 'hi' }));
    expect(calls[0].url).toBe(`${HOOK}?wait=true`);
  });

  it('rejects overlong content, failures, and missing config without network', async () => {
    const calls = stubFetch({ status: 200, payload: '{}' });
    await expect(discordNode.execute(ctx({ webhookUrl: HOOK, content: 'x'.repeat(2001) }))).rejects.toThrow(/2000/);
    await expect(discordNode.execute(ctx({ webhookUrl: '', content: 'x' }))).rejects.toThrow(/webhook is required/);
    await expect(discordNode.execute(ctx({ webhookUrl: 'http://x', content: 'x' }))).rejects.toThrow(/https:\/\//);
    stubFetch({ status: 400, payload: '{"message":"bad"}' });
    await expect(discordNode.execute(ctx({ webhookUrl: HOOK, content: 'x' }))).rejects.toThrow(/Discord post failed: 400/);
    expect(calls).toHaveLength(0);
  });
});
