import { defineNode } from '@flowforge/node-sdk';

/** Minimal GitHub REST integration: issues + comments, one call per input item.
 *  Auth comes from a resolved credential ({ token } or { username, password }).
 *  baseUrl is overridable for GHES and hermetic tests.
 */
export const GITHUB_DEFAULT_BASE = 'https://api.github.com';

type Op = 'list_issues' | 'create_issue' | 'create_issue_comment' | 'list_pull_requests' | 'trigger_dispatch';

function authHeader(cred: unknown): string {
  if (cred && typeof cred === 'object') {
    const c = cred as any;
    if (typeof c.token === 'string' && c.token) return `Bearer ${c.token}`;
    if (typeof c.username === 'string' && typeof c.password === 'string') {
      return `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`;
    }
  }
  return '';
}

export const githubNode = defineNode({
  key: 'github',
  displayName: 'GitHub',
  description: 'Calls the GitHub REST API (issues, PRs, comments, workflow dispatches) → one response item per input item.',
  version: 1,
  kind: 'action',
  icon: 'globe',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    {
      key: 'operation', displayName: 'Operation', type: 'options', default: 'list_issues',
      options: [
        { name: 'List issues', value: 'list_issues' },
        { name: 'Create issue', value: 'create_issue' },
        { name: 'Comment on issue', value: 'create_issue_comment' },
        { name: 'List pull requests', value: 'list_pull_requests' },
        { name: 'Trigger workflow dispatch', value: 'trigger_dispatch' },
      ],
    },
    { key: 'credential', displayName: 'Credential', type: 'credential', default: '', credentialType: 'token', description: 'PAT from Settings → Credentials (needs repo scope; dispatch needs actions:write)' },
    { key: 'owner', displayName: 'Owner', type: 'string', required: true, default: '' },
    { key: 'repo', displayName: 'Repo', type: 'string', required: true, default: '' },
    { key: 'issue_number', displayName: 'Issue number (comment op)', type: 'number', default: 0 },
    { key: 'title', displayName: 'Title (create op)', type: 'string', default: '' },
    { key: 'body', displayName: 'Body (create/comment, {{ }}-aware)', type: 'string', default: '' },
    { key: 'workflow', displayName: 'Workflow file (dispatch op)', type: 'string', default: '', description: 'e.g. "ci.yml" — must declare a workflow_dispatch trigger' },
    { key: 'ref', displayName: 'Git ref (dispatch op)', type: 'string', default: 'main' },
    {
      key: 'state', displayName: 'State (list op)', type: 'options', default: 'open',
      options: [{ name: 'open', value: 'open' }, { name: 'closed', value: 'closed' }, { name: 'all', value: 'all' }],
    },
    { key: 'per_page', displayName: 'Per page (list op, max 100)', type: 'number', default: 30 },
    { key: 'baseUrl', displayName: 'API base URL', type: 'string', default: GITHUB_DEFAULT_BASE, description: 'Override for GitHub Enterprise Server' },
  ],
  async execute(ctx) {
    const p = ctx.params as any;
    const op = String(p.operation ?? 'list_issues') as Op;
    if (!['list_issues', 'create_issue', 'create_issue_comment', 'list_pull_requests', 'trigger_dispatch'].includes(op)) {
      throw ctx.error(`unknown GitHub operation "${op}"`);
    }
    const owner = String(p.owner ?? '').trim();
    const repo = String(p.repo ?? '').trim();
    if (!owner || !repo) throw ctx.error('owner and repo are required');
    const base = String(p.baseUrl ?? GITHUB_DEFAULT_BASE).replace(/\/$/, '') || GITHUB_DEFAULT_BASE;
    const auth = authHeader(p.credential);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'flowforge',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (auth) headers.Authorization = auth;

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: any;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) {
        const msg = typeof data?.message === 'string' ? data.message : text.slice(0, 200);
        throw ctx.error(`GitHub ${op} failed: ${res.status} ${msg}`);
      }
      return data;
    };

    const items = ctx.items.length ? ctx.items : [{ json: {} }];
    const out: any[] = [];
    for (const item of items) {
      if (op === 'list_issues') {
        const perPage = Math.min(Math.max(Number(p.per_page ?? 30) || 30, 1), 100);
        const state = String(p.state ?? 'open');
        const data = await call('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=${perPage}`);
        out.push({ json: { operation: op, count: Array.isArray(data) ? data.length : 0, issues: data } });
      } else if (op === 'create_issue') {
        const title = String(ctx.expr(String(p.title ?? ''), item) ?? '').trim();
        if (!title) throw ctx.error('title is required for create_issue');
        const body = String(ctx.expr(String(p.body ?? ''), item) ?? '');
        const data = await call('POST', `/repos/${owner}/${repo}/issues`, { title, body });
        out.push({ json: { operation: op, number: data?.number, url: data?.html_url, issue: data } });
      } else if (op === 'create_issue_comment') {
        const num = Number(p.issue_number ?? 0);
        if (!num) throw ctx.error('issue_number is required for create_issue_comment');
        const body = String(ctx.expr(String(p.body ?? ''), item) ?? '');
        if (!body.trim()) throw ctx.error('body is required for create_issue_comment');
        const data = await call('POST', `/repos/${owner}/${repo}/issues/${num}/comments`, { body });
        out.push({ json: { operation: op, id: data?.id, url: data?.html_url, comment: data } });
      } else if (op === 'list_pull_requests') {
        const perPage = Math.min(Math.max(Number(p.per_page ?? 30) || 30, 1), 100);
        const state = String(p.state ?? 'open');
        const data = await call('GET', `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}`);
        out.push({ json: { operation: op, count: Array.isArray(data) ? data.length : 0, pulls: data } });
      } else {
        const workflow = String(p.workflow ?? '').trim();
        if (!workflow) throw ctx.error('workflow file is required for trigger_dispatch');
        const ref = String(ctx.expr(String(p.ref ?? 'main'), item) ?? '').trim() || 'main';
        await call('POST', `/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, { ref });
        out.push({ json: { operation: op, ok: true, workflow, ref } });
      }
    }
    return out;
  },
});
