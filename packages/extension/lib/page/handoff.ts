import { ask } from './tabs';

// A tab handed to the person for a login, a code, a payment or a bot check. While it is theirs no tool and no replay can
// touch it, and nothing runs that costs anything: the call that asked only waits. A real click on the card or the toolbar
// button gives it back, and what they typed never reaches us.

const MAX_REASON = 300;

export interface Handed {
  continued: boolean;
  how?: 'card' | 'toolbar';
  closed?: boolean;
  /** The wait ran out and the card is still up: asking again picks it up. */
  waiting?: boolean;
}

interface Waiting {
  tabId: number;
  nonce: string;
  reason: string;
  by: string;
  session?: string;
  done: Promise<Handed>;
  finish: (h: Handed) => void;
}
const waiting = new Map<number, Waiting>();
let changed: (tabId: number, reason?: string) => void = () => {};
/** Told when a hand-over starts or ends, for the badge and notifications. */
export const onHandoffChange = (fn: typeof changed) => void (changed = fn);

export const handedOver = (tabId: number) => waiting.has(tabId);
export const handedTo = (session?: string) => [...waiting.values()].find((w) => w.session === session)?.tabId;

async function show(w: Waiting) {
  const tab = await browser.tabs.get(w.tabId);
  let origin = tab.url ?? '';
  try {
    origin = new URL(origin).origin;
  } catch {
    // Shown as it is.
  }
  await ask(w.tabId, { t: 'card', show: { nonce: w.nonce, origin, reason: w.reason, by: w.by } }).catch(() => {
    // A restricted page cannot show it. The toolbar button still works, and the badge says WAIT.
  });
}

/** Give the tab to the person. Resolves when they give it back, the tab closes or `waitMs` runs out, which leaves the card up. */
export function handOver(tabId: number, o: { reason: string; by: string; session?: string; waitMs: number }): Promise<Handed> {
  let w = waiting.get(tabId);
  if (!w) {
    let finish!: (h: Handed) => void;
    const done = new Promise<Handed>((res) => (finish = res));
    w = { tabId, nonce: crypto.randomUUID(), reason: o.reason.slice(0, MAX_REASON), by: o.by, session: o.session, done, finish };
    waiting.set(tabId, w);
    changed(tabId, w.reason);
    void show(w);
    // They have to be able to see it. A flash, not a stolen window: they may be busy somewhere else.
    void browser.tabs.update(tabId, { active: true }).then((t) => t && browser.windows.update(t.windowId, { drawAttention: true })).catch(() => {});
  }
  return Promise.race([w.done, new Promise<Handed>((res) => setTimeout(() => res({ continued: false, waiting: true }), o.waitMs))]);
}

function close(tabId: number, h: Handed) {
  const w = waiting.get(tabId);
  if (!w) return false;
  waiting.delete(tabId);
  w.finish(h);
  changed(tabId);
  void ask(tabId, { t: 'card', show: null }).catch(() => {});
  return true;
}

/** The click on the card, as the content script of the tab's top document reports it. Anything else is not a click on the card. */
export function fromCard(sender: { id?: string; tab?: { id?: number }; frameId?: number }, nonce: unknown) {
  const tabId = sender.tab?.id;
  if (sender.id !== browser.runtime.id || tabId === undefined || sender.frameId !== 0) return;
  if (waiting.get(tabId)?.nonce === nonce) close(tabId, { continued: true, how: 'card' });
}

export const fromToolbar = (tabId: number) => close(tabId, { continued: true, how: 'toolbar' });
/** A replay was stopped or a session ended: nobody is waiting for it now. */
export const cancelHandoff = (tabId: number) => close(tabId, { continued: false });
export function cancelSession(session: string) {
  for (const w of waiting.values()) if (w.session === session) close(w.tabId, { continued: false });
}

export function watchHandoffs() {
  browser.tabs.onRemoved.addListener((tabId) => void close(tabId, { continued: false, closed: true }));
  // A login moves between pages, and each new document starts without the card.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    const w = waiting.get(tabId);
    if (w && info.status === 'complete') void show(w);
  });
}
