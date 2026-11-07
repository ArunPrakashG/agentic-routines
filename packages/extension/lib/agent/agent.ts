import type { Locator, PageFingerprint, Pointer, RecordedEvent, Spot, Viewport } from '@agentic-routines/core';
import { areaBase64, cropHash, markedPng, pngBase64, pngSize, regionBase64, type Frame, type Rect } from '../replay/crop';
import { MAX_MARKS, type Mark } from '../replay/annotate';
import type { How, Point } from '../page/dom';
import { answerDialog, dialogNote, dialogOn, listenBeforeLeaving, whenLeaving, type OpenDialog } from '../page/dialogs';
import { findInTab, landOn, readTab, textOfTab, toTab } from '../page/frames';
import { handOver, handedTo } from '../page/handoff';
import { perform } from '../page/input';
import { consoleOf, networkOf, runScript } from '../page/logs';
import * as llm from '../page/llm';
import * as native from './native';
import { platform } from '../platform';
import * as runs from './runs';
import { unmark } from '../page/mark';
import { adopt, agentTabId, ask, closeOwnTab, frameOf, glow, heldBy, isLent, isOwnTab, noteSession, openTab, settle, takeSpawned, waitLoaded } from '../page/tabs';

// The browser tools agents call. Each call is done and recorded.

interface Described {
  loc: Locator;
  rect: Rect;
  field: RecordedEvent['field'];
  /** Ticked or not, for what can be. */
  state?: boolean;
  label: string;
  page: PageFingerprint;
  view?: Viewport;
}

/** An element as the rest of this file wants it: where it is in the tab, on the page the tab is on, whichever document it is in. */
async function describeIn(tabId: number, ref: string): Promise<Described> {
  const d = await ask<Described>(tabId, { t: 'describe', ref });
  if (!frameOf(ref)) return d;
  const at = await toTab(tabId, ref, d.rect);
  return { ...d, rect: { ...d.rect, x: at.x, y: at.y }, page: await ask<PageFingerprint>(tabId, { t: 'fingerprint' }), view: await ask<Viewport>(tabId, { t: 'viewport' }) };
}

// The tab an agent is working in glows while it works, and for a few seconds after its last call.
const WORKING_MS = 6000;
async function working(session: string | undefined, requested?: number) {
  const tabId = await agentTabId(session, requested);
  await glow(tabId, 'run', WORKING_MS);
  // Attached from the first call, so the bar this puts up has already moved the page before anything is measured.
  await platform.cdp?.(tabId, async () => {}).catch(() => {});
  return tabId;
}

const AGENTS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'codex-mcp-client': 'Codex',
  codex: 'Codex',
  'Visual Studio Code': 'GitHub Copilot',
  'visual-studio-code': 'GitHub Copilot',
  opencode: 'OpenCode',
};
export const agentName = (raw?: string) => (raw ? (AGENTS[raw] ?? raw) : 'Agent');

const TYPES: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml',
  zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  apk: 'application/vnd.android.package-archive', aab: 'application/octet-stream',
};
const typeOf = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() ?? ''] ?? '';

/** Paths from a step or a tool: one per line. */
export const pathsOf = (value: string) => value.split('\n').map((p) => p.trim()).filter(Boolean);

const acceptsFile = (accept: string, name: string) =>
  !accept ||
  accept.split(',').some((a) => {
    const t = a.trim().toLowerCase();
    return t.startsWith('.') ? name.toLowerCase().endsWith(t) : t.endsWith('/*') ? typeOf(name).startsWith(t.slice(0, -1)) : typeOf(name) === t;
  });

/**
 * Put local files into a file input, or onto a drop zone. `value` is one path, or several with one per line.
 * The host checks each path first, so a missing, unreadable, forbidden or too large file is said clearly before anything moves.
 * With a DevTools session the browser reads the paths itself; without one the files stream through the host.
 */
