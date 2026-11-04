import type { ContentMsg } from '../entrypoints/content';

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

export async function waitLoaded(tabId: number, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete') {
      try {
        await ensureContent(tabId);
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
