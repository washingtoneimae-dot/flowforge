import { defineNode } from '@flowforge/node-sdk';

/** Read RSS 2.0 / Atom feeds → one item per entry ({ title, link, date, summary }).
 *  Dependency-free, best-effort parsing for well-formed feeds: strip CDATA,
 *  unescape the common entities, cap entries per feed.
 */

export interface FeedEntry {
  title: string;
  link: string;
  date: string;
  summary: string;
}

const stripCdata = (s: string) => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');

const unescapeEntities = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').trim();

/** Plain text fields: CDATA + entities, tags kept (titles/links/dates). */
const cleanText = (s: string) => unescapeEntities(stripCdata(s)).trim();

/** Summaries may carry markup: CDATA → tags → entities, so `&lt;tag&gt;`
 *  survives as literal text instead of being stripped as markup. */
const cleanSummary = (s: string) => unescapeEntities(stripTags(stripCdata(s))).trim();

function rawField(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

function atomLink(block: string): string {
  // Prefer alternate link, else any href.
  const links = [...block.matchAll(/<link\s[^>]*>/gi)].map((m) => m[0]);
  const href = (tag: string) => {
    const m = tag.match(/href\s*=\s*"([^"]*)"/i) ?? tag.match(/href\s*=\s*'([^']*)'/i);
    return m ? m[1] : '';
  };
  for (const t of links) {
    if (/\brel\s*=\s*"(alternate)?"/i.test(t) || !/\brel\s*=/i.test(t)) {
      const h = href(t);
      if (h) return h;
    }
  }
  return '';
}

/** Parse feed XML into entries (RSS <item> or Atom <entry>). Exported for tests. */
export function parseFeed(xml: string, maxEntries: number): FeedEntry[] {
  const clean = xml.replace(/<\?xml[\s\S]*?\?>/, '');
  const isAtom = /<feed[\s>]/i.test(clean);
  const blocks = isAtom
    ? [...clean.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[1])
    : [...clean.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  return blocks.slice(0, maxEntries).map((b) => {
    const title = cleanText(rawField(b, 'title'));
    const link = isAtom ? cleanText(atomLink(b)) : cleanText(rawField(b, 'link'));
    const date = cleanText(rawField(b, 'pubDate') || rawField(b, 'published') || rawField(b, 'updated') || rawField(b, 'date'));
    const summary = cleanSummary(rawField(b, 'description') || rawField(b, 'summary') || rawField(b, 'content'));
    return { title, link, date, summary: summary.slice(0, 500) };
  });
}

export const rssNode = defineNode({
  key: 'rss',
  displayName: 'RSS Feed',
  description: 'Reads an RSS/Atom feed → one item per entry ({ title, link, date, summary }).',
  version: 1,
  kind: 'action',
  icon: 'globe',
  inputs: ['main'],
  outputs: ['main'],
  properties: [
    { key: 'url', displayName: 'Feed URL', type: 'string', required: true, default: '' },
    { key: 'maxEntries', displayName: 'Max entries (1–50)', type: 'number', default: 10 },
  ],
  async execute(ctx) {
    const url = String((ctx.params as any).url ?? '').trim();
    if (!url) throw ctx.error('feed URL is required');
    if (!/^https?:\/\//.test(url)) throw ctx.error('feed URL must be http(s)://');
    const maxEntries = Math.min(Math.max(Number((ctx.params as any).maxEntries ?? 10) || 10, 1), 50);
    let xml: string;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'flowforge', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
      xml = await res.text();
      if (!res.ok) throw ctx.error(`feed fetch failed: ${res.status} ${xml.slice(0, 200)}`);
    } catch (e) {
      if ((e as Error).message.startsWith('feed fetch failed')) throw e;
      throw ctx.error(`feed fetch failed: ${(e as Error).message}`);
    }
    const entries = parseFeed(xml, maxEntries);
    if (entries.length === 0) throw ctx.error('no entries found — not an RSS/Atom feed?');
    return entries.map((entry) => ({ json: { ...entry } }));
  },
});