export async function uploadFile(tabId: number, ref: string, value: string): Promise<{ names: string[]; warnings: string[] }> {
  const files = pathsOf(value);
  if (!files.length) throw new Error('No file path was given.');
  const infos = [];
  for (const path of files) infos.push(await native.call<{ name: string; size: number; tooBigToStream: boolean; label: string; limit: string }>('fs.info', { path }));
  const warnings: string[] = [];
  const mark = platform.cdp ? await ask<false | { multiple: boolean; accept: string }>(tabId, { t: 'markUpload', ref }) : false;
  if (mark) {
    try {
      if (files.length > 1 && !mark.multiple) throw new Error('That file input takes one file. Upload them one at a time, or pass the ref of an input that allows several.');
      for (const i of infos) if (!acceptsFile(mark.accept, i.name)) warnings.push(`${i.name} is not a kind the page accepts (${mark.accept}); the page may reject it`);
      await platform.cdp!(tabId, async (send) => {
        const { result } = await send<any>('Runtime.evaluate', { expression: 'document.querySelector("[data-br-upload]")' });
        await send('DOM.setFileInputFiles', { files, objectId: result.objectId });
        const n = await send<any>('Runtime.evaluate', { expression: 'document.querySelector("[data-br-upload]").files.length', returnByValue: true });
        if (n.result?.value !== files.length) throw new Error('The browser did not take the files. The page may have replaced the input; call read_page and try again.');
      });
    } finally {
      await ask(tabId, { t: 'unmarkUpload' }).catch(() => {});
    }
    return { names: infos.map((i) => i.name), warnings };
  }
  // No DevTools session, or a drop zone with no input behind it: the pieces go through the host.
  const big = infos.find((i) => i.tooBigToStream);
  const total = infos.reduce((n, i) => n + i.size, 0);
  if (big) throw new Error(`${big.name} is ${big.label}. This browser cannot send a file over ${big.limit}; use a Chromium browser, or a smaller file.`);
  if (total > 25 * 1024 * 1024) throw new Error(`Together the files are ${(total / 1048576).toFixed(0)} MB, over the 25 MB this browser can send at once. Upload them in smaller groups.`);
  const out: { name: string; type: string; b64: string }[] = [];
  for (const [i, path] of files.entries()) {
    const parts: string[] = [];
    let offset = 0;
    for (;;) {
      const c = await native.call<{ name: string; size: number; data: string }>('fs.readChunk', { path, offset });
      parts.push(c.data);
      offset += (c.data.length * 3) / 4 - (c.data.endsWith('==') ? 2 : c.data.endsWith('=') ? 1 : 0);
      if (offset >= c.size || !c.data) break;
    }
    // The pieces are a multiple of three bytes, so they join without re-encoding.
    out.push({ name: infos[i].name, type: typeOf(infos[i].name), b64: parts.join('') });
  }
  const how = await ask<'input' | 'drop'>(tabId, { t: 'attach', ref, files: out });
  if (how === 'drop') warnings.push('There was no file input behind that element, so the files were dropped on it; check the page took them');
  return { names: infos.map((i) => i.name), warnings };
}

/** A dialog as a step knows it: nothing on the page to find, only what it said. */
const dialogLocator = (d: OpenDialog): Locator => ({ tag: 'dialog', role: 'alertdialog', name: d.message.slice(0, 200), attrs: { type: d.type }, css: '' });

// The element a default screenshot centres on, for each session.
const lastActed = new Map<string, { tabId: number; ref: string }>();

// What the next screenshot of a tab draws: what was just touched, and anything the agent pointed at.
const marked = new Map<string, { tabId: number; url: string; marks: Mark[] }>();

function addMark(session: string | undefined, tabId: number, url: string, d: Described, note: string | undefined, arrow: boolean) {
  const key = session ?? 'user';
  let m = marked.get(key);
  if (!m || m.tabId !== tabId || m.url !== url) marked.set(key, (m = { tabId, url, marks: [] }));
  const label = note || d.label || d.loc.name || d.loc.tag;
  m.marks.push({ x: d.rect.x, y: d.rect.y, w: d.rect.w, h: d.rect.h, label, arrow });
  if (m.marks.length > MAX_MARKS) m.marks.shift();
}

