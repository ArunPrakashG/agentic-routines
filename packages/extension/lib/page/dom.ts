import { isIrreversible, stripInvisible, type Locator, type PageFingerprint, type Viewport } from '@agentic-routines/core';
import { unmark } from './mark';
import { ariaHidden, hiddenWhy } from './hidden';

// Runs in the page. Turns elements into locators and outlines, and back.

const INTERACTIVE =
  'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=option],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
const HEADINGS = 'h1,h2,h3,h4,h5,h6,[role=heading],legend';

// Characters nobody can see (zero-width, bidi overrides, tag characters) are taken out of every name and text, so a
// recorded name and a live one still match and an agent never reads what a person cannot.
const clean = (s: string | null | undefined, max = 80) => stripInvisible(s ?? '').text.replace(/\s+/g, ' ').trim().slice(0, max);

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
  return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
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
    const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
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
        .map((i) => document.getElementById(i))
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
  let a: Element | null = el.parentElement;
  for (let depth = 0; a && depth < 8; depth++, a = a.parentElement) {
    const hs = Array.from(a.querySelectorAll(HEADINGS)).filter((h) => h !== el && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (hs.length) return clean(seenText(hs[hs.length - 1]));
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
  const dialog = el.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]');
  return {
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
  for (const el of Array.from(document.querySelectorAll('h1,h2,h3,[role=heading],label,legend,nav[aria-label],main[aria-label]'))) {
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
  return Array.from(document.querySelectorAll(INTERACTIVE)).filter(visible);
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
  for (const el of Array.from(document.querySelectorAll(want))) {
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
      if (why) {
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
    lines.push(`${refOf(el)} ${r} “${name}”${extra}`);
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

export function click(el: Element) {
  (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  (el as HTMLElement).focus?.();
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  (el as HTMLElement).click();
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

/** The file input a button, label or drop zone feeds, if there is one. It is often not drawn at all. */
export function fileInputFor(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && el.type === 'file') return el;
  const label = el.closest('label');
  if (label?.control instanceof HTMLInputElement && label.control.type === 'file') return label.control;
  for (const id of (el.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)) {
    const c = document.getElementById(id);
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
  const all = document.querySelectorAll('input[type=file]');
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

export function press(key: string) {
  const el = (document.activeElement as HTMLElement) ?? document.body;
  const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true };
  const down = el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keypress', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  if (down && key === 'Enter' && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
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
