import type { Locator } from '@agentic-routines/core';
import type { OutlineNotes, Point } from './dom';
import { ask, ensureContent, frameOf, inFrame } from './tabs';

// A page is often several documents: a payment form, an editor, a console. A ref says which one it belongs to, f12:ref_3,
// and input goes to the tab as a whole, so a point in a frame has to be turned into a point in the tab.

/** Where a frame sits in what holds it, and what a person sees of it. */
interface Place extends Point {
  w: number;
  h: number;
  sx: number;
  sy: number;
  shown: boolean;
  over?: string;
}

interface Seen {
  frameId: number;
  parentFrameId: number;
  url: string;
  box: Point & { sx: number; sy: number; w: number; h: number };
}

const MAX_FRAMES = 40;
const KNOCK_TRIES = 6;

async function tree(tabId: number) {
  return (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
}

/**
 * A page cannot be asked which of its frames is which, so the frame says hello to what holds it, and only that document
 * can tell where the one that said it sits. A frame with no answer counts as not drawn.
 */
async function placeOf(tabId: number, frameId: number, parentId: number, show?: Point): Promise<Place | null> {
  const nonce = crypto.randomUUID();
  try {
    // What holds it has to be there to hear it: a tab opened before install has no script yet.
    await ensureContent(tabId, parentId);
    await ask(tabId, { t: 'knock', nonce }, frameId);
    for (let i = 0; i < KNOCK_TRIES; i++) {
      const p = await ask<Place | null>(tabId, { t: 'place', nonce, show }, parentId);
      if (p) return p;
      await new Promise((r) => setTimeout(r, 30));
    }
  } catch {
    // Gone, or a page no script runs on.
  }
  return null;
}

/** The frames in a tab a person can see, outermost first. The page itself is not among them. */
export async function seenFrames(tabId: number): Promise<Seen[]> {
  const all = await tree(tabId).catch(() => []);
  const out: Seen[] = [];
  const boxes = new Map<number, Seen['box']>([[0, { x: 0, y: 0, sx: 1, sy: 1, w: Infinity, h: Infinity }]]);
  let parents = [0];
  while (parents.length && out.length < MAX_FRAMES) {
    const kids = all.filter((f) => parents.includes(f.parentFrameId) && f.frameId !== 0).slice(0, MAX_FRAMES - out.length);
    const placed = await Promise.all(kids.map((f) => placeOf(tabId, f.frameId, f.parentFrameId)));
    parents = [];
    kids.forEach((f, i) => {
      const p = placed[i];
      if (!p?.shown) return;
      const up = boxes.get(f.parentFrameId)!;
      const box = { x: up.x + p.x * up.sx, y: up.y + p.y * up.sy, sx: up.sx * p.sx, sy: up.sy * p.sy, w: 0, h: 0 };
      box.w = p.w * box.sx;
      box.h = p.h * box.sy;
      boxes.set(f.frameId, box);
      parents.push(f.frameId);
      out.push({ frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url, box });
    });
  }
  return out;
}

/** A point in a frame as a point in the tab. With show, each document around it scrolls it on screen and says what is drawn over it. */
export async function toTab(tabId: number, ref: string | undefined, p: Point, show = false): Promise<Point & { over?: string }> {
  let id = frameOf(ref);
  if (!id) return p;
  const all = await tree(tabId);
  let at: Point = p;
  let over: string | undefined;
  while (id) {
    const parent: number = all.find((f) => f.frameId === id)?.parentFrameId ?? 0;
    const place = await placeOf(tabId, id, parent, show ? at : undefined);
    if (!place?.shown) throw new Error('That is in a frame a person cannot see, so it is not on screen.');
    at = { x: place.x + at.x * place.sx, y: place.y + at.y * place.sy };
    over ??= place.over;
    id = parent;
  }
  return { ...at, over };
}

/** What is at a point in the tab, going into frames. The point that comes back is in the document the ref belongs to. */
export async function landOn(tabId: number, at: Point): Promise<{ ref: string; spot?: { x: number; y: number }; at: Point }> {
  const top = await ask<{ ref: string; spot?: { x: number; y: number }; frame?: boolean }>(tabId, { t: 'at', ...at });
  if (!top.frame) return { ref: top.ref, spot: top.spot, at };
  const frames = await seenFrames(tabId);
  let parent = 0;
  for (;;) {
    const kid = frames.filter((f) => f.parentFrameId === parent).find((f) => at.x >= f.box.x && at.y >= f.box.y && at.x < f.box.x + f.box.w && at.y < f.box.y + f.box.h);
    if (!kid) return { ref: top.ref, spot: top.spot, at };
    const local = { x: (at.x - kid.box.x) / kid.box.sx, y: (at.y - kid.box.y) / kid.box.sy };
    const inner = await ask<{ ref: string; spot?: { x: number; y: number }; frame?: boolean }>(tabId, { t: 'at', ...local }, kid.frameId);
    if (!inner.frame) return { ref: inFrame(kid.frameId, inner.ref), spot: inner.spot, at: local };
    parent = kid.frameId;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const prefixed = (lines: string[], frameId: number) => lines.map((l) => l.replace(/^ref_/, `f${frameId}:ref_`));

/** The outline of a tab: its page, then each frame a person can see that has anything in it. */
export async function readTab(tabId: number, filter?: 'interactive' | 'all', wait?: number) {
  const out = await ask<{ text: string; notes: OutlineNotes }>(tabId, { t: 'read', filter, wait });
  const parts = [out.text];
  for (const f of await seenFrames(tabId)) {
    const inner = await ask<{ text: string; notes: OutlineNotes }>(tabId, { t: 'read', filter }, f.frameId).catch(() => undefined);
    if (!inner) continue;
    // Its own title and address come first.
    const lines = inner.text.split('\n').slice(3).filter(Boolean);
    for (const [why, n] of Object.entries(inner.notes.omitted)) out.notes.omitted[why] = (out.notes.omitted[why] ?? 0) + n;
    out.notes.longValues += inner.notes.longValues;
    if (lines.length) parts.push(`\n[frame ${hostOf(f.url)}]\n${prefixed(lines, f.frameId).join('\n')}`);
  }
  return { text: parts.join('\n'), notes: out.notes };
}

/** Words on the page, in every document of the tab. */
export async function findInTab(tabId: number, query: string) {
  const out = await ask<{ lines: string[]; total: number }>(tabId, { t: 'find', query });
  for (const f of await seenFrames(tabId)) {
    const inner = await ask<{ lines: string[]; total: number }>(tabId, { t: 'find', query }, f.frameId).catch(() => undefined);
    if (!inner) continue;
    out.total += inner.total;
    out.lines.push(...prefixed(inner.lines, f.frameId));
  }
  return { lines: out.lines.slice(0, 20), total: out.total };
}

const TEXT_MAX = 50_000;

/** The words of the tab: its page, then its frames, as far as there is room. */
export async function textOfTab(tabId: number) {
  const out = await ask<{ text: string; notes: OutlineNotes }>(tabId, { t: 'pagetext' });
  for (const f of await seenFrames(tabId)) {
    if (out.text.length >= TEXT_MAX) break;
    const inner = await ask<{ text: string; notes: OutlineNotes }>(tabId, { t: 'pagetext' }, f.frameId).catch(() => undefined);
    const body = inner?.text.split('\n').slice(3).join('\n').trim();
    if (!inner || !body) continue;
    for (const [why, n] of Object.entries(inner.notes.omitted)) out.notes.omitted[why] = (out.notes.omitted[why] ?? 0) + n;
    out.text += `\n\n[frame ${hostOf(f.url)}]\n${body.slice(0, TEXT_MAX - out.text.length)}`;
  }
  return out;
}

/** Which recorded frame an address could be: the same page first, then the same site. */
function likeness(url: string, want: string) {
  if (url === want) return 2;
  try {
    const [u, w] = [new URL(url), new URL(want)];
    return u.origin === w.origin ? (u.pathname === w.pathname ? 2 : 1) : 0;
  } catch {
    return 0;
  }
}

interface Rectish {
  x: number;
  y: number;
}
interface Result {
  kind: string;
  ref?: string;
  rect?: Rectish;
  candidates?: { ref?: string; rect?: Rectish }[];
  view?: unknown;
}

function inTab<T extends Result>(res: T, frameId: number, box: Seen['box']): T {
  const place = (r?: Rectish) => r && { ...r, x: box.x + r.x * box.sx, y: box.y + r.y * box.sy };
  // The size a frame reports is its own, not the tab's.
  return { ...res, view: undefined, ref: res.ref && inFrame(frameId, res.ref), rect: place(res.rect), candidates: res.candidates?.map((c) => ({ ...c, ref: c.ref && inFrame(frameId, c.ref), rect: place(c.rect) })) };
}

/** Look for a recorded element where it was recorded: in the page, or in the frame it was in. */
export async function resolveInTab<T extends Result>(tabId: number, msg: { t: 'resolve'; target: Locator; wide?: boolean } | { t: 'first'; target: Locator; index?: number }): Promise<T> {
  const want = msg.target.frame;
  if (!want) return ask<T>(tabId, msg);
  const frames = (await seenFrames(tabId)).map((f) => ({ f, like: likeness(f.url, want) })).filter((x) => x.like).sort((a, b) => b.like - a.like);
  let last = { kind: 'missing', candidates: [] } as unknown as T;
  for (const { f } of frames) {
    const res = await ask<T>(tabId, msg, f.frameId).catch(() => undefined);
    if (!res) continue;
    const placed = inTab(res, f.frameId, f.box);
    if (placed.kind === 'found') return placed;
    if (placed.candidates?.length || last.kind === 'missing') last = placed;
  }
  return last;
}
