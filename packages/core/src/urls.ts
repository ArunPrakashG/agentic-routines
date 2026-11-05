import type { Step } from './types.ts';

// The pages a routine applies to, as globs: host plus path, no scheme, no query.
// `*` stands for one path segment, a final `**` for the rest of the path.
//   play.google.com/console/u/*/developers/*/app/*/tracks/internal-testing

export const MAX_URLS = 8;
const SEGMENT = /^(\*\*?|[A-Za-z0-9._~%:@!$&'()+,;=-]+)$/;
const HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

const hostOk = (host: string, site: string) => host === site || host.endsWith('.' + site);

/** Looks like a record id, not a word: digits, uuids, hex runs and mixed letter-and-digit codes. */
function isIdSegment(seg: string): boolean {
  const s = decodeURIComponent(seg.replace(/%(?![0-9a-f]{2})/gi, ''));
  if (/^\d+$/.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{8,}$/i.test(s)) return true;
  if (/\d/.test(s) && /[a-z]/i.test(s) && s.length >= 8) return true;
  return s.length >= 24 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** One address as a glob: ids and numbers become `*`, the query and hash go. Null for anything that is not http(s). */
export function globOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.replace(/\{\{[^}]*\}\}/g, 'x1234567890'));
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const path = u.pathname
    .split('/')
    .filter(Boolean)
    .map((seg) => (isIdSegment(seg) || seg.includes('x1234567890') ? '*' : seg));
  return [u.host.toLowerCase(), ...path].join('/');
}

/** The globs for the pages a routine's steps are on, most used first, at most MAX_URLS, all on the site. */
export function deriveUrls(steps: Pick<Step, 'url' | 'page'>[], site: string): string[] {
  const count = new Map<string, number>();
  for (const s of steps) {
    for (const u of [s.page?.url, s.url]) {
      const g = u ? globOf(u) : null;
      if (g && hostOk(g.split('/')[0], site)) count.set(g, (count.get(g) ?? 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_URLS).map(([g]) => g);
}

/** What is wrong with a list of patterns, in words. Empty when it is fine. */
export function checkUrls(urls: unknown, site: string): string[] {
  if (urls === undefined) return [];
  if (!Array.isArray(urls)) return ['urls must be a list of addresses like play.google.com/console/*/app/*.'];
  if (urls.length > MAX_URLS) return [`At most ${MAX_URLS} urls.`];
  const out: string[] = [];
  for (const u of urls) {
    if (typeof u !== 'string' || u.length > 200) {
      out.push('Each url is text of at most 200 characters.');
      continue;
    }
    const [host, ...segs] = u.split('/');
    if (!HOST.test(host) || /[?#\s]/.test(u) || /^[a-z]+:/.test(u)) out.push(`“${u}” must be a host and a path, like ${site}/app/*: no https://, no query.`);
    else if (!hostOk(host, site)) out.push(`“${u}” is not on ${site}.`);
    else if (!segs.every((g, i) => SEGMENT.test(g) && (g !== '**' || i === segs.length - 1))) out.push(`“${u}” has a part that is not a name, * or a closing **.`);
  }
  return out;
}

/** Reads `urls` from frontmatter or config: a clean list, or undefined. */
export function readUrls(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase().replace(/\/+$/, ''));
  return out.length ? out.slice(0, MAX_URLS) : undefined;
}

function matches(pattern: string, host: string, segs: string[]): number {
  const [ph, ...ps] = pattern.split('/');
  if (ph !== host) return 0;
  let literal = 0;
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '**') return 10 + literal * 2;
    if (i >= segs.length) return 0;
    if (ps[i] === '*') continue;
    if (ps[i].toLowerCase() !== segs[i].toLowerCase()) return 0;
    literal++;
  }
  return ps.length === segs.length ? 10 + literal * 2 + 1 : 0;
}

/**
 * How well a routine fits an address. 0: not the routine's site. 0.5: its site, but not a page it lists.
 * 1: its site, and it lists no pages (or lists the whole site). 10 and up: a path pattern matches, and every
 * literal segment it matches adds to the score, so a closer pattern wins.
 */
export function urlScore(urls: string[] | undefined, site: string, url: string): number {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 0;
  }
  const host = u.host.toLowerCase();
  if (!hostOk(host, site)) return 0;
  if (!urls?.length) return 1;
  const segs = u.pathname.split('/').filter(Boolean);
  let best = 0.5;
  for (const p of urls) {
    const [ph, ...ps] = p.toLowerCase().split('/');
    const wholeHost = ps.length === 0 || (ps.length === 1 && ps[0] === '**');
    best = Math.max(best, wholeHost && ph === host ? 1 : matches(p.toLowerCase(), host, segs));
  }
  return best;
}
