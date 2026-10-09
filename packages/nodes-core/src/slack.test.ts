import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { slackNode } from './slack.js';

const ctx = (params: any, items: any[] = [{ json: { id: 7 } }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

afterEach(() => vi.unstubAllGlobals());

/** Capture fetch calls; answer canned Slack responses. */
const stubFetch = (respond: { status: number; payload: string }) => {
  const calls: Array<{ url: string; init: any }> = [];
  vi.stubGlobal('fetch', async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: respond.status === 200, status: respond.status, text: async () => respond.payload };
  });
  return calls;
};

describe('slack node', () => {
  it('posts templated text and returns a receipt', async () => {
    const calls = stubFetch({ status: 200, payload: 'ok' });
    const out: any = await slackNode.execute(ctx({ webhookUrl: 'https://hooks.slack.com/T/AAA/xxx', text: 'deploy {{ $json.id }} done' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.slack.com/T/AAA/xxx');
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'deploy 7 done' });
    expect(out).toEqual([{ json: { operation: 'post_message', ok: true, text: 'deploy 7 done' } }]);
  });

  it('prefers the credential webhook over the pasted URL', async () => {
    const calls = stubFetch({ status: 200, payload: 'ok' });
    await slackNode.execute(ctx({
      webhookUrl: 'https://hooks.slack.com/unused',
      credential: { webhook: 'https://hooks.slack.com/T/BBB/yyy' },
      text: 'hi',
    }));
    expect(calls[0].url).toBe('https://hooks.slack.com/T/BBB/yyy');
  });

  it('sends one call per item', async () => {
    const calls = stubFetch({ status: 200, payload: 'ok' });
    await slackNode.execute(
      ctx({ webhookUrl: 'https://hooks.slack.com/x', text: 'n {{ $json.n }}' }, [{ json: { n: 1 } }, { json: { n: 2 } }]),
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1].init.body)).toEqual({ text: 'n 2' });
  });

  it('rejects Slack errors and validates without network', async () => {
    stubFetch({ status: 200, payload: 'invalid_payload' });
    await expect(slackNode.execute(ctx({ webhookUrl: 'https://hooks.slack.com/x', text: 'hi' }))).rejects.toThrow(/Slack post failed/);
    const calls = stubFetch({ status: 200, payload: 'ok' });
    await expect(slackNode.execute(ctx({ webhookUrl: '', text: 'hi' }))).rejects.toThrow(/webhook is required/);
    await expect(slackNode.execute(ctx({ webhookUrl: 'http://insecure/x', text: 'hi' }))).rejects.toThrow(/https:\/\//);
    await expect(slackNode.execute(ctx({ webhookUrl: 'https://hooks.slack.com/x', text: '  ' }))).rejects.toThrow(/text is required/);
    expect(calls).toHaveLength(0);
  });
});
