import type { ContentMsg } from '../../entrypoints/content';
import { platform } from '../platform';
import { dialogOn, unlessDialog } from './dialogs';
import { cancelSession, handedOver, onHandoffChange } from './handoff';
import { guardTab, listed, notListed, policyOf, unguardTab, watchPolicies } from './policy';
import type { Send } from '../platform/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ensureContent(tabId: number, frameId = 0) {
  try {
    if (await browser.tabs.sendMessage(tabId, { t: 'ping' }, { frameId })) return;
  } catch {
    // Not injected: the tab was open before install, or the page just loaded.
  }
  await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['/content-scripts/content.js'] });
}

// A ref from a frame says which: f12:ref_3. One with no prefix is in the page itself.
const FRAMED = /^f(\d+):(.+)$/;
export const inFrame = (frameId: number, ref: string) => (frameId ? `f${frameId}:${ref}` : ref);
export const frameOf = (ref?: string) => Number(FRAMED.exec(ref ?? '')?.[1] ?? 0);

/** Ask the page to do something. Retries once after injecting the content script. Goes to the frame its ref is in, or the one named. */
export async function ask<T = unknown>(tabId: number, msg: ContentMsg, frame?: number): Promise<T> {
  const named = 'ref' in msg && msg.ref ? FRAMED.exec(msg.ref) : null;
  const frameId = named ? Number(named[1]) : (frame ?? 0);
  const out = named ? ({ ...msg, ref: named[2] } as ContentMsg) : msg;
  const res = await unlessDialog(tabId, async (): Promise<{ ok?: T; err?: string } | undefined> => {
    try {
      return await browser.tabs.sendMessage(tabId, out, { frameId });
    } catch {
      await ensureContent(tabId, frameId);
      return browser.tabs.sendMessage(tabId, out, { frameId });
    }
  });
  if (!res) throw new Error('The page did not answer');
  if (res.err) throw new Error(res.err);
  return res.ok as T;
}

