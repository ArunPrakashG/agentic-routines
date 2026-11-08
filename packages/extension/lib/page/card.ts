// The card a person sees when a tab is handed to them. It sits in a closed shadow root, and only a real click on it
// counts: what a page scripts has isTrusted false, and a page cannot reach this script or its message to the extension.

const INK = '#14131f';
const ACCENT = '#3530e0';
const CSS = `
:host{all:initial}
.card{position:fixed;right:16px;top:16px;width:320px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:16px;border-radius:12px;background:#fff;color:${INK};border:1px solid rgba(20,19,31,.16);box-shadow:0 8px 28px rgba(20,19,31,.28);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:auto}
.who{font-size:12px;color:#5c5a6e;margin:0 0 6px}
.why{margin:0 0 10px;overflow-wrap:anywhere}
.site{margin:0 0 12px;font-size:12px;overflow-wrap:anywhere;color:#5c5a6e}
.site b{color:${INK};font-weight:600}
button{display:block;width:100%;min-height:44px;border:0;border-radius:8px;background:${ACCENT};color:#fff;font:600 14px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
button:focus-visible{outline:2px solid ${INK};outline-offset:2px}
@media (prefers-color-scheme:dark){.card{background:#1c1b29;color:#f1f0f7;border-color:rgba(255,255,255,.18)}.who,.site{color:#a9a7bb}.site b{color:#f1f0f7}}
`;
// A click that lands in the moment the card appears was meant for the page.
const SETTLE_MS = 400;

export interface CardText {
  nonce: string;
  origin: string;
  reason: string;
  by: string;
}

let host: HTMLElement | undefined;
let keeper: MutationObserver | undefined;

export function hideCard() {
  keeper?.disconnect();
  keeper = undefined;
  host?.remove();
  host = undefined;
}

export function showCard(c: CardText) {
  hideCard();
  const shownAt = Date.now();
  const el = document.createElement('div');
  const root = el.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  const card = document.createElement('div');
  card.className = 'card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Your turn');
  const para = (cls: string, text: string) => Object.assign(document.createElement('p'), { className: cls, textContent: text });
  const site = para('site', 'On ');
  site.append(Object.assign(document.createElement('b'), { textContent: c.origin }));
  const go = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Done, carry on' });
  go.addEventListener('click', (e) => {
    if (!e.isTrusted || Date.now() - shownAt < SETTLE_MS) return;
    void browser.runtime.sendMessage({ t: 'handoff.continue', nonce: c.nonce });
  });
  card.append(para('who', `${c.by} needs you`), para('why', c.reason), site, go);
  root.append(style, card);
  el.style.cssText = 'all:initial;position:fixed;right:16px;top:16px;width:320px;max-width:calc(100vw - 32px);z-index:2147483647;display:block';
  const place = () => (document.body ?? document.documentElement).append(el);
  place();
  host = el;
  // A page that takes the card away gets it back.
  keeper = new MutationObserver(() => {
    if (host === el && !el.isConnected) place();
  });
  keeper.observe(document.documentElement, { childList: true, subtree: true });
}
