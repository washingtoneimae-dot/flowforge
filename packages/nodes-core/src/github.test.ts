import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { evaluateExpression } from '@flowforge/engine';
import { githubNode } from './github.js';

const ctx = (params: any, items: any[] = [{ json: {} }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

interface Seen {
  method?: string;
  url?: string;
  auth?: string;
  ua?: string;
  body?: any;
}

const withStub = async (
  respond: (seen: Seen) => { status: number; payload: unknown },
  fn: (baseUrl: string, seen: Seen) => Promise<void>,
) => {
  const seen: Seen = {};
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.ua = req.headers['user-agent'];
      try { seen.body = raw ? JSON.parse(raw) : undefined; } catch { seen.body = raw; }
      const { status, payload } = respond(seen);
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(text);
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as any).port}`, seen);
  } finally {
    srv.close();
  }
};

const base = (baseUrl: string) => ({
  credential: { token: 'tok123' }, owner: 'o', repo: 'r', baseUrl,
});

describe('github node', () => {
  it('lists issues with auth + UA headers', async () => {
    await withStub(
      () => ({ status: 200, payload: [{ number: 1 }, { number: 2 }] }),
      async (baseUrl, seen) => {
        const out: any = await githubNode.execute(ctx({ ...base(baseUrl), operation: 'list_issues', state: 'open', per_page: 30 }));
        expect(seen.method).toBe('GET');
        expect(seen.url).toBe('/repos/o/r/issues?state=open&per_page=30');
        expect(seen.auth).toBe('Bearer tok123');
        expect(seen.ua).toBe('flowforge');
        expect(out[0].json.count).toBe(2);
      },
    );
  });

  it('creates an issue per item with {{ }} titles', async () => {
    await withStub(
      (s) => ({ status: 201, payload: { number: 7, html_url: 'https://x/7', title: (s.body as any)?.title } }),
      async (baseUrl, seen) => {
        const out: any = await githubNode.execute(ctx(
          { ...base(baseUrl), operation: 'create_issue', title: 'Bug {{ $json.id }}', body: 'b' },
          [{ json: { id: 1 } }, { json: { id: 2 } }],
        ));
        expect(seen.method).toBe('POST');
        expect(seen.url).toBe('/repos/o/r/issues');
        expect(out).toHaveLength(2);
        expect(out[0].json.number).toBe(7);
      },
    );
  });

  it('comments on an issue', async () => {
    await withStub(
      () => ({ status: 201, payload: { id: 99 } }),
      async (baseUrl, seen) => {
        const out: any = await githubNode.execute(ctx({ ...base(baseUrl), operation: 'create_issue_comment', issue_number: 5, body: 'hi' }));
        expect(seen.url).toBe('/repos/o/r/issues/5/comments');
        expect(seen.body).toEqual({ body: 'hi' });
        expect(out[0].json.id).toBe(99);
      },
    );
  });

  it('validates required fields before any network call', async () => {
    let calls = 0;
    await withStub(
      () => { calls++; return { status: 200, payload: [] }; },
      async (baseUrl) => {
        await expect(githubNode.execute(ctx({ ...base(baseUrl), operation: 'create_issue', title: '' }))).rejects.toThrow(/title is required/);
        await expect(githubNode.execute(ctx({ ...base(baseUrl), operation: 'create_issue_comment', issue_number: 0, body: 'x' }))).rejects.toThrow(/issue_number/);
        await expect(githubNode.execute(ctx({ ...base(baseUrl), owner: '' }))).rejects.toThrow(/owner and repo/);
      },
    );
    expect(calls).toBe(0);
  });

  it('lists pull requests', async () => {
    await withStub(
      () => ({ status: 200, payload: [{ number: 3 }, { number: 4 }, { number: 5 }] }),
      async (baseUrl, seen) => {
        const out: any = await githubNode.execute(ctx({ ...base(baseUrl), operation: 'list_pull_requests', state: 'open', per_page: 30 }));
        expect(seen.method).toBe('GET');
        expect(seen.url).toBe('/repos/o/r/pulls?state=open&per_page=30');
        expect(out[0].json).toMatchObject({ operation: 'list_pull_requests', count: 3 });
        expect(out[0].json.pulls).toHaveLength(3);
      },
    );
  });

  it('triggers workflow dispatches with {{ }} refs', async () => {
    await withStub(
      () => ({ status: 204, payload: {} }),
      async (baseUrl, seen) => {
        const out: any = await githubNode.execute(ctx(
          { ...base(baseUrl), operation: 'trigger_dispatch', workflow: 'ci.yml', ref: '{{ $json.branch }}' },
          [{ json: { branch: 'feature-x' } }],
        ));
        expect(seen.method).toBe('POST');
        expect(seen.url).toBe('/repos/o/r/actions/workflows/ci.yml/dispatches');
        expect(seen.body).toEqual({ ref: 'feature-x' });
        expect(out).toEqual([{ json: { operation: 'trigger_dispatch', ok: true, workflow: 'ci.yml', ref: 'feature-x' } }]);
      },
    );
  });

  it('requires a workflow file for dispatches', async () => {
    let calls = 0;
    await withStub(
      () => { calls++; return { status: 204, payload: {} }; },
      async (baseUrl) => {
        await expect(githubNode.execute(ctx({ ...base(baseUrl), operation: 'trigger_dispatch', workflow: '' }))).rejects.toThrow(/workflow file/);
      },
    );
    expect(calls).toBe(0);
  });

  it('maps GitHub error payloads to readable errors', async () => {
    await withStub(
      () => ({ status: 401, payload: { message: 'Bad credentials' } }),
      async (baseUrl) => {
        await expect(githubNode.execute(ctx({ ...base(baseUrl), operation: 'list_issues' }))).rejects.toThrow(/401 Bad credentials/);
      },
    );
  });
});
