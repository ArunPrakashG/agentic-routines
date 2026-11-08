import { resolve, type Locator, type RecordedEvent, type Spot } from '@agentic-routines/core';
import { hideCard, showCard, type CardText } from '../lib/page/card';
import { challengeHere } from '../lib/page/challenge';
import { hiddenWhy } from '../lib/page/hidden';
import { clearStale, lock } from '../lib/page/lock';
import { aim, glow, veil, type GlowMode } from '../lib/page/overlay';
import { heldLength, maskField, accessibleName, aimAt, allShadowRoots, attach, busyWhy, clickedThing, closestDeep, deepAll, deepPoint, drag, fieldState, findOnPage, hover, isState, landed, pageText, plainClickables, pointAt, readyToType, scrollBy, scrollPos, setValue, signedInAs, spotOn, toggleOf, typedInto, visible, watchChanges, watchLanding, whereOn, byRef, click, describe, fieldKind, fileInputFor, fingerprint, hookMay, interactive, outline, press, rectOf, refOf, role, select, snapshot, type, viewport, type How, type Point } from '../lib/page/dom';

export type ContentMsg =
  | { t: 'ping' }
  | { t: 'read'; filter?: 'interactive' | 'all'; wait?: number }
  | { t: 'knock'; nonce: string }
  | { t: 'place'; nonce: string; show?: Point }
  | { t: 'find'; query: string }
  | { t: 'pagetext' }
  | { t: 'fieldstate'; ref: string }
  | { t: 'fingerprint' }
  | { t: 'text'; ref: string }
  | { t: 'account' }
  | { t: 'alternates' }
  | { t: 'viewport' }
  | { t: 'describe'; ref: string }
  | { t: 'rendering' }
  | { t: 'secretField'; ref: string; origin: string }
  | { t: 'heldLength'; ref: string }
  | { t: 'act'; ref?: string; action: string; value?: string; how?: How; quick?: boolean }
  | { t: 'aim'; ref: string; action: string; spot?: Spot; at?: Point; moving?: boolean; quick?: boolean }
  | { t: 'at'; x: number; y: number }
  | { t: 'where'; ref: string; spot?: Spot }
  | { t: 'scrollpos'; p: Point }
  | { t: 'scrollby'; p: Point; by: Point }
  | { t: 'landed' }
  | { t: 'ready'; ref: string; keep?: boolean; quick?: boolean }
  | { t: 'typed'; ref: string; value: string }
  | { t: 'hookmay'; ref: string; action: 'click' | 'type' }
  | { t: 'snapshot'; ref?: string }
  | { t: 'hookact'; ref: string; action: 'click' | 'type'; value?: string }
  | { t: 'attach'; ref: string; files: { name: string; type: string; b64: string }[] }
  | { t: 'markUpload'; ref: string }
  | { t: 'unmarkUpload' }
  | { t: 'resolve'; target: Locator; wide?: boolean }
  | { t: 'first'; target: Locator; index?: number }
  | { t: 'glow'; mode: GlowMode | 'off'; ttl?: number }
  | { t: 'veil'; on: boolean; hold?: boolean }
  | { t: 'lock'; label: string | null; ttl?: number }
  | { t: 'card'; show: CardText | null }
  | { t: 'challenge' }
  | { t: 'record'; on: boolean };

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let recording = false;

/** What a person really pressed. Out here an event from a shadow root says only its host. */
const hitBy = (e: MouseEvent) => deepPoint(e.clientX, e.clientY) ?? (e.composedPath()[0] as Element);

function human(event: Omit<RecordedEvent, 'ts' | 'url' | 'page'>) {
  if (!recording) return;
  browser.runtime.sendMessage({ t: 'human', event: { ...event, ts: Date.now(), url: location.href, page: fingerprint(), view: viewport() } }).catch(() => {});
}

// A press that moved far enough on something made to be dragged is a drag, and the click that follows it is not a click.
const DRAG_PX = 12;
let pressed: { el: Element; x: number; y: number } | undefined;
let dragged = false;

