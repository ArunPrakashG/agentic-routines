import type { ContentMsg } from '../../entrypoints/content';
import { platform } from '../platform';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureContent(tabId: number) {
  try {
    if (await browser.tabs.sendMessage(tabId, { t: 'ping' }, { frameId: 0 })) return;
  } catch {
    // Not injected: the tab was open before install, or the page just loaded.
  }
  await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
}

/** Ask the page to do something. Retries once after injecting the content script. */
export async function ask<T = unknown>(tabId: number, msg: ContentMsg): Promise<T> {
  let res: { ok?: T; err?: string } | undefined;
  try {
    res = await browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    await ensureContent(tabId);
    res = await browser.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
  if (!res) throw new Error('The page did not answer');
  if (res.err) throw new Error(res.err);
  return res.ok as T;
}

// Tabs a routine or an agent is driving: their pages glow, and the glow comes back after a navigation.
const controlled = new Map<number, { mode: 'run' | 'paused'; until: number }>();

/** Show that this tab is being driven. The page ends the glow by itself after ttl, so a stalled run leaves nothing behind. */
export async function glow(tabId: number, mode: 'run' | 'paused' | 'off', ttl = 8000) {
  if (mode === 'off') controlled.delete(tabId);
  else {
    controlled.set(tabId, { mode, until: Date.now() + ttl });
    touch(tabId);
  }
  try {
    await ask(tabId, { t: 'glow', mode, ttl });
  } catch {
    // A restricted page cannot show it.
  }
}

/** Run something that takes a picture of the tab, with the glow, cursor and outline out of the picture. */
export async function bare<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  if (!controlled.has(tabId)) return fn();
  await ask(tabId, { t: 'veil', on: true }).catch(() => {});
  // The next frame is one without it.
  await rendering(tabId);
  try {
    return await fn();
  } finally {
    await ask(tabId, { t: 'veil', on: false }).catch(() => {});
  }
}

// A window on a hidden workspace stops drawing, and a page waiting for a frame stops with it.
// The page answers after a frame or after 150 ms, but a page behind another tab runs its timers slowly, so the wait is kept here too.
export const rendering = (tabId: number) =>
  Promise.race([ask<boolean>(tabId, { t: 'rendering' }).catch(() => true), sleep(200).then(() => false)]);

/** Draws one frame if the window has stopped drawing. Browsers without a DevTools session leave it as it is. */
export async function wake(tabId: number) {
  if (!platform.cdp || (await rendering(tabId))) return;
  try {
    await platform.cdp(tabId, (send) => send('Page.captureScreenshot', { format: 'jpeg', quality: 1 }));
  } catch {
    // Something else is attached, or the page is restricted.
  }
}

export async function waitLoaded(tabId: number, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete') {
      try {
        await ensureContent(tabId);
        // A new document starts without the glow.
        const c = controlled.get(tabId);
        if (c && c.until > Date.now()) void glow(tabId, c.mode, c.until - Date.now());
        const h = heldBy(tabId);
        if (h) void mark(tabId, h.label);
        return;
      } catch {
        // Restricted page or still swapping documents.
      }
    }
    await sleep(150);
  }
  throw new Error('The page took too long to load');
}

/** After an action: let the page react, and follow a navigation if one started. */
export async function settle(tabId: number, beforeUrl: string): Promise<string> {
  await sleep(250);
  let t = await browser.tabs.get(tabId);
  if (t.status === 'loading' || t.url !== beforeUrl) {
    await waitLoaded(tabId);
    t = await browser.tabs.get(tabId);
  }
  await wake(tabId);
  await sleep(150);
  return t.url ?? beforeUrl;
}

// Each agent session works in a tab of its own, and holds it until it lets go or is silent for LEASE_MS.
// Two agents never click in the same page: a tab one of them holds is locked to the other. The held tab's title
// carries the agent's name (see mark.ts), so a person can see which tabs are in use and by whom.
const LEASE_MS = 15 * 60_000;
const USER = 'user';

interface Hold {
  session: string;
  label: string;
  until: number;
  marked: number;
}
const holds = new Map<number, Hold>();
const tabOf = new Map<string, number>();
const labels = new Map<string, string>();

/** What to call a session in the title and in messages. Two sessions of one agent are told apart by a number. */
export function noteSession(session: string | undefined, name: string) {
  const key = session ?? USER;
  if (labels.has(key)) return;
  const taken = new Set(labels.values());
  let label = name;
  for (let n = 2; taken.has(label); n++) label = `${name} ${n}`;
  labels.set(key, label);
}
const labelOf = (session: string) => labels.get(session) ?? (session === USER ? 'Replay' : 'Agent');

// The title is the page's to change, so it is only a hint. A tab group belongs to the browser and a page cannot
// touch it: the held tab goes in a group named for its agent, where the browser has groups and the tab is not already
// in one of the person's own, and is not the only tab in its window.
const ours = new Set<number>();

