import type { Platform, Send } from './types';

// Chrome, Edge, Brave, Vivaldi, Opera and the rest of the Chromium family.

function name() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if ((navigator as any).brave) return 'Brave';
  return 'Chrome';
}

// A session stays on a tab while it is being driven and goes a minute after the last use. Attaching puts a bar across the
// window, which moves the page: going on and off between steps would move it under every click.
const IDLE_MS = 60_000;
const held = new Map<number, { ready: Promise<void>; timer?: ReturnType<typeof setTimeout> }>();
// The person pressed Cancel on that bar: nothing attaches again until this time, and everything uses DOM events.
const REFUSED_MS = 10 * 60_000;
let refusedUntil = 0;

const hearing = new Set<(tabId: number, method: string, params: any, child?: string) => void>();

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  browser.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    clearTimeout(held.get(source.tabId)?.timer);
    held.delete(source.tabId);
    if (reason === 'canceled_by_user') refusedUntil = Date.now() + REFUSED_MS;
    for (const fn of hearing) fn(source.tabId, 'detached', {});
  });
  browser.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    for (const fn of hearing) fn(source.tabId, method, params, (source as { sessionId?: string }).sessionId);
  });
}

async function attach(tabId: number) {
  const target = { tabId };
  listen();
  try {
    await browser.debugger.attach(target, '1.3');
  } catch (e) {
    // Still attached from before the background script last restarted.
    if (!/already attached/i.test((e as Error).message)) throw e;
    await browser.debugger.detach(target).catch(() => {});
    await browser.debugger.attach(target, '1.3');
  }
  // A tab behind another one takes input and keeps its focus as if it were in front.
  await browser.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  // For dialogs, which nothing else can see.
  await browser.debugger.sendCommand(target, 'Page.enable').catch(() => {});
  // The bar takes its height from the page a moment after attaching.
  await new Promise((r) => setTimeout(r, 200));
}

export const chromium: Platform = {
  name: name(),
  async cdp(tabId, fn) {
    if (Date.now() < refusedUntil) throw new Error('The person cancelled debugging in this browser');
    const target = { tabId };
    let h = held.get(tabId);
    if (!h) {
      h = { ready: attach(tabId) };
      held.set(tabId, h);
      h.ready.catch(() => held.delete(tabId));
    }
    clearTimeout(h.timer);
    await h.ready;
    try {
      const send: Send = (method, params) => browser.debugger.sendCommand(target, method, params) as Promise<any>;
      return await fn(send);
    } finally {
      const now = held.get(tabId);
      if (now) {
        clearTimeout(now.timer);
        now.timer = setTimeout(() => void chromium.release!(tabId), IDLE_MS);
      }
    }
  },
  sendTo(tabId, child, method, params) {
    return chromium.cdp!(tabId, () => browser.debugger.sendCommand({ tabId, ...(child ? { sessionId: child } : {}) } as { tabId: number }, method, params) as Promise<unknown>);
  },
  async targetOf(tabId) {
    await chromium.cdp!(tabId, async () => {});
    const t = (await browser.debugger.getTargets()).find((x) => x.tabId === tabId);
    if (!t) throw new Error(`No DevTools target for tab ${tabId}`);
    return t.id;
  },
  async release(tabId) {
    const h = held.get(tabId);
    if (!h) return;
    clearTimeout(h.timer);
    held.delete(tabId);
    await browser.debugger.detach({ tabId }).catch(() => {});
  },
  onEvent(fn) {
    hearing.add(fn);
  },
  onToolbar(first) {
    // Opened by hand, as the click also has to reach us. Only within the click itself does the browser allow it.
    (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    browser.action.onClicked.addListener((tab) => {
      if (first(tab)) (browser as any).sidePanel.open({ tabId: tab.id }).catch(() => {});
    });
  },
};