/** Tell every document in a tab. Those that cannot hear it are not missed. */
export async function tellAll(tabId: number, msg: ContentMsg) {
  await browser.tabs.sendMessage(tabId, msg).catch(() => {});
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

// A picture of a tab behind another can take seconds to come back, so nobody waits for it, and one at a time is enough.
const drawing = new Set<number>();
export function draw(tabId: number, send: Send) {
  if (drawing.has(tabId)) return;
  drawing.add(tabId);
  void send('Page.captureScreenshot', { format: 'jpeg', quality: 1 })
    .catch(() => {})
    .finally(() => drawing.delete(tabId));
}

/** Draws one frame if the window has stopped drawing. Browsers without a DevTools session leave it as it is. */
export async function wake(tabId: number) {
  if (!platform.cdp || (await rendering(tabId))) return;
  try {
    await platform.cdp(tabId, async (send) => draw(tabId, send));
  } catch {
    // Something else is attached, or the page is restricted.
  }
}

export async function waitLoaded(tabId: number, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await browser.tabs.get(tabId);
    // Stopped until someone answers: there is nothing more to wait for here.
    if (dialogOn(tabId)) return;
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
// Tabs a session opened itself. When the session ends they are closed, and the group goes with them.
// A tab the person had open is never in here, even if the agent was pointed at it.
const opened = new Map<string, Set<number>>();
const made = (session: string, tabId: number) => {
  if (!opened.has(session)) opened.set(session, new Set());
  opened.get(session)!.add(tabId);
  return tabId;
};

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

// A named session outlives the server that started it: nothing ends it but being reset or deleted, and what it holds
// is kept where a service worker that restarts can find it.
const isNamed = (session: string) => session.startsWith('named:');
function keepNamed() {
  const all: Record<string, { tab?: number; opened: number[]; label?: string }> = {};
  for (const s of new Set([...tabOf.keys(), ...opened.keys()])) if (isNamed(s)) all[s] = { tab: tabOf.get(s), opened: [...(opened.get(s) ?? [])], label: labels.get(s) };
  void browser.storage.session?.set({ named: all }).catch(() => {});
}
async function restoreNamed() {
  const all = ((await browser.storage.session?.get('named'))?.named ?? {}) as Record<string, { tab?: number; opened: number[]; label?: string }>;
  for (const [s, v] of Object.entries(all)) {
    if (v.label) labels.set(s, v.label);
    const alive = async (id: number) => browser.tabs.get(id).then(() => true, () => false);
    const mine = (await Promise.all(v.opened.map(async (id) => ((await alive(id)) ? id : undefined)))).filter((id): id is number => id !== undefined);
    if (mine.length) opened.set(s, new Set(mine));
    if (v.tab !== undefined && (await alive(v.tab))) {
      holds.set(v.tab, { session: s, label: labelOf(s), until: Number.MAX_SAFE_INTEGER, marked: 0 });
      tabOf.set(s, v.tab);
    }
  }
}

/** A named session goes by the name it was given. */
export function nameSession(session: string, name: string) {
  labels.set(session, name);
  keepNamed();
}

/** What a named session has open, for the list. */
export async function sessionTabs(session: string) {
  await prune();
  const ids = new Set([...(opened.get(session) ?? [])]);
  const cur = tabOf.get(session);
  if (cur !== undefined) ids.add(cur);
  const tabs = await Promise.all([...ids].map((id) => browser.tabs.get(id).catch(() => undefined)));
  return tabs.filter((t) => t).map((t) => ({ id: t!.id, url: t!.url, current: t!.id === cur }));
}

/** May this session act on what the tab is showing now. A navigation away is the way out, so that is not asked here. */
export async function onItsSites(session: string | undefined, tabId: number) {
  const hosts = policyOf(session)?.hosts;
  if (!hosts) return;
  const url = (await browser.tabs.get(tabId)).url;
  if (!listed(hosts, url)) throw new Error(`Tab ${tabId} is at ${url}, and ${notListed(url ?? '', hosts)} Navigate to a listed site first.`);
}

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
  // A tab the session opened stays held to its sites, or its page could walk off them while nobody watches.
  if (!h || !opened.get(h.session)?.has(tabId)) void unguardTab(tabId);
  void mark(tabId, null);
  paint(tabId);
  keepNamed();
}

/** What the toolbar button says on this tab: WAIT for the person, RUN while something drives it. */
export function paint(tabId: number) {
  const text = handedOver(tabId) ? 'WAIT' : heldBy(tabId) ? 'RUN' : lent.has(tabId) ? 'ON' : null;
  void browser.action.setBadgeText({ tabId, text: text as string }).catch(() => {});
}

/**
 * The session has ended: let go of the tab it holds and close the tabs it opened, which takes its group with them.
 * A tab the person is looking at, or has since taken over, stays open.
 */
export async function releaseSession(session: string) {
  cancelSession(session);
  const t = tabOf.get(session);
  if (t !== undefined) {
    releaseTab(t);
    await platform.release?.(t);
  }
  labels.delete(session);
  const mine = [...(opened.get(session) ?? [])];
  opened.delete(session);
  keepNamed();
  for (const id of mine) {
    void unguardTab(id);
    try {
      const tab = await browser.tabs.get(id);
      const win = await browser.windows.get(tab.windowId);
      if (tab.active && win.focused) continue;
      await browser.tabs.remove(id);
    } catch {
      // Already closed.
    }
  }
}

function claim(session: string, tabId: number): number {
  const before = tabOf.get(session);
  if (before !== undefined && before !== tabId) releaseTab(before);
  const label = labelOf(session);
  holds.set(tabId, { session, label, until: isNamed(session) ? Number.MAX_SAFE_INTEGER : Date.now() + LEASE_MS, marked: Date.now() });
  tabOf.set(session, tabId);
  void guardTab(tabId, policyOf(session));
  void mark(tabId, label);
  paint(tabId);
  keepNamed();
  return tabId;
}

/** A tab being driven stays held: called whenever its session does something to it. */
function touch(tabId: number) {
  const h = holds.get(tabId);
  if (!h) return;
  if (!isNamed(h.session)) h.until = Date.now() + LEASE_MS;
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
      if (h.until < Date.now()) {
        void mark(tabId, null);
        paint(tabId);
      }
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
  const back = takenFrom.get(session);
  if (back !== undefined && (requested === undefined || requested === back)) {
    // Said once to a session that leaves out the tab. One that names it keeps being told, until the person lends it again.
    if (requested === undefined || lent.has(back)) takenFrom.delete(session);
    if (!lent.has(back)) throw new Error(`The user took tab ${back} back. Do not use it again unless they lend it. Call again to work in a tab of your own.`);
  }
  const wanted = requested ?? tabOf.get(session);
  // It is the person's until they give it back, and a click from here must not be what gives it back.
  if (wanted !== undefined && handedOver(wanted)) throw new Error(`Tab ${wanted} is with the user: a hand-over is waiting for them. Call handoff again to wait for it, and do nothing in that tab until it returns.`);
  if (requested !== undefined) {
    await browser.tabs.get(requested).catch(() => {
      throw new Error(`There is no tab ${requested}. Call tabs to see the open ones.`);
    });
    const hosts = policyOf(session)?.hosts;
    if (hosts && !opened.get(session)?.has(requested) && tabOf.get(session) !== requested) {
      const url = (await browser.tabs.get(requested)).url;
      if (!listed(hosts, url)) throw new Error(notListed(url ?? `Tab ${requested}`, hosts));
    }
    const h = heldBy(requested);
    if (h && h.session !== session) throw new Error(`Tab ${requested} is locked by ${h.label}, another agent working in the browser. Use your own tab: leave out tab_id, or pass new_tab to navigate.`);
    return claim(session, requested);
  }
  const own = tabOf.get(session);
  if (own !== undefined) return claim(session, own);
  const alone = holds.size === 0;
  if (alone) return claim(session, made(session, (await browser.tabs.create({ url: 'about:blank', active: false })).id!));
  // Someone else is working: not in the person's window or in the other agent's.
  const w = await browser.windows.create({ url: 'about:blank', focused: false });
  const id = w?.tabs?.[0]?.id ?? (w?.id !== undefined ? (await browser.tabs.query({ windowId: w.id }))[0]?.id : undefined);
  if (id === undefined) throw new Error('The browser did not open a window for this agent');
  return claim(session, made(session, id));
}

// Tabs the person lent with the toolbar button. Stored so that a service worker that restarts still knows.
const lent = new Set<number>();
const takenFrom = new Map<string, number>();
const keepLent = () => browser.storage.session?.set({ lent: [...lent] }).catch(() => {});
export const isLent = (tabId: number) => lent.has(tabId);
export const lentTabs = () => [...lent];

export function lend(tabId: number) {
  lent.add(tabId);
  void keepLent();
  paint(tabId);
}

/** The person takes it back. Whatever session held it hears so on its next call, and its debugger lets go. */
export async function takeBack(tabId: number) {
  lent.delete(tabId);
  void keepLent();
  const h = holds.get(tabId);
  if (h) {
    takenFrom.set(h.session, tabId);
    releaseTab(tabId);
  }
  paint(tabId);
  await glow(tabId, 'off');
  await platform.release?.(tabId);
}

/** Work in a lent tab, named by id or by address. It stays the person's: it is never in the list of tabs a session may close. */
export async function adopt(session: string = USER, o: { tabId?: number; url?: string }) {
  await prune();
  const tabs = await Promise.all(lentTabs().map((id) => browser.tabs.get(id).catch(() => undefined)));
  const open = tabs.filter((t) => t?.id !== undefined) as (Browser.tabs.Tab & { id: number })[];
  const match = o.tabId !== undefined ? open.filter((t) => t.id === o.tabId) : open.filter((t) => t.url === o.url || (o.url && t.url?.startsWith(o.url)));
  if (!match.length) {
    const said = o.tabId !== undefined ? `Tab ${o.tabId} has` : `No tab at ${o.url} has`;
    throw new Error(`${said} not been lent. The user lends a tab with the Agentic Routines toolbar button.${open.length ? ` Lent now: ${open.map((t) => `${t.id} (${t.url})`).join(', ')}.` : ''}`);
  }
  if (match.length > 1) throw new Error(`More than one lent tab is at that address: ${match.map((t) => t.id).join(', ')}. Pass tab_id.`);
  const tabId = match[0].id;
  const h = heldBy(tabId);
  if (h && h.session !== session) throw new Error(`Tab ${tabId} is locked by ${h.label}, another agent working in the browser.`);
  takenFrom.delete(session);
  claim(session, tabId);
  return tabId;
}

// A tab that a page opened because of what a session did there, and the tab it came from. Within a moment of the session
// acting, because a person can open tabs from there too, and those are theirs.
const SPAWN_MS = 10_000;
const cameFrom = new Map<number, number>();
const spawned = new Map<number, number>();

export function watchTabs() {
  onHandoffChange((tabId) => paint(tabId));
  watchPolicies();
  void restoreNamed();
  void browser.storage.session?.get('lent').then((s) => {
    for (const id of (s.lent as number[] | undefined) ?? []) {
      lent.add(id);
      paint(id);
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    if (lent.delete(tabId)) void keepLent();
  });
  // A new document starts with the button's text cleared.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status) paint(tabId);
  });
  browser.tabs.onCreated.addListener((t) => {
    if (t.id === undefined || t.openerTabId === undefined) return;
    const h = heldBy(t.openerTabId);
    // A page held to a list opens nothing outside it, however long after the session last acted.
    const hosts = h && policyOf(h.session)?.hosts;
    if (hosts) {
      void guardTab(t.id, policyOf(h.session));
      const to = t.pendingUrl ?? t.url;
      if (to && to !== 'about:blank' && !listed(hosts, to)) {
        popupRefused.set(h.session, notListed(to, hosts));
        void browser.tabs.remove(t.id).catch(() => {});
        return;
      }
    }
    if (!h || (!isNamed(h.session) && LEASE_MS - (h.until - Date.now()) > SPAWN_MS)) return;
    made(h.session, t.id);
    keepNamed();
    cameFrom.set(t.id, t.openerTabId);
    spawned.set(t.openerTabId, t.id);
  });
}

