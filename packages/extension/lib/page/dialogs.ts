import { platform } from '../platform';

// An alert stops the page until someone answers, and a stopped page answers nothing, so a message to it would wait for ever.
// The browser says when one opens, on a tab with a debugging connection. Behind another tab with no connection, it does not
// open at all: the browser answers it with no.

export interface OpenDialog {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  answer?: string;
  url: string;
}

const open = new Map<number, OpenDialog>();
const waiting = new Map<number, Set<(d: OpenDialog) => void>>();

const onOpen = (tabId: number, fn: (d: OpenDialog) => void) => {
  if (!waiting.has(tabId)) waiting.set(tabId, new Set());
  waiting.get(tabId)!.add(fn);
  return () => void waiting.get(tabId)?.delete(fn);
};

export function watchDialogs() {
  platform.onEvent?.((tabId, method, params) => {
    if (method === 'Page.javascriptDialogOpening') {
      const d = { type: params.type, message: params.message ?? '', answer: params.defaultPrompt, url: params.url ?? '' };
      open.set(tabId, d);
      for (const fn of waiting.get(tabId) ?? []) fn(d);
    } else if (method === 'Page.javascriptDialogClosed' || method === 'detached') open.delete(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => void open.delete(tabId));
}

export const dialogOn = (tabId: number) => open.get(tabId);

const stopped = (d: OpenDialog) => new Error(`A ${d.type} dialog is open and the page is stopped until it is answered. It says: ${d.message}. Answer it with the dialog tool.`);

/** Something that needs the page to answer. It fails at once when the page cannot. */
export function unlessDialog<T>(tabId: number, work: () => Promise<T>): Promise<T> {
  const d = open.get(tabId);
  if (d) return Promise.reject(stopped(d));
  return new Promise<T>((res, rej) => {
    const off = onOpen(tabId, (x) => rej(stopped(x)));
    work().then(res, rej).finally(off);
  });
}

/** To go on the end of what an action says. */
export function dialogNote(tabId: number) {
  const d = open.get(tabId);
  return d ? ` That opened a ${d.type} dialog, and the page is stopped until it is answered. It says: ${d.message}. Answer it with the dialog tool.` : '';
}

/** The dialog in a tab, once there is one. */
export async function waitDialog(tabId: number, ms: number): Promise<OpenDialog | undefined> {
  if (open.has(tabId)) return open.get(tabId);
  let off = () => {};
  const out = await Promise.race([new Promise<OpenDialog>((r) => (off = onOpen(tabId, r))), new Promise<undefined>((r) => setTimeout(r, ms))]);
  off();
  return out;
}

export async function answerDialog(tabId: number, accept: boolean, text?: string) {
  if (!platform.cdp) throw new Error('This browser does not let an extension answer dialogs.');
  await platform.cdp(tabId, (send) => send('Page.handleJavaScriptDialog', { accept, ...(text !== undefined ? { promptText: text } : {}) }));
  open.delete(tabId);
}

/** So a page that asks before it is left can be heard asking. Attaching does nothing for a tab with nothing to leave. */
export async function listenBeforeLeaving(tabId: number) {
  const { url } = await browser.tabs.get(tabId);
  if (/^https?:/.test(url ?? '')) await platform.cdp?.(tabId, async () => {}).catch(() => {});
}

const LEAVE_MS = 1000;

/** After asking a tab to go elsewhere: it starts going, or the page asks first. */
export async function whenLeaving(tabId: number, force: boolean): Promise<OpenDialog | undefined> {
  for (const end = Date.now() + LEAVE_MS; Date.now() < end; await new Promise((r) => setTimeout(r, 40))) {
    const d = open.get(tabId);
    if (d?.type === 'beforeunload') {
      await answerDialog(tabId, force);
      if (force) return d;
      throw new Error(`The page asks before it is left, and it may have work that is not saved, so this stayed on it. It says: ${d.message}. Pass force: true to leave anyway.`);
    }
    if ((await browser.tabs.get(tabId)).status === 'loading') return undefined;
  }
  return undefined;
}
