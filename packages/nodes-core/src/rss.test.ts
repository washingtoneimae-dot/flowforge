import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateExpression } from '@flowforge/engine';
import { rssNode, parseFeed } from './rss.js';

const ctx = (params: any, items: any[] = [{ json: {} }]) => ({
  params, items, vars: {}, workflow: { id: 'w', name: 'n' }, error: (m: string) => new Error(m),
  expr: (t: any, item: any) => evaluateExpression(t, { $json: item.json, $vars: {}, $params: params }),
});

afterEach(() => vi.unstubAllGlobals());

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Blog</title>
<item><title><![CDATA[Hello &amp; goodbye]]></title><link>https://x/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate><description><![CDATA[<p>First <b>post</b></p>]]></description></item>
<item><title>Second</title><link>https://x/2</link><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate><description>Plain</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title>
<entry><title>Atom post</title><link href="https://x/a" rel="alternate"/><updated>2024-01-03T00:00:00Z</updated><summary>Sum &lt;tag&gt;</summary></entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS items with CDATA, entities, and tag stripping', () => {
    const out = parseFeed(RSS, 10);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Hello & goodbye', link: 'https://x/1', summary: 'First post' });
    expect(out[1].date).toContain('2024');
  });
  it('parses Atom entries with link hrefs', () => {
    const out = parseFeed(ATOM, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: 'Atom post', link: 'https://x/a', summary: 'Sum <tag>' });
  });
  it('caps entries and returns empty for garbage', () => {
    expect(parseFeed(RSS, 1)).toHaveLength(1);
    expect(parseFeed('<html>nope</html>', 10)).toEqual([]);
  });
});

describe('rss node', () => {
  it('fetches and fans out one item per entry', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: any, init: any) => {
      calls.push(String(url));
      expect(init.headers['User-Agent']).toBe('flowforge');
      return { ok: true, status: 200, text: async () => RSS };
    });
    const out: any = await rssNode.execute(ctx({ url: 'https://example.com/feed.xml', maxEntries: 10 }));
    expect(calls).toEqual(['https://example.com/feed.xml']);
    expect(out).toHaveLength(2);
    expect(out[0].json.title).toBe('Hello & goodbye');
  });

  it('validates URL and empty feeds without useful network', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' }));
    await expect(rssNode.execute(ctx({ url: '' }))).rejects.toThrow(/URL is required/);
    await expect(rssNode.execute(ctx({ url: 'ftp://x' }))).rejects.toThrow(/http\(s\)/);
    await expect(rssNode.execute(ctx({ url: 'https://example.com/' }))).rejects.toThrow(/no entries/);
  });
});