const popupRefused = new Map<string, string>();
/** A popup a page tried to open for this session and was stopped, once. */
export function takePopupRefused(session: string = USER) {
  const why = popupRefused.get(session);
  popupRefused.delete(session);
  return why;
}

/** The tab what a session just did has opened, once. */
export function takeSpawned(tabId: number) {
  const id = spawned.get(tabId);
  spawned.delete(tabId);
  return id;
}

export const isOwnTab = (session: string = USER, tabId: number) => !!opened.get(session)?.has(tabId);

/** Close a tab a session opened, or its pages opened for it. Any other is the person's. Back to where it came from, if that is still there. */
export async function closeOwnTab(session: string = USER, requested?: number) {
  const id = requested ?? tabOf.get(session);
  if (id === undefined) throw new Error('You have no tab open.');
  if (!isOwnTab(session, id)) throw new Error(`Tab ${id} is not one you opened, so it stays open.`);
  const from = cameFrom.get(id);
  opened.get(session)!.delete(id);
  void unguardTab(id);
  keepNamed();
  cameFrom.delete(id);
  if (holds.get(id)?.session === session) holds.delete(id);
  const current = tabOf.get(session) === id;
  if (current) tabOf.delete(session);
  await platform.release?.(id);
  await browser.tabs.remove(id).catch(() => {});
  if (!current || from === undefined) return undefined;
  const alive = await browser.tabs.get(from).then(() => true, () => false);
  const h = heldBy(from);
  return alive && (!h || h.session === session) ? claim(session, from) : undefined;
}

/** A new tab opened by a session becomes the one it works in, next to its old one. */
export async function openTab(session: string = USER, url: string): Promise<number> {
  await prune();
  const own = tabOf.get(session);
  const windowId = own !== undefined ? await browser.tabs.get(own).then((t) => t.windowId, () => undefined) : undefined;
  const hosts = policyOf(session)?.hosts;
  if (hosts && !listed(hosts, url)) throw new Error(notListed(url, hosts));
  const t = await browser.tabs.create({ url, active: false, ...(windowId !== undefined ? { windowId } : {}) });
  return claim(session, made(session, t.id!));
}

export { sleep };
