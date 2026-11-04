import { resolve, type Locator, type RecordedEvent } from '@browser-routines/core';
import { accessibleName, attach, byRef, click, describe, fieldKind, fileInputFor, fingerprint, interactive, outline, press, rectOf, refOf, select, type } from '../lib/dom';

export type ContentMsg =
  | { t: 'ping' }
  | { t: 'read'; filter?: 'interactive' | 'all' }
  | { t: 'fingerprint' }
  | { t: 'describe'; ref: string }
  | { t: 'act'; ref?: string; action: string; value?: string }
  | { t: 'attach'; ref: string; files: { name: string; type: string; b64: string }[] }
  | { t: 'markUpload'; ref: string }
  | { t: 'resolve'; target: Locator }
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
  browser.runtime.sendMessage({ t: 'human', event: { ...event, ts: Date.now(), url: location.href, page: fingerprint() } }).catch(() => {});
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
    document.addEventListener('click', onClick, true);
    document.addEventListener('change', onChange, true);

    browser.runtime.onMessage.addListener((msg: ContentMsg, _sender, send) => {
      try {
        switch (msg.t) {
          case 'ping':
            send(true);
            break;
          case 'read':
            send({ ok: outline(msg.filter) });
            break;
          case 'fingerprint':
            send({ ok: fingerprint() });
            break;
          case 'describe': {
            const el = byRef(msg.ref);
            send({ ok: { loc: describe(el), rect: rectOf(el), field: fieldKind(el), label: accessibleName(el), page: fingerprint() } });
            break;
          }
          case 'resolve': {
            const els = interactive();
            const res = resolve(msg.target, els.map((el) => ({ item: el, loc: describe(el) })));
            const cand = (r: { item: Element; score: number }) => ({ ref: refOf(r.item), role: describe(r.item).role, name: accessibleName(r.item), score: r.score, rect: rectOf(r.item) });
            if (res.kind === 'found') send({ ok: { kind: 'found', ...cand({ item: res.item, score: res.score }) } });
            else send({ ok: { kind: res.kind, candidates: res.ranked.map(cand) } });
            break;
          }
          case 'act': {
            const el = msg.ref ? byRef(msg.ref) : document.body;
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
            break;
          }
          case 'markUpload': {
            const input = fileInputFor(byRef(msg.ref));
            if (input) input.setAttribute('data-br-upload', '1');
            send({ ok: !!input });
            break;
          }
          case 'attach': {
            const files = msg.files.map((f) => new File([b64ToBytes(f.b64)], f.name, { type: f.type }));
            attach(byRef(msg.ref), files);
            send({ ok: true });
            break;
          }
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
