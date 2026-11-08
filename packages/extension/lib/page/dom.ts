import { isIrreversible, stripInvisible, type Locator, type PageFingerprint, type Pointer, type Spot, type Viewport } from '@agentic-routines/core';
import { unmark } from './mark';
import { ariaHidden, hiddenWhy } from './hidden';

// Runs in the page. Turns elements into locators and outlines, and back.

const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading],legend';

// Characters nobody can see (zero-width, bidi overrides, tag characters) are taken out of every name and text, so a
// recorded name and a live one still match and an agent never reads what a person cannot.
const clean = (s: string | null | undefined, max = 80) => stripInvisible(s ?? '').text.replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- going into shadow roots ----------

/** A shadow root, open or closed. A page cannot see into a closed one; an extension can. */
export function rootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.id === 'agentic-routines-overlay' ? null : el.shadowRoot;
  if (!(el instanceof HTMLElement) || el.id === 'agentic-routines-overlay') return null;
  try {
    const dom = (globalThis as unknown as { chrome?: { dom?: { openOrClosedShadowRoot?(e: HTMLElement): ShadowRoot | null } } }).chrome?.dom;
    return dom?.openOrClosedShadowRoot?.(el) ?? (el as unknown as { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot ?? null;
  } catch {
    return null;
  }
}

/** What an element sits in, through a shadow root. */
const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);

export function closestDeep(el: Element, selector: string): Element | null {
  for (let e: Element | null = el; e; ) {
    const c = e.closest(selector);
    if (c) return c;
    e = ((e.getRootNode() as ShadowRoot).host as Element | undefined) ?? null;
  }
  return null;
}

function containsDeep(outer: Element, inner: Element) {
  for (let e: Element | null = inner; e; e = up(e)) if (e === outer) return true;
  return false;
}

const FRESH_MS = 300;
let shadows = { at: 0, roots: [] as ShadowRoot[] };

/** The shadow roots in this document, for a moment. Most pages have none. */
export function allShadowRoots(): ShadowRoot[] {
  if (Date.now() - shadows.at < FRESH_MS) return shadows.roots;
  const roots: ShadowRoot[] = [];
  const go = (r: ParentNode) => {
    for (const el of Array.from(r.querySelectorAll('*'))) {
      const s = rootOf(el);
      if (s) {
        roots.push(s);
        go(s);
      }
    }
  };
  go(document);
  shadows = { at: Date.now(), roots };
  return roots;
}

/** Everything that matches, in shadow roots too, in the order it is drawn. */
export function deepAll(selector: string): Element[] {
  if (!allShadowRoots().length) return Array.from(document.querySelectorAll(selector));
  const out: Element[] = [];
  const go = (r: ParentNode) => {
    for (const el of Array.from(r.querySelectorAll('*'))) {
      if (el.matches(selector)) out.push(el);
      const s = rootOf(el);
      if (s) go(s);
    }
  };
  go(document);
  return out;
}

/** What is drawn at a point, inside any shadow root. */
export function deepPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  for (let s = el && rootOf(el); s; s = el && rootOf(el)) {
    const inner = s.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

/** The document or shadow root an element is in, for what can only be looked up there. */
const homeOf = (el: Element) => el.getRootNode() as Document | ShadowRoot;

/** The page size a step was seen at. */
export function viewport(): Viewport {
  return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };
}

/**
 * Text of an element as a person sees it. innerText already leaves out what is not drawn; this also leaves out
 * what is drawn where nobody looks, if the element holds any of that.
 */
function seenText(el: Element): string {
  const own = (el as HTMLElement).innerText ?? el.textContent ?? '';
  const inner = el.querySelectorAll('*');
  if (inner.length > 200) return own;
  let sneaky = false;
  for (const d of Array.from(inner)) {
    const why = hiddenWhy(d);
    if (why && why !== 'not shown') {
      sneaky = true;
      break;
    }
  }
  if (!sneaky) return own;
  const parts: string[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const p = n.parentElement;
    if (p && !hiddenWhy(p)) parts.push(n.textContent ?? '');
  }
  return parts.join(' ');
}

export function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return el instanceof HTMLInputElement && el.type === 'file';
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  if (Number(s.opacity) > 0.05) return true;
  return drawnByLabel(el);
}

/** A custom checkbox: the real input is see-through and what is drawn is its label. */
function drawnByLabel(el: Element) {
  return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && Array.from(el.labels ?? []).some((l) => !hiddenWhy(l));
}

export function role(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(' ')[0];
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'img') return 'img';
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type;
    if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
    if (t === 'checkbox' || t === 'radio') return t;
    if (t === 'search') return 'searchbox';
    if (t === 'range') return 'slider';
    if (t === 'file') return 'button';
    return 'textbox';
  }
  if ((el as HTMLElement).isContentEditable) return 'textbox';
  if (['nav', 'main', 'form', 'dialog'].includes(tag)) return tag === 'nav' ? 'navigation' : tag;
  return 'generic';
}

function labelFor(el: Element): string {
  const id = el.id;
  if (id) {
    const l = homeOf(el).querySelector(`label[for="${CSS.escape(id)}"]`);
    if (l) return clean(seenText(l));
  }
  const wrap = el.closest('label');
  if (wrap) return clean(seenText(wrap));
  return '';
}