function onPress(e: PointerEvent) {
  dragged = false;
  listenInShadows();
  if (recording && e.target instanceof Element) pressed = { el: hitBy(e), x: e.clientX, y: e.clientY };
}

function onLetGo(e: MouseEvent) {
  const p = pressed;
  pressed = undefined;
  if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
  const made = closestDeep(p.el, 'canvas,svg,[draggable=true],[role=slider]') || /grab|move/.test(getComputedStyle(p.el).cursor);
  if (!made) return;
  const end = deepPoint(e.clientX, e.clientY) ?? document.body;
  dragged = true;
  human({ action: 'drag', target: describe(p.el), pointer: { spot: spotOn(p.el, p.x, p.y), to: { target: describe(end), spot: spotOn(end, e.clientX, e.clientY) } } });
}

function onClick(e: MouseEvent) {
  if (dragged) {
    dragged = false;
    return;
  }
  const top = hitBy(e);
  const el = top && closestDeep(top, 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch]');
  if (!el) {
    const thing = top instanceof Element && recording ? clickedThing(top, e.clientX, e.clientY) : undefined;
    if (thing) human({ action: 'click', target: describe(thing.el), ...(thing.spot ? { pointer: { spot: thing.spot } } : {}) });
    return;
  }
  // Typing into fields is recorded on change, not on the click into them. A tick is recorded as what it came to.
  if (/^(input|textarea|select)$/i.test(el.tagName) && (fieldKind(el) !== 'other' || toggleOf(el) !== undefined)) return;
  if (toggleOf(el) !== undefined) {
    const target = describe(el);
    // The page answers the click first.
    setTimeout(() => human({ action: 'set', target, value: String(toggleOf(el)), fieldLabel: accessibleName(el) }), 50);
    return;
  }
  human({ action: 'click', target: describe(el) });
}

function onContextMenu(e: MouseEvent) {
  if (!recording || !(e.target instanceof Element)) return;
  const at = hitBy(e);
  human({ action: 'click', target: describe(at), pointer: { button: 'right', spot: spotOn(at, e.clientX, e.clientY) } });
}

// A change does not leave a shadow root, so whoever wants to hear it has to be in there.
const listening = new WeakSet<ShadowRoot>();
function listenInShadows() {
  if (!recording) return;
  for (const r of allShadowRoots()) {
    if (listening.has(r)) continue;
    listening.add(r);
    r.addEventListener('change', onChange, true);
  }
}