function takeMarks(session: string | undefined, tabId: number, url: string): Mark[] {
  const key = session ?? 'user';
  const m = marked.get(key);
  marked.delete(key);
  return m && m.tabId === tabId && m.url === url ? m.marks : [];
}

// What the last screenshot showed. Coordinates are read off the picture, so they mean nothing once the page has moved.
const pictures = new Map<string, Frame & { tabId: number; url: string; moved?: boolean }>();

function keepPicture(session: string | undefined, tabId: number, url: string, frame: Frame, w: number, h: number) {
  pictures.set(session ?? 'user', { ...frame, tabId, url });
  return ` The picture is ${w}×${h}: x and y for click, hover, drag, scroll and region are pixels in it.`;
}

/** A point read off the last screenshot, as a point in the page. With no screenshot of this tab, they are page pixels already. */
async function pagePoint(session: string | undefined, tabId: number, x: number, y: number): Promise<Point> {
  const f = pictures.get(session ?? 'user');
  if (!f || f.tabId !== tabId) return { x, y };
  if (f.moved || f.url !== (await browser.tabs.get(tabId)).url) throw new Error('The page has moved since your last screenshot, so that point is out of date. Take another.');
  return { x: f.x + x * f.sx, y: f.y + y * f.sy };
}

/** Where a pointer tool is aimed: an element by ref, or a point read off the last screenshot. */
async function aimed(session: string | undefined, tabId: number, ref: string | undefined, x: number | undefined, y: number | undefined): Promise<{ ref: string; spot?: Spot; at?: Point }> {
  if (ref) return { ref };
  if (x === undefined || y === undefined) throw new Error('Pass a ref, or x and y from a screenshot.');
  return landOn(tabId, await pagePoint(session, tabId, x, y));
}

const pressedHow = (p: any): Pointer => ({ ...(p.button && p.button !== 'left' ? { button: p.button } : {}), ...(p.count > 1 ? { count: p.count } : {}), ...(p.modifiers ? { mods: p.modifiers } : {}) });

async function act(source: string, session: string | undefined, tabId: number, ref: string, action: RecordedEvent['action'], value?: string, extra: Partial<RecordedEvent> = {}, mk?: { on: boolean; note?: string }, how?: How) {
  const d = await describeIn(tabId, ref);
  const crop = d.field === 'password' ? undefined : await cropHash(tabId, d.rect);
  const before = (await browser.tabs.get(tabId)).url ?? '';
  if (mk?.on && d.field !== 'password') addMark(session, tabId, before, d, mk.note, false);
  let uploaded: Awaited<ReturnType<typeof uploadFile>> | undefined;
  let note: string | undefined;
  if (action === 'upload') uploaded = await uploadFile(tabId, ref, value!);
  else if (action === 'click' && d.field === 'file') throw new Error('That is a file input: clicking it opens the file picker, which nobody can answer. Call upload with this ref and the absolute path of the file instead.');
  else note = await perform(tabId, ref, action, value, how);
  const after = await settle(tabId, before);
  // A click on a tick is kept as what it came to, or a replay would untick what is already ticked.
  if (action === 'click' && d.state !== undefined && after === before && !how?.button && !how?.count) {
    const now = await ask<Described>(tabId, { t: 'describe', ref }).then((x) => x.state, () => undefined);
    if (now !== undefined) {
      action = 'set';
      value = String(now);
      const { pointer: _p, ...rest } = extra;
      extra = rest;
    }
  }
  // A new address can reuse refs for other elements.
  if (after === before) lastActed.set(session ?? 'user', { tabId, ref });
  else lastActed.delete(session ?? 'user');
  await runs.record(source, {
    action,
    url: before,
    ts: Date.now(),
    target: d.loc,
    field: d.field,
    fieldLabel: d.label,
    // A password the agent typed is never kept.
    value: d.field === 'password' ? undefined : value,
    page: d.page,
    crop,
    view: d.view,
    navigatedTo: after !== before ? after : undefined,
    ...extra,
  }, session);
  return { d, after, changed: after !== before, uploaded, note };
}

