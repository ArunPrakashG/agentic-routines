import type { ContentMsg } from '../entrypoints/content';
import { platform } from './platform';

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
  else controlled.set(tabId, { mode, until: Date.now() + ttl });
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
export const rendering = (tabId: number) => ask<boolean>(tabId, { t: 'rendering' }).catch(() => true);

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

// The agent works in one tab, which it can change with tab_id or new_tab.
let agentTab: number | undefined;

export async function agentTabId(requested?: number): Promise<number> {
  if (requested !== undefined) {
    agentTab = requested;
    return requested;
  }
  if (agentTab !== undefined) {
    try {
      await browser.tabs.get(agentTab);
      return agentTab;
    } catch {
      agentTab = undefined;
    }
  }
  const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id !== undefined && /^https?:/.test(active.url ?? '')) return (agentTab = active.id);
  const t = await browser.tabs.create({ url: 'about:blank', active: true });
  return (agentTab = t.id!);
}

export function setAgentTab(id: number) {
  agentTab = id;
}

export { sleep };