function onChange(e: Event) {
  const el = e.composedPath()[0] as Element;
  const kind = fieldKind(el);
  const label = accessibleName(el);
  if (toggleOf(el) !== undefined) return human({ action: 'set', target: describe(el), fieldLabel: label, value: String(toggleOf(el)) });
  if (isState(el)) return human({ action: 'set', target: describe(el), fieldLabel: label, value: (el as HTMLInputElement).value });
  if (kind === 'password') return human({ action: 'type', target: describe(el), field: 'password', fieldLabel: label });
  if (kind === 'file') {
    const f = (el as HTMLInputElement).files?.[0];
    return human({ action: 'upload', target: describe(el), field: 'file', fieldLabel: label, value: f?.name });
  }
  if (kind === 'select') return human({ action: 'select', target: describe(el), field: 'select', fieldLabel: label, value: (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() });
  if (kind === 'text') return human({ action: 'type', target: describe(el), field: 'text', fieldLabel: label, value: (el as HTMLInputElement).value ?? (el as HTMLElement).innerText });
}

/** Elements at the recorded path, and of a tag that is rare enough to look through. */
function ownKind(target: Locator): Element[] {
  const out = new Set<Element>();
  try {
    for (const el of deepAll(target.css)) out.add(el);
  } catch {
    // Not a selector this page can use.
  }
  const same = deepAll(target.tag);
  if (same.length <= 50) for (const el of same) out.add(el);
  return [...out].filter((el) => el.tagName.toLowerCase() === target.tag && visible(el));
}

// Frames that have said hello, by what they said. The page sees the message too, but it cannot make it come from another frame.
const knocked = new Map<string, Element>();
const KNOCK = '__agenticRoutinesKnock';

function onKnock(e: MessageEvent) {
  const nonce = e.data?.[KNOCK];
  if (typeof nonce !== 'string' || !e.source || knocked.has(nonce)) return;
  const frame = deepAll('iframe,frame').find((f) => (f as HTMLIFrameElement).contentWindow === e.source);
  if (frame) knocked.set(nonce, frame);
}

/** Where a frame that said hello sits in this document, and what a person sees of it. Brings a point in it on screen when asked. */
function placeOfFrame(nonce: string, show?: Point) {
  const f = knocked.get(nonce) as HTMLIFrameElement | undefined;
  if (!f) return null;
  knocked.delete(nonce);
  const box = () => {
    const r = f.getBoundingClientRect();
    return { r, sx: f.offsetWidth ? r.width / f.offsetWidth : 1, sy: f.offsetHeight ? r.height / f.offsetHeight : 1 };
  };
  let { r, sx, sy } = box();
  const shown = visible(f) && !hiddenWhy(f) && r.width >= 2 && r.height >= 2;
  let over: string | undefined;
  if (show && shown) {
    const at = () => ({ x: r.x + (f.clientLeft + show.x) * sx, y: r.y + (f.clientTop + show.y) * sy });
    let p = at();
    if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) {
      window.scrollBy({ left: p.x - innerWidth / 2, top: p.y - innerHeight / 2, behavior: 'instant' as ScrollBehavior });
      ({ r, sx, sy } = box());
      p = at();
    }
    const top = deepPoint(p.x, p.y);
    if (top !== f) over = top ? accessibleName(top) || top.tagName.toLowerCase() : undefined;
  }
  return { x: r.x + f.clientLeft * sx, y: r.y + f.clientTop * sy, w: f.clientWidth, h: f.clientHeight, sx, sy, shown, over };
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  matchAboutBlank: true,
  main() {
    watchChanges();
    if (window === window.top) clearStale();
    // A frame that loads while a person is recording has missed being told.
    browser.runtime.sendMessage({ t: 'recording?' }).then((on) => { if (on) recording = true; }).catch(() => {});
    window.addEventListener('message', onKnock, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('pointerdown', onPress, true);
    document.addEventListener('pointerup', onLetGo, true);
    document.addEventListener('dragend', onLetGo, true);
    document.addEventListener('change', onChange, true);

    browser.runtime.onMessage.addListener((msg: ContentMsg, _sender, send) => {
      try {
        switch (msg.t) {
          case 'ping':
            send(true);
            break;
          case 'rendering':
            requestAnimationFrame(() => send({ ok: true }));
            setTimeout(() => send({ ok: false }), 150);
            break;
          case 'read':
            void (async () => {
              // A page that is still drawing itself: wait for it to go quiet when asked, and say so when it has not.
              const end = Date.now() + Math.min(msg.wait ?? 0, 10_000);
              while (msg.wait && Date.now() < end && busyWhy()) await new Promise((r) => setTimeout(r, 200));
              const out = outline(msg.filter);
              const busy = busyWhy();
              if (busy) out.notes.busy = busy;
              send({ ok: out });
            })();
            break;
          case 'knock':
            window.parent.postMessage({ [KNOCK]: msg.nonce }, '*');
            send({ ok: true });
            break;
          case 'place':
            send({ ok: placeOfFrame(msg.nonce, msg.show) });
            break;
          case 'find':
            send({ ok: findOnPage(msg.query) });
            break;
          case 'pagetext':
            send({ ok: pageText() });
            break;
          case 'fieldstate':
            send({ ok: fieldState(byRef(msg.ref)) });
            break;
          case 'viewport':
            send({ ok: viewport() });
            break;
          case 'alternates':
            // <link rel="alternate" type="text/markdown">, resolved against the page.
            send({ ok: Array.from(document.querySelectorAll('link[rel~="alternate"][type="text/markdown"][href]')).slice(0, 5).map((l) => (l as HTMLLinkElement).href) });
            break;
          case 'text': {
            const el = byRef(msg.ref);
            const value = (el as HTMLInputElement).value;
            send({ ok: (typeof value === 'string' && value ? value : (el as HTMLElement).innerText || el.textContent || '').slice(0, 20_000) });
            break;
          }
          case 'account':
            send({ ok: signedInAs() });
            break;
          case 'fingerprint':
            send({ ok: fingerprint() });
            break;
          case 'describe': {
            const el = byRef(msg.ref);
            send({ ok: { loc: describe(el), rect: rectOf(el), field: fieldKind(el), state: toggleOf(el), label: accessibleName(el), page: fingerprint(), view: viewport() } });
            break;
          }
          case 'resolve': {
            // A place on something with no name, like a canvas, is looked for among its own kind as well as the controls.
            // So is something with no role at all: it was recorded because a page made it clickable, or found by its words.
            const plain = msg.target.role === 'generic';
            const own = msg.wide || plain ? ownKind(msg.target) : [];
            const els = [...new Set([...interactive(), ...own, ...(plain ? plainClickables() : [])])];
            let res = resolve(msg.target, els.map((el) => ({ item: el, loc: describe(el) })));
            if (res.kind !== 'found' && own.length === 1 && !msg.target.name) res = { kind: 'found', item: own[0], score: 0 };
            const cand = (r: { item: Element; score: number }) => ({ ref: refOf(r.item), role: describe(r.item).role, name: accessibleName(r.item), score: r.score, rect: rectOf(r.item) });
            if (res.kind === 'found') send({ ok: { kind: 'found', view: viewport(), disabled: res.item.hasAttribute('disabled') || res.item.getAttribute('aria-disabled') === 'true', ...cand({ item: res.item, score: res.score }) } });
            else send({ ok: { kind: res.kind, view: viewport(), candidates: res.ranked.map(cand) } });
            break;
          }
          case 'first': {
            // Same kind of element in the same place in the page, whichever row of a list it is. Inside a row that repeats,
            // its own place in the row stays, so the second button of each row is not the first of the next.
            // Whether it sits in such a row is read from the recorded one: the last row left has no place among rows.
            const recorded = (msg.target.css ?? '').split('>');
            const inRow = recorded.length > 1 && /:nth-of-type/.test(recorded[recorded.length - 2]);
            const shape = (l: Locator) => {
              const parts = (l.css ?? '').split('>');
              const own = inRow ? parts.pop()! : undefined;
              return `${l.tag}|${l.role}|${[...parts.map((x) => x.replace(/:nth-of-type\(\d+\)/, '')), ...(own ? [own] : [])].join('>')}`;
            };
            const want = shape(msg.target);
            const like = interactive().filter((c) => shape(describe(c)) === want);
            const el = like[msg.index ?? 0];
            if (el) send({ ok: { kind: 'found', count: like.length, view: viewport(), disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true', ref: refOf(el), role: role(el), name: accessibleName(el), score: 0, rect: rectOf(el) } });
            else send({ ok: { kind: 'missing', count: like.length, view: viewport(), candidates: [] } });
            break;
          }
          case 'secretField': {
            // The last check before a stored value goes in: which site this document really is on.
            if (location.origin !== msg.origin) throw new Error(`This field is on ${location.origin}, not ${msg.origin}, so the secret was not used.`);
            maskField(byRef(msg.ref));
            send({ ok: true });
            break;
          }
          case 'heldLength': {
            send({ ok: heldLength(byRef(msg.ref)) });
            break;
          }
          case 'act': {
            const el = msg.ref ? byRef(msg.ref) : document.body;
            // The cursor lands on the element first, so a person watching sees what is about to happen.
            void (async () => {
              try {
                if (msg.ref && msg.action !== 'read') await aim(el, msg.action, msg.quick, msg.how?.at ?? (msg.how?.spot && aimAt(el, msg.how)));
                switch (msg.action) {
                  case 'click':
                    click(el, msg.how);
                    break;
                  case 'hover':
                    hover(el, msg.how);
                    break;
                  case 'drag':
                    drag(el, msg.how!);
                    break;
                  case 'type':
                    type(el, msg.value ?? '');
                    break;
                  case 'clear':
                    type(el, '');
                    break;
                  case 'select':
                    select(el, msg.value ?? '');
                    break;
                  case 'set':
                    setValue(el, msg.value ?? '');
                    break;
                  case 'press':
                    press(msg.value ?? 'Enter');
                    break;
                  case 'read':
                    send({ ok: ((el as HTMLElement).innerText ?? '').trim().slice(0, 2000) });
                    return;
                }
                send({ ok: true });
              } catch (e) {
                send({ err: (e as Error).message });
              }
            })();
            break;
          }
          case 'aim': {
            const el = byRef(msg.ref);
            const how = { spot: msg.spot, at: msg.at };
            // The cursor lands on the element first, so a person watching sees what is about to happen.
            void aim(el, msg.action, msg.quick, msg.at ?? (msg.spot && aimAt(el, how))).finally(() => {
              const at = aimAt(el, how);
              if (at.hit) watchLanding(el, msg.moving);
              send({ ok: at });
            });
            break;
          }
          case 'at':
            send({ ok: pointAt(msg.x, msg.y) });
            break;
          case 'where':
            send({ ok: whereOn(byRef(msg.ref), msg.spot) });
            break;
          case 'scrollpos':
            send({ ok: scrollPos(msg.p) });
            break;
          case 'scrollby':
            scrollBy(msg.p, msg.by);
            send({ ok: true });
            break;
          case 'landed':
            send({ ok: landed() });
            break;
          case 'ready': {
            const el = byRef(msg.ref);
            void aim(el, 'type', msg.quick).finally(() => send({ ok: readyToType(el, msg.keep) }));
            break;
          }
          case 'typed':
            send({ ok: typedInto(byRef(msg.ref), msg.value) });
            break;
          case 'snapshot':
            send({ ok: snapshot(msg.ref) });
            break;
          case 'hookmay': {
            // A hook points at an element by ref; whether it may touch it is decided here, in the page, not by the hook.
            const why = hookMay(byRef(msg.ref), msg.action);
            if (why) send({ err: `refused: ${why}` });
            else send({ ok: true });
            break;
          }
          case 'markUpload': {
            const input = fileInputFor(byRef(msg.ref));
            for (const old of Array.from(document.querySelectorAll('[data-br-upload]'))) old.removeAttribute('data-br-upload');
            // The browser reads the paths itself only for an input it can reach from the page. Others get the file through the host.
            const reachable = input && window === window.top && input.getRootNode() === document;
            if (reachable) input.setAttribute('data-br-upload', '1');
            void aim(byRef(msg.ref), 'upload').finally(() => send({ ok: reachable ? { multiple: input.multiple, accept: input.accept } : false }));
            break;
          }
          case 'unmarkUpload':
            for (const old of Array.from(document.querySelectorAll('[data-br-upload]'))) old.removeAttribute('data-br-upload');
            send({ ok: true });
            break;
          case 'attach': {
            const files = msg.files.map((f) => new File([b64ToBytes(f.b64)], f.name, { type: f.type }));
            void aim(byRef(msg.ref), 'upload').finally(() => {
              try {
                send({ ok: attach(byRef(msg.ref), files) });
              } catch (e) {
                send({ err: (e as Error).message });
              }
            });
            break;
          }
          case 'glow':
            glow(msg.mode, msg.ttl);
            send({ ok: true });
            break;
          case 'veil':
            veil(msg.on, msg.hold);
            send({ ok: true });
            break;
          case 'lock':
            lock(msg.label, msg.ttl);
            send({ ok: true });
            break;
          case 'card':
            if (msg.show) showCard(msg.show);
            else hideCard();
            send({ ok: true });
            break;
          case 'challenge':
            send({ ok: challengeHere() });
            break;
          case 'record':
            recording = msg.on;
            listenInShadows();
            send({ ok: true });
            break;
        }
      } catch (e) {
        send({ err: (e as Error).message });
      }
      return true;
    });
  },
});