export function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    // What it points at has to be something a person can see, or a page could name a button anything.
    const named = clean(
      by
        .split(/\s+/)
        .map((i) => homeOf(el).getElementById(i))
        .map((n) => (n && !hiddenWhy(n) ? seenText(n) : ''))
        .join(' '),
    );
    if (named) return named;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const t = (el as HTMLInputElement).type;
    if (['button', 'submit', 'reset'].includes(t)) return clean((el as HTMLInputElement).value);
    return labelFor(el) || clean(el.getAttribute('placeholder')) || clean(el.getAttribute('title'));
  }
  if (tag === 'img') return clean(el.getAttribute('alt'));
  return clean(seenText(el)) || clean(el.getAttribute('title')) || wrappingLabel(el);
}

/** Custom checkboxes often sit inside a label that names them, which aria does not see. */
function wrappingLabel(el: Element): string {
  const label = el.closest('label');
  return label && Array.from(label.querySelectorAll(INTERACTIVE)).filter(visible).length === 1 ? clean(seenText(label)) : '';
}

function nearestHeading(el: Element): string {
  let at = el;
  for (let depth = 0; depth < 8; depth++) {
    const a = up(at);
    if (!a) break;
    // Order means nothing across a shadow root, so what comes before the host is looked at from the host.
    const hs = at.getRootNode() === a.getRootNode() ? Array.from(a.querySelectorAll(HEADINGS)).filter((h) => h !== at && h.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
    if (hs.length) return clean(seenText(hs[hs.length - 1]));
    at = a;
  }
  return '';
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let e: Element | null = el;
  for (let i = 0; e && i < 5; i++, e = e.parentElement) {
    if (e.id && !/\d{3,}/.test(e.id)) {
      parts.unshift(`#${CSS.escape(e.id)}`);
      break;
    }
    const tag = e.tagName.toLowerCase();
    const sibs = e.parentElement ? Array.from(e.parentElement.children).filter((c) => c.tagName === e!.tagName) : [];
    parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(e) + 1})` : tag);
  }
  return parts.join('>');
}

export function describe(el: Element): Locator {
  const attrs: Record<string, string> = {};
  for (const k of ['id', 'name', 'data-testid', 'data-test', 'data-qa', 'placeholder', 'type', 'aria-label']) {
    const v = el.getAttribute(k);
    if (v) attrs[k === 'data-test' || k === 'data-qa' ? 'data-testid' : k] = v.slice(0, 120);
  }
  const href = el.getAttribute('href');
  if (href) {
    try {
      attrs.href = new URL(href, location.href).pathname;
    } catch {
      // Not a URL.
    }
  }
  const isField = /^(input|textarea|select)$/i.test(el.tagName);
  const dialog = closestDeep(el, 'dialog,[role=dialog],[role=alertdialog],[aria-modal=true]');
  return {
    // A blank frame has no address of its own to go by.
    ...(window !== window.top ? { frame: location.protocol === 'about:' ? location.href : location.origin + location.pathname } : {}),
    tag: el.tagName.toLowerCase(),
    role: role(el),
    name: accessibleName(el) || undefined,
    text: isField ? undefined : clean(seenText(el)) || undefined,
    attrs,
    css: cssPath(el),
    near: nearestHeading(el) || undefined,
    modal: dialog ? clean(accessibleName(dialog) || dialog.querySelector('h1,h2,h3,[role=heading]')?.textContent || '', 60) || 'dialog' : undefined,
  };
}

export function fingerprint(): PageFingerprint {
  const landmarks: string[] = [];
  for (const el of deepAll('h1,h2,h3,[role=heading],label,legend,nav[aria-label],main[aria-label]')) {
    if (!visible(el)) continue;
    const t = clean(el.getAttribute('aria-label') || seenText(el), 60);
    if (t && !landmarks.includes(t)) landmarks.push(t);
    if (landmarks.length >= 40) break;
  }
  return { url: location.href, title: unmark(document.title), landmarks };
}

// ---------- refs: stable per page load ----------

const refs = new Map<string, WeakRef<Element>>();
const ids = new WeakMap<Element, string>();
let next = 1;

export function refOf(el: Element): string {
  let r = ids.get(el);
  if (!r) {
    r = `ref_${next++}`;
    ids.set(el, r);
    refs.set(r, new WeakRef(el));
  }
  return r;
}

export function byRef(ref: string): Element {
  const el = refs.get(ref)?.deref();
  if (!el || !el.isConnected) throw new Error(`${ref} is gone from the page. Call read_page again.`);
  return el;
}

export function interactive(): Element[] {
  return deepAll(INTERACTIVE).filter(visible);
}

// A page can make anything clickable without saying so. Past this many elements only a click handler in the markup counts.
const MANY = 8000;
const hand = (el: Element) => getComputedStyle(el).cursor === 'pointer';

/** A click handler, or a hand cursor it does not get from what it sits in. Not a control, not a wrapper around controls, and with a name to go by. */
function isPlainClickable(el: Element) {
  if (el === document.body || el === document.documentElement || closestDeep(el, INTERACTIVE)) return false;
  const around = up(el);
  if (!el.hasAttribute('onclick') && (!hand(el) || (around && hand(around)))) return false;
  if ((el instanceof HTMLLabelElement && el.control) || el.querySelector(INTERACTIVE) || rootOf(el)?.querySelector(INTERACTIVE)) return false;
  const r = el.getBoundingClientRect();
  return r.width * r.height <= (innerWidth * innerHeight) / 2 && visible(el) && !!accessibleName(el);
}

export function plainClickables(): Element[] {
  const all = deepAll('*');
  return (all.length > MANY ? deepAll('[onclick]') : all).filter(isPlainClickable);
}

/** The plain clickable something is a part of. */
export function plainRoot(top: Element): Element | null {
  for (let e: Element | null = top; e; e = up(e)) if (isPlainClickable(e)) return e;
  return null;
}

const NOT_TEXT = 'script,style,noscript,template,head,title,meta,link';
const SEARCHED = ['aria-label', 'placeholder', 'title', 'alt', 'data-testid', 'name'];

function ownText(el: Element) {
  let out = '';
  for (const n of Array.from(el.childNodes)) if (n.nodeType === Node.TEXT_NODE) out += n.textContent ?? '';
  return clean(out, 300);
}

/** Everything drawn that says this, controls first and the closest wording first. Text a person cannot see does not count. */
export function findOnPage(query: string, max = 20): { lines: string[]; total: number } {
  const want = clean(query, 200).toLowerCase();
  const words = want.split(' ').filter(Boolean);
  if (!words.length) throw new Error('Say what to look for.');
  const rank = (said: string) => {
    const h = said.toLowerCase();
    if (!h) return -1;
    return h === want ? 0 : h.startsWith(want) ? 1 : h.includes(want) ? 2 : words.every((w) => h.includes(w)) ? 3 : -1;
  };
  const best = new Map<Element, number>();
  for (const el of deepAll('*')) {
    if (el.matches(NOT_TEXT) || el === document.documentElement) continue;
    const scores = [ownText(el), ...SEARCHED.map((a) => el.getAttribute(a) ?? '')].map(rank).filter((n) => n >= 0);
    if (!scores.length) continue;
    const control = closestDeep(el, INTERACTIVE) ?? plainRoot(el);
    const target = control && visible(control) ? control : el;
    if (!visible(target) || (hiddenWhy(target) && !drawnByLabel(target))) continue;
    const score = Math.min(...scores) - (control ? 0.5 : 0);
    if (score < (best.get(target) ?? Infinity)) best.set(target, score);
  }
  const hits = [...best.entries()].sort((a, b) => a[1] - b[1]).map(([el]) => el);
  return {
    total: hits.length,
    lines: hits.slice(0, max).map((el) => {
      const isControl = el.matches(INTERACTIVE);
      const kind = isControl ? role(el) : plainRoot(el) === el ? 'clickable' : 'text';
      return `${refOf(el)} ${kind} \u201c${accessibleName(el) || clean(seenText(el))}\u201d`;
    }),
  };
}

function* textNodes(root: Node): Generator<Text> {
  for (const n of Array.from(root.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) yield n as Text;
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const s = rootOf(n as Element);
      if (s) yield* textNodes(s);
      yield* textNodes(n);
    }
  }
}

/** The words of the page as a person reads them, from its main part when it has one. */
export function pageText(max = 50_000): { text: string; notes: OutlineNotes } {
  const notes: OutlineNotes = { omitted: {}, longValues: 0 };
  const main = document.querySelector('main,[role=main],article') as HTMLElement | null;
  const root = main && (main.innerText ?? '').trim().length > 200 ? main : document.body;
  const parts: string[] = [];
  let size = 0;
  let block: Element | null = null;
  for (const n of textNodes(root)) {
    if (size >= max) break;
    const at = n.parentElement;
    const raw = n.textContent ?? '';
    // No boxes: not drawn, like the children of a shadow host with no slot for them.
    if (!at || !raw.trim() || at.closest(NOT_TEXT) || !at.getClientRects().length) continue;
    const why = hiddenWhy(at);
    if (why) {
      if (why !== 'not shown') notes.omitted[why] = (notes.omitted[why] ?? 0) + 1;
      continue;
    }
    let inBlock: Element = at;
    while (inBlock !== root && inBlock.parentElement && getComputedStyle(inBlock).display.startsWith('inline')) inBlock = inBlock.parentElement;
    const piece = carry(raw, clean(raw, 5000));
    parts.push(inBlock === block ? ' ' : '\n', piece);
    block = inBlock;
    size += piece.length + 1;
  }
  const body = parts.join('').trim();
  return { text: `${clean(unmark(document.title), 200)}\n${location.href}\n\n${body.length > max ? `${body.slice(0, max)}\n\u2026 cut; the page goes on.` : body}`, notes };
}

export interface OutlineNotes {
  /** Elements with text left out because a person would not see it, by why. */
  omitted: Record<string, number>;
  /** Attribute values longer than anyone writes for a label. */
  longValues: number;
  /** Why the page is probably not finished drawing, if it is not. */
  busy?: string;
}

// When the page last changed, so a read can say the page is still settling. The overlay and the title mark are ours.
let changedAt = Date.now();
export function watchChanges() {
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.target.parentElement?.tagName === 'TITLE' || (r.target as Element).tagName === 'TITLE') continue;
      const ours = [...r.addedNodes, ...r.removedNodes].every((n) => (n as Element).id === 'agentic-routines-overlay');
      if (r.type === 'childList' && r.addedNodes.length + r.removedNodes.length > 0 && ours) continue;
      changedAt = Date.now();
      return;
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

/** The account a page says it is signed in with: the label of an account button ("Google Account: Name (a@b.com)"), else the authuser in the address. */
export function signedInAs(): string | undefined {
  const label = Array.from(document.querySelectorAll('[aria-label],[title]'))
    .map((el) => el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '')
    .find((t) => /account|profile|signed in/i.test(t) && /[\w.+-]+@[\w-]+\.[\w.-]+/.test(t));
  const email = label?.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const user = new URLSearchParams(location.search).get('authuser');
  if (email) return user ? `${email} (authuser=${user})` : email;
  return user ? `Google account number ${user} (authuser=${user})` : undefined;
}

/** Why the page is probably still loading: the document, a busy marker, a spinner, or changes in the last half second. */
export function busyWhy(): string | undefined {
  if (document.readyState !== 'complete') return 'the document is still loading';
  if (document.querySelector('[aria-busy="true"]')) return 'part of the page is marked busy';
  const spinner = Array.from(document.querySelectorAll('[role="progressbar"]')).find(visible);
  if (spinner) return 'a progress indicator is showing';
  const ago = Date.now() - changedAt;
  if (ago < 500) return `the page changed ${ago} ms ago`;
  return undefined;
}

const LONG_VALUE = 200;

/** Unicode tag characters spell text no screen shows. The cleaned text loses them, so they are handed on for the server to call out. */
const carry = (raw: string | null | undefined, cleaned: string) => {
  const { hidden } = stripInvisible(raw ?? '');
  return hidden ? cleaned + [...hidden.slice(0, 200)].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('') : cleaned;
};

/** Outline for the agent: headings and interactive elements with refs. Text a person would not see is left out. */
export function outline(filter: 'interactive' | 'all' = 'interactive', max = 400): { text: string; notes: OutlineNotes } {
  const lines = [clean(unmark(document.title), 200), location.href, ''];
  const notes: OutlineNotes = { omitted: {}, longValues: 0 };
  const want = filter === 'all' ? `${INTERACTIVE},${HEADINGS},p,li,td,th,[role=alert],[role=status],dialog` : `${INTERACTIVE},${HEADINGS},[role=alert],dialog`;
  const seen = new Set<Element>();
  const omit = (why: string) => (notes.omitted[why] = (notes.omitted[why] ?? 0) + 1);
  const plain = new Set(plainClickables());
  const wanted = plain.size ? deepAll('*').filter((el) => plain.has(el) || el.matches(want)) : deepAll(want);
  for (const el of wanted) {
    if (lines.length > max) {
      lines.push('… more on the page; scroll or narrow down.');
      break;
    }
    if (seen.has(el)) continue;
    seen.add(el);
    const isFile = el instanceof HTMLInputElement && el.type === 'file';
    // A file input is kept even when it is not drawn: the button in front of it is what the page shows.
    if (!isFile) {
      if (!visible(el)) {
        const why = hiddenWhy(el);
        if (why && why !== 'not shown' && (el.textContent ?? '').trim()) omit(why);
        continue;
      }
      const why = hiddenWhy(el);
      if (why && !drawnByLabel(el)) {
        omit(why);
        continue;
      }
    }
    const r = role(el);
    // Marked aria-hidden for screen readers: a control that is drawn stays, text does not.
    const staticText = r === 'heading' || el.matches('legend,p,li,td,th,[role=alert],[role=status],dialog');
    if (staticText && ariaHidden(el)) {
      omit('aria-hidden');
      continue;
    }
    for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'value']) if ((el.getAttribute(a)?.length ?? 0) > LONG_VALUE) notes.longValues++;
    let name = accessibleName(el);
    if (isFile && !name) {
      // The label, else the button drawn in front of it, else the words around it.
      const before = el.previousElementSibling;
      name = clean(seenText(el.closest('label') ?? (before?.matches('button,label,[role=button],a') ? before : null) ?? el.parentElement ?? el), 60);
    }
    if (r === 'heading' || el.matches('legend')) {
      if (name) lines.push(`${'#'.repeat(Number(el.tagName[1]) || 2)} ${name}`);
      continue;
    }
    if (el.matches('p,li,td,th')) {
      if (el.querySelector(INTERACTIVE)) continue;
      const raw = seenText(el);
      const t = carry(raw, clean(raw, 160));
      if (t) lines.push(`  ${t}`);
      continue;
    }
    let extra = '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.type === 'password') extra = el.value ? ' (filled)' : '';
      else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) extra = el.checked ? ' checked' : '';
      else if (el.type === 'file') extra = `${(el as HTMLInputElement).multiple ? ' (file, multiple)' : ' (file)'}${el.getAttribute('accept') ? ` accepts ${clean(el.getAttribute('accept'), 40)}` : ''}`;
      else if (el.value) extra = ` value="${clean(el.value, 60)}"`;
    } else if (el instanceof HTMLSelectElement) {
      extra = ` value="${clean(el.selectedOptions[0]?.textContent, 60)}"`;
    } else if (el.getAttribute('aria-expanded')) {
      extra = el.getAttribute('aria-expanded') === 'true' ? ' expanded' : ' collapsed';
    }
    if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') extra += ' disabled';
    lines.push(`${refOf(el)} ${plain.has(el) ? 'clickable' : r} “${name}”${extra}`);
  }
  return { text: lines.join('\n'), notes };
}

// ---------- acting ----------

function nativeSet(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** A pointer step on its way to the page: the recorded part, and points in the page when an agent gave them. */
export interface How extends Pointer {
  at?: Point;
  toRef?: string;
  toAt?: Point;
}
export interface Point {
  x: number;
  y: number;
}

const held = (mods = '') => ({ ctrlKey: /ctrl/.test(mods), shiftKey: /shift/.test(mods), altKey: /alt/.test(mods), metaKey: /cmd/.test(mods) });
const BUTTONS = { left: 0, middle: 1, right: 2 };

// DOM events, for browsers without a DevTools session and for input that did not arrive.
export function click(el: Element, how: How = {}) {
  const p = aimAt(el, how);
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: BUTTONS[how.button ?? 'left'], ...held(how.mods) };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  if (how.button === 'right') return void el.dispatchEvent(new MouseEvent('contextmenu', opts));
  // No point was asked for: the element's own click is what a label or a link answers to.
  if (how.at || how.spot || how.mods) el.dispatchEvent(new MouseEvent('click', opts));
  else (el as HTMLElement).click();
  if (how.count === 2) el.dispatchEvent(new MouseEvent('dblclick', opts));
}

export function hover(el: Element, how: How = {}) {
  const p = aimAt(el, how);
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y };
  for (const t of ['pointerover', 'pointerenter', 'pointermove']) el.dispatchEvent(new PointerEvent(t, opts));
  for (const t of ['mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(t, opts));
}

export function drag(el: Element, how: How) {
  const from = aimAt(el, how);
  const to = how.toAt ?? whereOn(byRef(how.toRef!), how.to?.spot);
  const end = deepPoint(to.x, to.y) ?? el;
  const opts = (p: Point, buttons: number) => ({ bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons });
  el.dispatchEvent(new PointerEvent('pointerdown', opts(from, 1)));
  el.dispatchEvent(new MouseEvent('mousedown', opts(from, 1)));
  const data = new DataTransfer();
  if ((el as HTMLElement).draggable) el.dispatchEvent(new DragEvent('dragstart', { ...opts(from, 1), dataTransfer: data }));
  end.dispatchEvent(new PointerEvent('pointermove', opts(to, 1)));
  end.dispatchEvent(new MouseEvent('mousemove', opts(to, 1)));
  if ((el as HTMLElement).draggable) {
    for (const t of ['dragenter', 'dragover', 'drop']) end.dispatchEvent(new DragEvent(t, { ...opts(to, 0), dataTransfer: data }));
    el.dispatchEvent(new DragEvent('dragend', { ...opts(to, 0), dataTransfer: data }));
  }
  end.dispatchEvent(new PointerEvent('pointerup', opts(to, 0)));
  end.dispatchEvent(new MouseEvent('mouseup', opts(to, 0)));
}

/** What holds the scrolling at a point: the nearest thing that scrolls, else the page. */
function scroller(el: Element | null): Element {
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = up(e)) {
    const s = getComputedStyle(e);
    if (/auto|scroll|overlay/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth)) return e;
  }
  return document.scrollingElement ?? document.documentElement;
}

export function scrollPos(p: Point) {
  const s = scroller(deepPoint(p.x, p.y));
  const page = document.scrollingElement ?? document.documentElement;
  return { key: [s.scrollLeft, s.scrollTop, page.scrollLeft, page.scrollTop].join(), top: Math.round(s.scrollTop), height: s.scrollHeight - s.clientHeight };
}

export function scrollBy(p: Point, by: Point) {
  scroller(deepPoint(p.x, p.y)).scrollBy({ left: by.x, top: by.y, behavior: 'instant' as ScrollBehavior });
}

/** What a point in the page lands on: the control it is part of, else whatever is drawn there and where on it. */
export function pointAt(x: number, y: number): { ref: string; spot?: Spot; frame?: boolean } {
  const top = deepPoint(x, y);
  if (!top) throw new Error('That point is outside the page. Coordinates are pixels in your last screenshot.');
  // Another document is drawn there, which only it can say anything about.
  if (top.matches('iframe,frame')) return { ref: refOf(top), spot: spotOn(top, x, y), frame: true };
  const control = closestDeep(top, INTERACTIVE) ?? plainRoot(top);
  const el = control && visible(control) ? control : top;
  return { ref: refOf(el), ...(needsSpot(el, control) ? { spot: spotOn(el, x, y) } : {}) };
}

/** Anywhere on a button is the same click. On a slider, a canvas or something large it is not. */
function needsSpot(el: Element, control: Element | null) {
  const r = el.getBoundingClientRect();
  return el !== control || el.matches('input[type=range],[role=slider],canvas,svg') || r.width * r.height > 90_000;
}

/** How a person's click on this should be kept: what it is a part of, and where on it if that matters. */
export function clickedThing(top: Element, x: number, y: number): { el: Element; spot?: Spot } | undefined {
  const plain = plainRoot(top);
  if (plain) return { el: plain, ...(needsSpot(plain, plain) ? { spot: spotOn(plain, x, y) } : {}) };
  // Drawn to be clicked, with no name to go by: a canvas, a map, a nameless thing with a hand cursor.
  return closestDeep(top, 'canvas,svg') || hand(top) ? { el: top, spot: spotOn(top, x, y) } : undefined;
}

/** Where on an element a point is, as fractions of its box. */
export function spotOn(el: Element, x: number, y: number): Spot {
  const r = el.getBoundingClientRect();
  const part = (n: number, of: number) => (of ? Math.round(Math.min(1, Math.max(0, n / of)) * 1000) / 1000 : 0.5);
  return { x: part(x - r.x, r.width), y: part(y - r.y, r.height) };
}

/** Whether a click on `top` is a click on `el`: a span inside a button, a label over its hidden input, a wrapper drawn around it. */
function partOf(el: Element, top: Element | null) {
  if (!top) return false;
  if (top === el || containsDeep(el, top)) return true;
  if ((closestDeep(top, 'label') as HTMLLabelElement | null)?.control === el) return true;
  if (!containsDeep(top, el)) return false;
  // Everything sits inside something: only a wrapper about its own size counts, not the page around it.
  const [a, b] = [top.getBoundingClientRect(), el.getBoundingClientRect()];
  return a.width * a.height <= b.width * b.height * 4;
}

const point = (r: DOMRect, fx: number, fy: number) => ({ x: r.x + r.width * fx, y: r.y + r.height * fy });

const offScreen = (p: Point) => p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight;
const whatIs = (top: Element | null) => (top && top !== document.documentElement && top !== document.body ? accessibleName(top) || top.tagName.toLowerCase() : undefined);

/** A place on an element, where it is now, without moving the page. */
export function whereOn(el: Element, spot?: Spot): Point & { off: boolean } {
  const p = point(el.getBoundingClientRect(), spot?.x ?? 0.5, spot?.y ?? 0.5);
  return { ...p, off: offScreen(p) };
}

/** A place on an element, brought on screen. */
function aimAtSpot(el: Element, spot: Spot) {
  let p = whereOn(el, spot);
  if (p.off) {
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
    p = whereOn(el, spot);
  }
  // Larger than the window: the point itself goes to the middle.
  if (p.off) {
    window.scrollBy({ left: p.x - innerWidth / 2, top: p.y - innerHeight / 2, behavior: 'instant' as ScrollBehavior });
    p = whereOn(el, spot);
  }
  const top = deepPoint(p.x, p.y);
  return { x: p.x, y: p.y, hit: partOf(el, top), over: partOf(el, top) ? undefined : whatIs(top) };
}

/** Where a person would click this element, and whether that reaches it. Scrolls it into view first. */
export function aimAt(el: Element, how: How = {}): { x: number; y: number; hit: boolean; over?: string } {
  if (how.at) return { ...how.at, hit: true };
  if (how.spot) return aimAtSpot(el, how.spot);
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  const centre = point(r, 0.5, 0.5);
  if (r.width < 1 || r.height < 1) return { ...centre, hit: false };
  // The middle first; a badge or an icon can sit on that and leave the rest of it open.
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
    const p = point(r, fx, fy);
    if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) continue;
    if (partOf(el, deepPoint(p.x, p.y))) return { ...p, hit: true };
  }
  return { ...centre, hit: false, over: whatIs(deepPoint(centre.x, centre.y)) };
}

// Whether the input sent since the last watch reached the element. Only the browser can make an event that isTrusted.
let watching: { el: Element; landed: boolean; stop: () => void } | undefined;
export function watchLanding(el: Element, moving = false) {
  watching?.stop();
  const on = (e: Event) => {
    // A closed shadow root hides what was really hit from a listener out here, so it is looked up by the point.
    const at = deepPoint((e as MouseEvent).clientX, (e as MouseEvent).clientY) ?? e.composedPath()[0];
    if (e.isTrusted && watching && at instanceof Element && partOf(el, at)) watching.landed = true;
  };
  const kinds = moving ? ['pointermove', 'mousemove', 'mouseover'] : ['pointerdown', 'mousedown', 'click'];
  for (const t of kinds) window.addEventListener(t, on, true);
  watching = { el, landed: false, stop: () => { for (const t of kinds) window.removeEventListener(t, on, true); } };
}
export function landed() {
  const out = !!watching?.landed;
  if (out) {
    watching?.stop();
    watching = undefined;
  }
  return out;
}

/** Focus a field and select what is in it, ready for real keys. False if it takes no text. */
export function readyToType(el: Element, keep = false): boolean {
  (el as HTMLElement).scrollIntoView({ block: 'center' });
  (el as HTMLElement).focus?.();
  if (keep) return true;
  if (takesValue(el)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (homeOf(el).activeElement !== el) return false;
    el.select();
    return true;
  }
  if ((el as HTMLElement).isContentEditable) {
    getSelection()?.selectAllChildren(el);
    return true;
  }
  return false;
}

/** After real typing: the field took it, and the page hears it as finished. A field can reformat what it is given, so only nothing at all counts as not taking it. */
export function typedInto(el: Element, text: string): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (text && !el.value) return false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return !text || !!(el as HTMLElement).innerText?.trim();
}

export function type(el: Element, text: string) {
  (el as HTMLElement).scrollIntoView({ block: 'center' });
  (el as HTMLElement).focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    nativeSet(el, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if ((el as HTMLElement).isContentEditable) {
    const sel = getSelection();
    sel?.selectAllChildren(el);
    document.execCommand('insertText', false, text);
    return;
  }
  throw new Error('That element does not take text');
}

export function select(el: Element, value: string) {
  if (!(el instanceof HTMLSelectElement)) {
    click(el);
    return;
  }
  const opt = Array.from(el.options).find((o) => o.value === value || clean(o.textContent) === value) ?? Array.from(el.options).find((o) => clean(o.textContent).toLowerCase().includes(value.toLowerCase()));
  if (!opt) throw new Error(`No option “${value}”. Options: ${Array.from(el.options).map((o) => clean(o.textContent)).join(', ')}`);
  nativeSet(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Fields with no keys to press: a value goes in whole, in the form the browser wants it.
const VALUE_FORMS: Record<string, string> = { range: 'a number', date: 'YYYY-MM-DD', time: 'HH:MM', 'datetime-local': 'YYYY-MM-DDTHH:MM', month: 'YYYY-MM', week: 'YYYY-Www', color: '#rrggbb' };
const takesValue = (el: Element) => el instanceof HTMLInputElement && el.type in VALUE_FORMS;

/** Whether something that is ticked or not is ticked. Undefined for anything else. */
export function toggleOf(el: Element): boolean | undefined {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
  if (el.matches('[role=checkbox],[role=switch],[role=radio],[role=menuitemcheckbox],[role=menuitemradio]')) return el.getAttribute('aria-checked') === 'true';
  return undefined;
}

export type FieldState = { kind: 'toggle'; on: boolean; radio: boolean } | { kind: 'text' | 'value' | 'choice' | 'file' | 'other' };

export function fieldState(el: Element): FieldState {
  const on = toggleOf(el);
  if (on !== undefined) return { kind: 'toggle', on, radio: /radio/.test(el.getAttribute('role') ?? (el as HTMLInputElement).type ?? '') };
  if (takesValue(el)) return { kind: 'value' };
  if (el instanceof HTMLSelectElement) return { kind: 'choice' };
  const kind = fieldKind(el);
  return { kind: kind === 'file' ? 'file' : kind === 'other' ? 'other' : 'text' };
}

/** Whether a person's change to this field is a state to come back to, not typing to do again. */
export const isState = (el: Element) => takesValue(el);

/** Put a whole value in a field that has no keys to press, and say so if the field would not have it. */
export function setValue(el: Element, value: string) {
  if (el instanceof HTMLSelectElement) return select(el, value);
  if (!(el instanceof HTMLInputElement) || !takesValue(el)) throw new Error('That element does not take a value.');
  const form = VALUE_FORMS[el.type];
  (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.focus();
  nativeSet(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const same = el.type === 'range' ? Number(el.value) === Number(value) : el.value.toLowerCase() === value.toLowerCase();
  if (!same) throw new Error(`That field would not take \u201c${value}\u201d: it now says \u201c${el.value}\u201d${el.type === 'range' ? `, and goes from ${el.min || 0} to ${el.max || 100}` : ''}. It wants ${form}.`);
}

/** The file input a button, label or drop zone feeds, if there is one. It is often not drawn at all. */
export function fileInputFor(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === 'file') return el;
  const label = el.closest('label');
  if (label?.control instanceof HTMLInputElement && label.control.type === 'file') return label.control;
  for (const id of (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)) {
    const c = homeOf(el).getElementById(id);
    if (c instanceof HTMLInputElement && c.type === 'file') return c;
  }
  // A button drawn next to its input, the common way a custom picker is built.
  const next = el.nextElementSibling;
  if (next instanceof HTMLInputElement && next.type === 'file') return next;
  // An input in front of it counts unless the control before that input already feeds it.
  const prev = el.previousElementSibling;
  if (prev instanceof HTMLInputElement && prev.type === 'file' && !prev.previousElementSibling?.matches('button,label,[role=button]')) return prev;
  let a: Element | null = el;
  for (let i = 0; a && i < 6; i++, a = a.parentElement) {
    if (a === document.body || a === document.documentElement) break;
    // One input inside this container is the one it feeds; several would be a guess.
    const found = a.querySelectorAll('input[type=file]');
    if (found.length === 1) return found[0] as HTMLInputElement;
    if (found.length > 1) return null;
  }
  const all = deepAll('input[type=file]');
  return all.length === 1 ? (all[0] as HTMLInputElement) : null;
}

/** Put the files in the input the element feeds, or drop them on the element when it is a drop zone. Says which. */
export function attach(el: Element, files: File[]): 'input' | 'drop' {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const input = fileInputFor(el);
  if (input) {
    if (files.length > 1 && !input.multiple) throw new Error('That file input takes one file. Upload them one at a time.');
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'input';
  }
  for (const t of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
  return 'drop';
}

/** Keys, separated by spaces. Each is a name, or names joined by +: ctrl+a. */
export function press(keys: string) {
  for (const combo of keys.split(/\s+/).filter(Boolean)) {
    const parts = combo.split('+').filter(Boolean);
    const key = parts.pop() ?? combo;
    let el = (document.activeElement as HTMLElement) ?? document.body;
    for (let s = rootOf(el); s?.activeElement; s = rootOf(el)) el = s.activeElement as HTMLElement;
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, ...held(parts.join('+').toLowerCase().replace('control', 'ctrl').replace(/meta|command/, 'cmd')) };
    const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (down && key === 'Enter' && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
  }
}

export function fieldKind(el: Element): 'text' | 'password' | 'file' | 'select' | 'other' {
  if (el instanceof HTMLInputElement) {
    if (el.type === 'password') return 'password';
    if (el.type === 'file') return 'file';
    if (['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return 'other';
    return 'text';
  }
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return 'text';
  if (el instanceof HTMLSelectElement) return 'select';
  return 'other';
}

export function rectOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio };
}

// ---------- what a hook may look at ----------

const SENSITIVE_NAME = /pass|token|secret|otp|card|cvv|cvc|ssn|iban|pin\b|csrf|auth/i;

/** The value of a field, for a hook. Nothing for passwords, files, hidden fields and anything named like a secret. */
function safeValue(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (['password', 'file', 'hidden'].includes(el.type)) return undefined;
    if (SENSITIVE_NAME.test(`${el.name} ${el.id} ${el.autocomplete}`) || /^(cc-|one-time)/.test(el.autocomplete)) return undefined;
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'checked' : '';
    return el.value.slice(0, 200);
  }
  if (el instanceof HTMLTextAreaElement) return SENSITIVE_NAME.test(`${el.name} ${el.id}`) ? undefined : el.value.slice(0, 200);
  if (el instanceof HTMLSelectElement) return (el.selectedOptions[0]?.textContent ?? '').trim().slice(0, 200);
  return undefined;
}

const DROP = 'script,style,noscript,template,svg,canvas,video,audio,iframe,object,embed,link,meta,picture,img';

/** A copy of the page's markup a hook can read: no scripts or styles, no event handlers, short attribute values, current field values, nothing secret. */
function markup(root: Element, max: number): string {
  const copy = root.cloneNode(true) as Element;
  // Field values are properties, not attributes: copy them over while the two trees still line up.
  const from = root.querySelectorAll('input,textarea,select');
  const to = copy.querySelectorAll('input,textarea,select');
  from.forEach((el, i) => {
    const c = to[i];
    if (!c) return;
    c.removeAttribute('value');
    const v = safeValue(el);
    if (v !== undefined && !(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) c.setAttribute('value', v);
    else if (v !== undefined) c.textContent = v;
  });
  copy.querySelectorAll(DROP).forEach((n) => n.remove());
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((n) => n.parentNode?.removeChild(n));
  for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || a.name === 'style' || a.name === 'srcset') el.removeAttribute(a.name);
      else if (a.value.length > 120) el.setAttribute(a.name, a.value.slice(0, 120) + '…');
    }
  }
  const html = copy.outerHTML.replace(/\s+/g, ' ');
  return html.length > max ? html.slice(0, max) + ' …cut' : html;
}

export function snapshot(targetRef?: string) {
  const element = (el: Element) => {
    const r = el.getBoundingClientRect();
    return {
      ref: refOf(el),
      tag: el.tagName.toLowerCase(),
      role: role(el) || undefined,
      name: accessibleName(el).slice(0, 100) || undefined,
      value: safeValue(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      ...(el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ? { disabled: true } : {}),
    };
  };
  const outline = interactive().slice(0, 150).map(element);
  let target: (ReturnType<typeof element> & { html: string }) | undefined;
  if (targetRef) {
    try {
      const el = byRef(targetRef);
      target = { ...element(el), html: markup(el, 2000) };
    } catch {
      // Gone since it was found; the hook gets the page without it.
    }
  }
  return { title: unmark(document.title).slice(0, 200), html: markup(document.body, 30_000), outline, ...(target ? { target } : {}) };
}

/** Whether a hook may do this to this element. The reason when it may not. */
export function hookMay(el: Element, action: 'click' | 'type'): string | null {
  if (!visible(el)) return 'the element is not visible';
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return 'the element is disabled';
  if (action === 'type') {
    if (['password', 'file', 'other'].includes(fieldKind(el))) return 'a hook cannot type into a password field, a file input or anything that is not a text field';
    if (el instanceof HTMLInputElement && (el.type === 'hidden' || SENSITIVE_NAME.test(`${el.name} ${el.id} ${el.autocomplete}`))) return 'that field looks like it holds a secret';
    return null;
  }
  if (el instanceof HTMLInputElement && el.type === 'file') return 'a hook cannot open a file picker';
  if (isIrreversible({ action: 'click', target: describe(el) })) return 'it looks like it submits, publishes, pays or deletes, which only a step that pauses may do';
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (a) {
    const h = new URL(a.href, location.href).hostname.toLowerCase();
    const here = location.hostname.toLowerCase();
    if (h !== here && !h.endsWith('.' + here) && !here.endsWith('.' + h)) return `the link leaves ${here}`;
  }
  return null;
}