// Some of these clear by themselves in a few seconds, so that is waited for. Nothing here tries to get past one.
const CHALLENGE_CLEARS_MS = 8000;
export async function challengeOn(tabId: number): Promise<string | undefined> {
  const check = () => ask<string | undefined>(tabId, { t: 'challenge' }).catch(() => undefined);
  let kind = await check();
  const end = Date.now() + CHALLENGE_CLEARS_MS;
  while (kind && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 500));
    kind = await check();
  }
  return kind;
}

// The person says which sites may run an agent's scripts. Only the panel can say so, so it is handed in from there.
let mayRunScript: (site: string, code: string, by: string) => Promise<void> = async () => {
  throw new Error('Nothing here can ask the user yet.');
};
export const askAboutScripts = (fn: typeof mayRunScript) => void (mayRunScript = fn);

export async function handle(method: string, p: any): Promise<unknown> {
  const source = agentName(p?.agent);
  if (p?.session) noteSession(p.session, source);
  switch (method) {
    case 'browser.tabs': {
      const tabs = await browser.tabs.query({});
      return tabs
        .filter((t) => /^https?:/.test(t.url ?? ''))
        .map((t) => {
          const h = t.id !== undefined ? heldBy(t.id) : undefined;
          return { id: t.id, title: unmark(t.title ?? ''), url: t.url, active: t.active, ...(h ? { held_by: h.session === p?.session ? 'you' : h.label } : {}), ...(t.id !== undefined && isOwnTab(p?.session, t.id) ? { yours: true } : {}), ...(t.id !== undefined && isLent(t.id) ? { lent: true } : {}) };
        });
    }
    case 'browser.navigate': {
      let tabId: number;
      let asked: OpenDialog | undefined;
      let leftFrom = '';
      if (p.new_tab) {
        tabId = await openTab(p?.session, p.url);
      } else {
        tabId = await working(p?.session, p.tab_id);
        await listenBeforeLeaving(tabId);
        const from = (await browser.tabs.get(tabId)).url ?? p.url;
        await browser.tabs.update(tabId, { url: p.url });
        asked = await whenLeaving(tabId, !!p.force);
        if (asked) leftFrom = from;
      }
      await new Promise((r) => setTimeout(r, 200));
      await waitLoaded(tabId);
      await glow(tabId, 'run', WORKING_MS);
      const challenge = await challengeOn(tabId);
      const t = await browser.tabs.get(tabId);
      await runs.record(source, { action: 'navigate', url: t.url ?? p.url, ts: Date.now() }, p?.session);
      // In a replay the page asks again, after the step that leaves it.
      if (asked) await runs.record(source, { action: 'dialog', url: leftFrom, ts: Date.now(), target: dialogLocator(asked) }, p?.session);
      const account = await ask<string | undefined>(tabId, { t: 'account' }).catch(() => undefined);
      return { url: t.url, title: unmark(t.title ?? ''), tab_id: tabId, account, challenge };
    }
    case 'browser.read': {
      const tabId = await working(p?.session, p.tab_id);
      // Text and what was left out of it, so the MCP server can say so. The address lets the CLI point at a routine for this page.
      if (p.ref) return { text: await ask<string>(tabId, { t: 'text', ref: p.ref }), notes: { omitted: {}, longValues: 0 }, url: (await browser.tabs.get(tabId)).url };
      const out = await readTab(tabId, p.filter, p.wait);
      const account = await ask<string | undefined>(tabId, { t: 'account' }).catch(() => undefined);
      const challenge = await ask<string | undefined>(tabId, { t: 'challenge' }).catch(() => undefined);
      return { ...out, url: (await browser.tabs.get(tabId)).url, account, challenge };
    }
    case 'browser.llm': {
      const tabId = await working(p?.session, p.tab_id);
      const out = await llm.find(tabId, { scope: p.scope, full: p.full, maxBytes: p.max_bytes });
      return { ...out, page: (await browser.tabs.get(tabId)).url };
    }
    case 'browser.find': {
      const tabId = await working(p?.session, p.tab_id);
      return findInTab(tabId, p.query);
    }
    case 'browser.text': {
      const tabId = await working(p?.session, p.tab_id);
      return textOfTab(tabId);
    }
    case 'browser.form_input': {
      const tabId = await working(p?.session, p.tab_id);
      const { d, note } = await act(source, p?.session, tabId, p.ref, 'set', String(p.value), {}, { on: !!p.mark, note: p.note });
      return `Set “${d.label || d.loc.name || d.loc.tag}”${d.field === 'password' ? '' : ` to ${p.value}`}.${note ? ` ${note}` : ''}`;
    }
    case 'browser.click': {
      const tabId = await working(p?.session, p.tab_id);
      const { ref, spot, at } = await aimed(p?.session, tabId, p.ref, p.x, p.y);
      const pointer = { ...pressedHow(p), ...(spot ? { spot } : {}) };
      const { d, after, changed, note } = await act(source, p?.session, tabId, ref, 'click', undefined, Object.keys(pointer).length ? { pointer } : {}, { on: !!p.mark, note: p.note }, { ...pointer, at });
      const popped = takeSpawned(tabId);
      return `Clicked “${d.label || d.loc.name || d.loc.tag}”.${changed ? ` Now at ${after}` : ''}${note ? ` ${note}` : ''}${popped ? ` That opened a new tab, ${popped}: pass it as tab_id to work there.` : ''}${dialogNote(tabId)}`;
    }
    case 'browser.hover': {
      const tabId = await working(p?.session, p.tab_id);
      const { ref, spot, at } = await aimed(p?.session, tabId, p.ref, p.x, p.y);
      const { d, note } = await act(source, p?.session, tabId, ref, 'hover', undefined, spot ? { pointer: { spot } } : {}, undefined, { spot, at });
      return `Pointing at “${d.label || d.loc.name || d.loc.tag}”.${note ? ` ${note}` : ''}`;
    }
    case 'browser.drag': {
      const tabId = await working(p?.session, p.tab_id);
      const from = await aimed(p?.session, tabId, p.ref, p.x, p.y);
      const to = await aimed(p?.session, tabId, p.to_ref, p.to_x, p.to_y);
      const end = await describeIn(tabId, to.ref);
      const pointer: Pointer = { ...(from.spot ? { spot: from.spot } : {}), to: { target: end.loc, ...(to.spot ? { spot: to.spot } : {}) } };
      const { d, note } = await act(source, p?.session, tabId, from.ref, 'drag', undefined, { pointer }, undefined, { ...pointer, at: from.at, toRef: to.ref, toAt: to.at });
      return `Dragged “${d.label || d.loc.name || d.loc.tag}” to “${end.label || end.loc.name || end.loc.tag}”.${note ? ` ${note}` : ''}`;
    }
    case 'browser.scroll': {
      const tabId = await working(p?.session, p.tab_id);
      const f = pictures.get(p?.session ?? 'user');
      const aim = p.ref || p.x !== undefined ? await aimed(p?.session, tabId, p.ref, p.x, p.y) : undefined;
      const by: Point | undefined = p.direction ? { x: (p.direction === 'right' ? 1 : p.direction === 'left' ? -1 : 0) * (p.amount ?? 3) * 100, y: (p.direction === 'down' ? 1 : p.direction === 'up' ? -1 : 0) * (p.amount ?? 3) * 100 } : undefined;
      if (!by && !aim) throw new Error('Pass a direction, or the ref of an element to bring into view.');
      const pointer: Pointer = { ...(aim?.spot ? { spot: aim.spot } : {}), ...(by ? { by } : {}) };
      if (!aim) {
        const url = (await browser.tabs.get(tabId)).url ?? '';
        const note = await perform(tabId, undefined, 'scroll', undefined, pointer);
        await runs.record(source, { action: 'scroll', url, ts: Date.now(), pointer }, p?.session);
        if (f?.tabId === tabId) f.moved = true;
        return note;
      }
      const { note } = await act(source, p?.session, tabId, aim.ref, 'scroll', undefined, { pointer }, undefined, { ...pointer, at: aim.at });
      if (f?.tabId === tabId) f.moved = true;
      return note;
    }
    case 'browser.adopt': {
      const tabId = await adopt(p?.session, { tabId: p.tab_id, url: p.url });
      await glow(tabId, 'run', WORKING_MS);
      const t = await browser.tabs.get(tabId);
      return { tab_id: tabId, url: t.url, title: unmark(t.title ?? '') };
    }
    case 'browser.handoff': {
      // Asking again while the person still has it picks up the same hand-over.
      const again = p.tab_id ?? handedTo(p?.session);
      let tabId: number;
      if (again !== undefined && handedTo(p?.session) === again) tabId = again;
      else {
        tabId = await agentTabId(p?.session, p.tab_id);
        const url = (await browser.tabs.get(tabId)).url ?? '';
        await runs.record(source, { action: 'handoff', url, value: String(p.reason), ts: Date.now() }, p?.session);
      }
      await glow(tabId, 'paused', p.wait_seconds * 1000);
      const h = await handOver(tabId, { reason: String(p.reason), by: source, session: p?.session, waitMs: p.wait_seconds * 1000 });
      if (h.closed) return { ...h, tab_id: tabId };
      if (h.continued) await waitLoaded(tabId).catch(() => {});
      const t = await browser.tabs.get(tabId).catch(() => undefined);
      return { ...h, tab_id: tabId, url: t?.url, title: unmark(t?.title ?? '') };
    }
    case 'browser.wait': {
      await working(p?.session, p.tab_id);
      await new Promise((r) => setTimeout(r, p.seconds * 1000));
      return `Waited ${p.seconds} s.`;
    }
    case 'browser.type': {
      const tabId = await working(p?.session, p.tab_id);
      const { d } = await act(source, p?.session, tabId, p.ref, 'type', p.text, {}, { on: !!p.mark, note: p.note });
      if (p.submit) await act(source, p?.session, tabId, p.ref, 'press', 'Enter');
      return `Typed into “${d.label || d.loc.name || d.loc.tag}”.${dialogNote(tabId)}`;
    }
    case 'browser.select': {
      const tabId = await working(p?.session, p.tab_id);
      const { d } = await act(source, p?.session, tabId, p.ref, 'select', p.value, {}, { on: !!p.mark, note: p.note });
      return `Picked “${p.value}” in “${d.label}”.`;
    }
    case 'browser.upload': {
      const tabId = await working(p?.session, p.tab_id);
      const { d, uploaded } = await act(source, p?.session, tabId, p.ref, 'upload', p.path, { field: 'file' });
      const names = uploaded!.names;
      return `Attached ${names.length === 1 ? names[0] : `${names.length} files (${names.join(', ')})`} to “${d.label || d.loc.name}”.${uploaded!.warnings.length ? ` Note: ${uploaded!.warnings.join('. ')}.` : ''}`;
    }
    case 'browser.press': {
      const tabId = await working(p?.session, p.tab_id);
      const before = (await browser.tabs.get(tabId)).url ?? '';
      const keys = Array<string>(p.repeat ?? 1).fill(p.key).join(' ');
      await perform(tabId, undefined, 'press', keys);
      const after = await settle(tabId, before);
      await runs.record(source, { action: 'press', url: before, value: keys, ts: Date.now(), navigatedTo: after !== before ? after : undefined }, p?.session);
      return `Pressed ${p.key}${p.repeat > 1 ? ` ${p.repeat} times` : ''}.${dialogNote(tabId)}`;
    }
    case 'browser.dialog': {
      const tabId = await working(p?.session, p.tab_id);
      const open = dialogOn(tabId);
      if (!open) throw new Error('No dialog is open in this tab that the browser has said anything about.');
      const before = (await browser.tabs.get(tabId)).url ?? '';
      await answerDialog(tabId, p.accept, p.text);
      const after = await settle(tabId, before);
      await runs.record(source, { action: 'dialog', url: before, ts: Date.now(), target: dialogLocator(open), fieldLabel: open.type === 'prompt' ? 'dialog answer' : undefined, value: p.accept && open.type === 'prompt' ? (p.text ?? open.answer ?? '') : undefined, dismiss: p.accept ? undefined : true, navigatedTo: after !== before ? after : undefined }, p?.session);
      return `Answered ${p.accept ? 'yes' : 'no'} to the ${open.type} dialog that said: ${open.message}.${after !== before ? ` Now at ${after}` : ''}${dialogNote(tabId)}`;
    }
    case 'browser.javascript': {
      const tabId = await working(p?.session, p.tab_id);
      const { url } = await browser.tabs.get(tabId);
      if (!/^https?:/.test(url ?? '')) throw new Error('A script can only run on a website.');
      await mayRunScript(new URL(url!).host, p.code, source);
      return runScript(tabId, p.code);
    }
    case 'browser.console': {
      const tabId = await working(p?.session, p.tab_id);
      return consoleOf(tabId, p);
    }
    case 'browser.network': {
      const tabId = await working(p?.session, p.tab_id);
      return networkOf(tabId, p);
    }
    case 'browser.close_tab': {
      const back = await closeOwnTab(p?.session, p.tab_id);
      return back !== undefined ? `Closed. Back on tab ${back}, where it was opened from.` : 'Closed.';
    }
    case 'browser.screenshot': {
      const tabId = await working(p?.session, p.tab_id);
      const url = (await browser.tabs.get(tabId)).url ?? '';
      if (p.ref && p.note) {
        const e = await describeIn(tabId, p.ref);
        addMark(p?.session, tabId, url, e, p.note, true);
      }
      if (p.region) {
        const [a, b] = [await pagePoint(p?.session, tabId, p.region[0], p.region[1]), await pagePoint(p?.session, tabId, p.region[2], p.region[3])];
        if (b.x <= a.x || b.y <= a.y) throw new Error('A region is left, top, right, bottom, with right above left and bottom above top.');
        const { data, frame, w, h } = await regionBase64(tabId, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
        return { data, note: `That region.${keepPicture(p?.session, tabId, url, frame, w, h)}` };
      }
      const marks = takeMarks(p?.session, tabId, url);
      if (p.full) {
        const data = marks.length ? await markedPng(tabId, marks) : await pngBase64(tabId);
        const { w, h } = pngSize(data);
        const view = await ask<Viewport>(tabId, { t: 'viewport' });
        return { data, note: `The whole tab.${keepPicture(p?.session, tabId, url, { x: 0, y: 0, sx: view.w / w, sy: view.h / h }, w, h)}` };
      }
      const last = lastActed.get(p?.session ?? 'user');
      const ref: string | undefined = p.ref ?? (last?.tabId === tabId ? last.ref : undefined);
      const d = ref ? await describeIn(tabId, ref).catch((e) => { if (p.ref) throw e; }) : undefined;
      const { data, area, frame, w, h } = await areaBase64(tabId, d?.rect, marks);
      return { data, note: `${area ? `The area around “${d!.label || d!.loc.name || d!.loc.tag}”. Pass full: true for the whole tab.` : 'The whole tab at half size, as no element was acted on here. Pass full: true for full size.'}${keepPicture(p?.session, tabId, url, frame, w, h)}` };
    }
    case 'runs.get':
      return runs.get(p?.run_id, p?.session);
    case 'runs.repeat':
      return runs.repeat(p?.session);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}
