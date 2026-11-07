import { resolve, type Locator, type RecordedEvent } from '@agentic-routines/core';
import { clearStale, lock } from '../lib/page/lock';
import { aim, glow, veil, type GlowMode } from '../lib/page/overlay';
import { accessibleName, aimAt, attach, busyWhy, landed, readyToType, signedInAs, typedInto, watchChanges, watchLanding, byRef, click, describe, fieldKind, fileInputFor, fingerprint, hookMay, interactive, outline, press, rectOf, refOf, role, select, snapshot, type, viewport } from '../lib/page/dom';

export type ContentMsg =
  | { t: 'ping' }
  | { t: 'read'; filter?: 'interactive' | 'all'; wait?: number }
  | { t: 'fingerprint' }
  | { t: 'text'; ref: string }
  | { t: 'account' }
  | { t: 'alternates' }
  | { t: 'viewport' }
  | { t: 'describe'; ref: string }
  | { t: 'rendering' }
  | { t: 'act'; ref?: string; action: string; value?: string; quick?: boolean }
  | { t: 'aim'; ref: string; action: string; quick?: boolean }
  | { t: 'landed' }
  | { t: 'ready'; ref: string; keep?: boolean; quick?: boolean }
  | { t: 'typed'; ref: string; value: string }
  | { t: 'hookmay'; ref: string; action: 'click' | 'type' }
  | { t: 'snapshot'; ref?: string }
  | { t: 'hookact'; ref: string; action: 'click' | 'type'; value?: string }
  | { t: 'attach'; ref: string; files: { name: string; type: string; b64: string }[] }
  | { t: 'markUpload'; ref: string }
  | { t: 'unmarkUpload' }
  | { t: 'resolve'; target: Locator }
  | { t: 'first'; target: Locator }
  | { t: 'glow'; mode: GlowMode | 'off'; ttl?: number }
  | { t: 'veil'; on: boolean }
  | { t: 'lock'; label: string | null; ttl?: number }
  | { t: 'record'; on: boolean };

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let recording = false;

function human(event: Omit<RecordedEvent, 'ts' | 'url' | 'page'>) {
  if (!recording) return;
  browser.runtime.sendMessage({ t: 'human', event: { ...event, ts: Date.now(), url: location.href, page: fingerprint(), view: viewport() } }).catch(() => {});
}

function onClick(e: MouseEvent) {
  const el = (e.target as Element)?.closest?.('a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch]');
  if (!el) return;
  // Typing into fields is recorded on change, not on the click into them.
  if (/^(input|textarea|select)$/i.test(el.tagName) && fieldKind(el) !== 'other') return;
  human({ action: 'click', target: describe(el) });
}

function onChange(e: Event) {
  const el = e.target as Element;
  const kind = fieldKind(el);
  const label = accessibleName(el);
  if (kind === 'password') return human({ action: 'type', target: describe(el), field: 'password', fieldLabel: label });
  if (kind === 'file') {
    const f = (el as HTMLInputElement).files?.[0];
    return human({ action: 'upload', target: describe(el), field: 'file', fieldLabel: label, value: f?.name });
  }
  if (kind === 'select') return human({ action: 'select', target: describe(el), field: 'select', fieldLabel: label, value: (el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() });
  if (kind === 'text') return human({ action: 'type', target: describe(el), field: 'text', fieldLabel: label, value: (el as HTMLInputElement).value ?? (el as HTMLElement).innerText });
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    watchChanges();
    clearStale();
    document.addEventListener('click', onClick, true);
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
            send({ ok: { loc: describe(el), rect: rectOf(el), field: fieldKind(el), label: accessibleName(el), page: fingerprint(), view: viewport() } });
            break;
          }
          case 'resolve': {
            const els = interactive();
            const res = resolve(msg.target, els.map((el) => ({ item: el, loc: describe(el) })));
            const cand = (r: { item: Element; score: number }) => ({ ref: refOf(r.item), role: describe(r.item).role, name: accessibleName(r.item), score: r.score, rect: rectOf(r.item) });
            if (res.kind === 'found') send({ ok: { kind: 'found', view: viewport(), disabled: res.item.hasAttribute('disabled') || res.item.getAttribute('aria-disabled') === 'true', ...cand({ item: res.item, score: res.score }) } });
            else send({ ok: { kind: res.kind, view: viewport(), candidates: res.ranked.map(cand) } });
            break;
          }
          case 'first': {
            // Same kind of element in the same place in the page, whichever row of a list it is.
            const shape = (l: Locator) => `${l.tag}|${l.role}|${(l.css ?? '').replace(/:nth-of-type\(\d+\)/g, '')}`;
            const want = shape(msg.target);
            const el = interactive().find((c) => shape(describe(c)) === want);
            if (el) send({ ok: { kind: 'found', view: viewport(), disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true', ref: refOf(el), role: role(el), name: accessibleName(el), score: 0, rect: rectOf(el) } });
            else send({ ok: { kind: 'missing', view: viewport(), candidates: [] } });
            break;
          }
          case 'act': {
            const el = msg.ref ? byRef(msg.ref) : document.body;
            // The cursor lands on the element first, so a person watching sees what is about to happen.
            void (async () => {
              try {
                if (msg.ref && msg.action !== 'read') await aim(el, msg.action, msg.quick);
                switch (msg.action) {
                  case 'click':
                    click(el);
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
            // The cursor lands on the element first, so a person watching sees what is about to happen.
            void aim(el, msg.action, msg.quick).finally(() => {
              const at = aimAt(el);
              if (at.hit) watchLanding(el);
              send({ ok: at });
            });
            break;
          }
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
            if (input) input.setAttribute('data-br-upload', '1');
            void aim(byRef(msg.ref), 'upload').finally(() => send({ ok: input ? { multiple: input.multiple, accept: input.accept } : false }));
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
            veil(msg.on);
            send({ ok: true });
            break;
          case 'lock':
            lock(msg.label, msg.ttl);
            send({ ok: true });
            break;
          case 'record':
            recording = msg.on;
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
