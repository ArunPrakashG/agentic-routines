import type { Locator, PageFingerprint } from './types.ts';

// Page checks used before every step. Pure functions so the content script
// and tests share them.

const STABLE = ['id', 'name', 'data-testid', 'aria-label', 'placeholder', 'type', 'href'];

function norm(s?: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The part of a name that stays put when the rest changes: a chat row is named by who it is with, then the latest
 * message, a unread count or a time. Only a name with a break in it has one.
 */
function lead(s?: string): string {
  const parts = (s ?? '').split(/\n|\s[·|–—-]\s|:\s|,\s\d|\s\d+ unread/i);
  return parts.length > 1 ? norm(parts[0]) : '';
}

const sameLead = (a?: string, b?: string) => {
  const l = lead(a);
  return l.length >= 3 && l === lead(b);
};

/** Ids that look generated (react-aria-12, :r3:, ember451) carry no signal. */
export function isVolatileId(id: string): boolean {
  return /\d{3,}|^:r|^(ember|react|radix|mui|headlessui)[-_:]|[a-f0-9]{8,}/i.test(id);
}

/** How well does a live element match the recorded locator? */
export function score(rec: Locator, live: Locator): number {
  let s = 0;
  if (rec.tag === live.tag) s += 1;
  if (rec.role && rec.role === live.role) s += 3;
  const rn = norm(rec.name);
  const ln = norm(live.name);
  if (rn && rn === ln) s += 6;
  else if (rn && ln && (ln.includes(rn) || rn.includes(ln))) s += 3;
  else if (sameLead(rec.name, live.name)) s += 4;
  const rt = norm(rec.text);
  if (rt && rt === norm(live.text)) s += 3;
  for (const k of STABLE) {
    const v = rec.attrs[k];
    if (!v || live.attrs[k] !== v) continue;
    if (k === 'id' && isVolatileId(v)) continue;
    s += k === 'type' ? 1 : 4;
  }
  if (rec.css && rec.css === live.css) s += 2;
  if (rec.near && norm(rec.near) === norm(live.near)) s += 2;
  return s;
}

/** Role, tag and position fit many elements. Only a name or a stable attribute says it is this one. */
function sameElement(rec: Locator, live: Locator, all: Locator[]): boolean {
  // A value many elements share, like the id #checkbox on every row of a list, identifies none of them.
  const unique = (k: string) => all.filter((l) => l.attrs[k] === rec.attrs[k]).length <= 1;
  const stable = STABLE.filter((k) => k !== 'type' && rec.attrs[k] && !(k === 'id' && isVolatileId(rec.attrs[k]!)) && unique(k));
  const rn = norm(rec.name);
  const ln = norm(live.name);
  if (!rn && ln) return false;
  if (!rn && !stable.length) return true;
  if (rn && ln && (ln.includes(rn) || rn.includes(ln))) return true;
  if (sameLead(rec.name, live.name)) return true;
  return stable.some((k) => live.attrs[k] === rec.attrs[k]);
}

export const MIN_SCORE = 7;
export const MIN_MARGIN = 3;

export type Resolution<T> =
  | { kind: 'found'; item: T; score: number }
  | { kind: 'ambiguous'; ranked: { item: T; score: number }[] }
  | { kind: 'missing'; ranked: { item: T; score: number }[] };

/** Pick the one element the step was recorded against, or say why not. */
export function resolve<T>(rec: Locator, live: { item: T; loc: Locator }[]): Resolution<T> {
  const ranked = live
    .map((c) => ({ item: c.item, loc: c.loc, score: score(rec, c.loc) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);
  const all = live.map((c) => c.loc);
  const same = ranked.filter((c) => sameElement(rec, c.loc, all));
  const [top, second] = same;
  if (!top || top.score < MIN_SCORE) return { kind: 'missing', ranked: ranked.slice(0, 3) };
  if (second && top.score - second.score < MIN_MARGIN) return { kind: 'ambiguous', ranked: same.slice(0, 3) };
  return { kind: 'found', item: top.item, score: top.score };
}

/** Same host and path shape, ignoring ids and query values. */
export function urlPattern(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname
      .split('/')
      .map((seg) => (/\d/.test(seg) && seg.length > 3 ? ':id' : seg))
      .join('/');
    return url.host + path;
  } catch {
    return u;
  }
}

/** 0..1, how much of the recorded page structure is still there. */
export function pageSimilarity(rec: PageFingerprint, live: PageFingerprint): number {
  const a = new Set(rec.landmarks.map(norm));
  if (a.size === 0) return urlPattern(rec.url) === urlPattern(live.url) ? 1 : 0.5;
  const b = new Set(live.landmarks.map(norm));
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  const overlap = hit / a.size;
  return urlPattern(rec.url) === urlPattern(live.url) ? Math.min(1, overlap + 0.25) : overlap;
}

export const SAME_PAGE = 0.5;

/** Hamming distance between two 64-bit hex dHashes. */
export function hashDistance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 4) {
    let x = parseInt(a.slice(i, i + 4) || '0', 16) ^ parseInt(b.slice(i, i + 4) || '0', 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

export const CROP_DRIFT = 12;

/** dHash from a 9x8 grayscale buffer (72 values, row-major). */
export function dHash(gray: ArrayLike<number>): string {
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] < gray[y * 9 + x + 1] ? '1' : '0';
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
