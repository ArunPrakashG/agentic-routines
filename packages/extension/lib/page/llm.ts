import { ask } from './tabs';

// Many sites publish their content for models: a Markdown twin of the page, /llms.txt, /llms-full.txt.
// Reading that costs far less than the whole page. It is fetched from the tab's own origin only, with a
// size cap and a timeout, and it is as untrusted as the page it came from.

const TIMEOUT_MS = 6_000;
const DEFAULT_BYTES = 200_000;
const HARD_BYTES = 1_000_000;

export interface LlmContent {
  found: boolean;
  /** How it was found. */
  via?: 'link-alternate' | 'accept-header' | 'md-twin' | 'llms-full.txt' | 'llms.txt';
  /** page: about this page. site: the site's index or full text, not this page. */
  scope?: 'page' | 'site';
  url?: string;
  text?: string;
  truncated?: boolean;
  bytes?: number;
  /** What was tried and why it did not count, when nothing was found. */
  tried: { url: string; why: string }[];
}

interface Candidate {
  url: string;
  via: NonNullable<LlmContent['via']>;
  scope: 'page' | 'site';
  accept?: string;
}

function twins(page: URL): string[] {
  const p = page.pathname;
  const out: string[] = [];
  const at = (path: string) => {
    const u = new URL(page.href);
    u.pathname = path;
    u.hash = '';
    return u.href;
  };
  if (p === '/' || p === '') out.push(at('/index.md'));
  else if (p.endsWith('/')) out.push(at(p + 'index.md'), at(p.slice(0, -1) + '.md'));
  else if (/\.(html?|php|aspx?)$/i.test(p)) out.push(at(p.replace(/\.[a-z]+$/i, '.md')));
  else if (!/\.[a-z0-9]{1,5}$/i.test(p)) out.push(at(p + '.md'));
  return out;
}

const KINDS = /^(?:text\/markdown|text\/x-markdown|text\/plain|application\/markdown)\b/i;

/** Reads at most `limit` bytes of a body. */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!res.body) {
    const t = await res.text();
    return { text: t.slice(0, limit), truncated: t.length > limit, bytes: t.length };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    chunks.push(value);
    if (bytes > limit) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const all = new Uint8Array(Math.min(bytes, limit));
  let at = 0;
  for (const c of chunks) {
    const take = c.subarray(0, Math.max(0, all.length - at));
    all.set(take, at);
    at += take.length;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(all), truncated, bytes };
}

async function tryOne(c: Candidate, origin: string, limit: number): Promise<{ ok: true; text: string; truncated: boolean; bytes: number; url: string } | { ok: false; why: string }> {
  let u: URL;
  try {
    u = new URL(c.url);
  } catch {
    return { ok: false, why: 'not an address' };
  }
  // The only rule that matters most: never leave the tab's own origin.
  if (u.origin !== origin) return { ok: false, why: 'a different site than the tab' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u.href, { signal: ctl.signal, credentials: 'include', redirect: 'follow', headers: { Accept: c.accept ?? 'text/markdown, text/plain;q=0.9, */*;q=0.1' } });
    if (!res.ok) return { ok: false, why: `status ${res.status}` };
    if (new URL(res.url).origin !== origin) return { ok: false, why: 'redirected to another site' };
    const kind = res.headers.get('content-type') ?? '';
    if (!KINDS.test(kind)) return { ok: false, why: kind ? `served as ${kind.split(';')[0]}, not Markdown or text` : 'no content type' };
    const len = Number(res.headers.get('content-length') ?? 0);
    const body = await readCapped(res, limit);
    // A single-page app answers every path with its HTML shell, sometimes labelled as text.
    if (/^\s*(?:<!doctype html|<html)/i.test(body.text)) return { ok: false, why: 'an HTML page, not Markdown' };
    if (!body.text.trim()) return { ok: false, why: 'empty' };
    return { ok: true, text: body.text, truncated: body.truncated, bytes: len || body.bytes, url: res.url };
  } catch (e) {
    return { ok: false, why: (e as Error).name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000}s` : 'could not be fetched' };
  } finally {
    clearTimeout(timer);
  }
}

/** Look for text made for models on the tab's site, most specific first. */
export async function find(tabId: number, opts: { scope?: 'auto' | 'page' | 'site'; full?: boolean; maxBytes?: number } = {}): Promise<LlmContent> {
  const tab = await browser.tabs.get(tabId);
  const page = new URL(tab.url ?? '');
  if (!/^https?:$/.test(page.protocol)) throw new Error('That tab is not a web page.');
  const limit = Math.min(Math.max(opts.maxBytes ?? DEFAULT_BYTES, 1_000), HARD_BYTES);
  const scope = opts.scope ?? 'auto';
  const list: Candidate[] = [];
  if (scope !== 'site') {
    const alts = await ask<string[]>(tabId, { t: 'alternates' }).catch(() => []);
    for (const href of alts) list.push({ url: href, via: 'link-alternate', scope: 'page' });
    const same = new URL(page.href);
    same.hash = '';
    list.push({ url: same.href, via: 'accept-header', scope: 'page', accept: 'text/markdown' });
    for (const t of twins(page)) list.push({ url: t, via: 'md-twin', scope: 'page' });
  }
  if (scope !== 'page') {
    const root = (p: string) => new URL(p, page.origin).href;
    if (opts.full) list.push({ url: root('/llms-full.txt'), via: 'llms-full.txt', scope: 'site' });
    list.push({ url: root('/llms.txt'), via: 'llms.txt', scope: 'site' });
    if (!opts.full) list.push({ url: root('/llms-full.txt'), via: 'llms-full.txt', scope: 'site' });
  }
  const tried: LlmContent['tried'] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const key = `${c.url}|${c.accept ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = await tryOne(c, page.origin, limit);
    if (r.ok) return { found: true, via: c.via, scope: c.scope, url: r.url, text: r.text, truncated: r.truncated, bytes: r.bytes, tried };
    tried.push({ url: c.url, why: r.why });
  }
  return { found: false, tried };
}