async function group(tabId: number, label: string | null) {
  const groups = (browser as unknown as { tabGroups?: { update(id: number, p: object): Promise<unknown> } }).tabGroups;
  const tabs = browser.tabs as typeof browser.tabs & { group?: (o: object) => Promise<number>; ungroup?: (ids: number) => Promise<void> };
  if (!groups || !tabs.group || !tabs.ungroup) return;
  try {
    if (label === null) {
      if (ours.delete(tabId)) await tabs.ungroup(tabId);
      return;
    }
    const tab = await browser.tabs.get(tabId);
    // Grouping the only tab of a window makes the browser close that window, so it stays out.
    if (!ours.has(tabId) && (await browser.tabs.query({ windowId: tab.windowId })).length < 2) return;
    const gid = (tab as { groupId?: number }).groupId;
    if (gid !== undefined && gid !== -1 && !ours.has(tabId)) return;
    const id = ours.has(tabId) ? gid! : await tabs.group({ tabIds: tabId });
    ours.add(tabId);
    await groups.update(id, { title: label, color: 'purple' });
  } catch {
    // The tab is gone, or the browser would not group it.
  }
}

function mark(tabId: number, label: string | null) {
  const title = ask(tabId, { t: 'lock', label, ttl: LEASE_MS }).catch(() => {
    // A restricted or blank page cannot show it.
  });
  return Promise.all([title, group(tabId, label)]);
}

function releaseTab(tabId: number) {
  const h = holds.get(tabId);
  holds.delete(tabId);
  if (h && tabOf.get(h.session) === tabId) tabOf.delete(h.session);
  void mark(tabId, null);
}

/** Let go of the tab a session holds, when the session ends. The tab stays open. */
export function releaseSession(session: string) {
  const t = tabOf.get(session);
  if (t !== undefined) releaseTab(t);
  labels.delete(session);
}

function claim(session: string, tabId: number): number {
  const before = tabOf.get(session);
  if (before !== undefined && before !== tabId) releaseTab(before);
  const label = labelOf(session);
  holds.set(tabId, { session, label, until: Date.now() + LEASE_MS, marked: Date.now() });
  tabOf.set(session, tabId);
  void mark(tabId, label);
  return tabId;
}

/** A tab being driven stays held: called whenever its session does something to it. */
function touch(tabId: number) {
  const h = holds.get(tabId);
  if (!h) return;
  h.until = Date.now() + LEASE_MS;
  if (Date.now() - h.marked > 60_000) {
    h.marked = Date.now();
    void mark(tabId, h.label);
  }
}

/** Who holds a tab, for lists and messages. */
export const heldBy = (tabId: number) => (holds.get(tabId) && holds.get(tabId)!.until > Date.now() ? holds.get(tabId) : undefined);

async function prune() {
  for (const [tabId, h] of holds) {
    let gone = h.until < Date.now();
    if (!gone) gone = await browser.tabs.get(tabId).then(() => false, () => true);
    if (gone) {
      holds.delete(tabId);
      if (tabOf.get(h.session) === tabId) tabOf.delete(h.session);
      if (h.until < Date.now()) void mark(tabId, null);
    }
  }
}

/**
 * The tab a session works in. `requested` picks one: it must not be held by another session.
 * With none, the session's own tab; else a new tab, which never takes over one the person has open. It sits in the
 * person's window when no other session has one, and in a window of its own when another agent is working.
 */
export async function agentTabId(session: string = USER, requested?: number): Promise<number> {
  await prune();
  if (requested !== undefined) {
    await browser.tabs.get(requested).catch(() => {
      throw new Error(`There is no tab ${requested}. Call tabs to see the open ones.`);
    });
    const h = heldBy(requested);
    if (h && h.session !== session) throw new Error(`Tab ${requested} is locked by ${h.label}, another agent working in the browser. Use your own tab: leave out tab_id, or pass new_tab to navigate.`);
    return claim(session, requested);
  }
  const own = tabOf.get(session);
  if (own !== undefined) return claim(session, own);
  const alone = holds.size === 0;
  if (alone) return claim(session, (await browser.tabs.create({ url: 'about:blank', active: false })).id!);
  // Someone else is working: not in the person's window or in the other agent's.
  const w = await browser.windows.create({ url: 'about:blank', focused: false });
  const id = w?.tabs?.[0]?.id ?? (w?.id !== undefined ? (await browser.tabs.query({ windowId: w.id }))[0]?.id : undefined);
  if (id === undefined) throw new Error('The browser did not open a window for this agent');
  return claim(session, id);
}

/** A new tab opened by a session becomes the one it works in, next to its old one. */
export async function openTab(session: string = USER, url: string): Promise<number> {
  await prune();
  const own = tabOf.get(session);
  const windowId = own !== undefined ? await browser.tabs.get(own).then((t) => t.windowId, () => undefined) : undefined;
  const t = await browser.tabs.create({ url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
  return claim(session, t.id!);
}

export { sleep };
