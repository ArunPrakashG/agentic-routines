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

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  browser.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    clearTimeout(held.get(source.tabId)?.timer);
    held.delete(source.tabId);
    if (reason === 'canceled_by_user') refusedUntil = Date.now() + REFUSED_MS;
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
  async release(tabId) {
    const h = held.get(tabId);
    if (!h) return;
    clearTimeout(h.timer);
    held.delete(tabId);
    await browser.debugger.detach({ tabId }).catch(() => {});
  },
  openPanelOnClick() {
    (browser as any).sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  },
};
