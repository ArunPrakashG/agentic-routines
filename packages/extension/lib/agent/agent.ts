import type { Locator, PageFingerprint, RecordedEvent, Viewport } from '@agentic-routines/core';
import { areaBase64, cropHash, pngBase64, type Rect } from '../replay/crop';
import * as llm from '../page/llm';
import * as native from './native';
import { platform } from '../platform';
import * as runs from './runs';
import { unmark } from '../page/mark';
import { agentTabId, ask, glow, heldBy, noteSession, openTab, settle, waitLoaded } from '../page/tabs';

// The browser tools agents call. Each call is done and recorded.

interface Described {
  loc: Locator;
  rect: Rect;
  field: RecordedEvent['field'];
  label: string;
  page: PageFingerprint;
  view?: Viewport;
}

// The tab an agent is working in glows while it works, and for a few seconds after its last call.
const WORKING_MS = 6000;
async function working(session: string | undefined, requested?: number) {
  const tabId = await agentTabId(session, requested);
  await glow(tabId, 'run', WORKING_MS);
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

// The element a default screenshot centres on, for each session.
const lastActed = new Map<string, { tabId: number; ref: string }>();

async function act(source: string, session: string | undefined, tabId: number, ref: string, action: RecordedEvent['action'], value?: string, extra: Partial<RecordedEvent> = {}) {
  const d = await ask<Described>(tabId, { t: 'describe', ref });
  const crop = d.field === 'password' ? undefined : await cropHash(tabId, d.rect);
  const before = (await browser.tabs.get(tabId)).url ?? '';
  let uploaded: Awaited<ReturnType<typeof uploadFile>> | undefined;
  if (action === 'upload') uploaded = await uploadFile(tabId, ref, value!);
  else if (action === 'click' && d.field === 'file') throw new Error('That is a file input: clicking it opens the file picker, which nobody can answer. Call upload with this ref and the absolute path of the file instead.');
  else await ask(tabId, { t: 'act', ref, action, value });
  const after = await settle(tabId, before);
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
  return { d, after, changed: after !== before, uploaded };
}

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
          return { id: t.id, title: unmark(t.title ?? ''), url: t.url, active: t.active, ...(h ? { held_by: h.session === p?.session ? 'you' : h.label } : {}) };
        });
    }
    case 'browser.navigate': {
      let tabId: number;
      if (p.new_tab) {
        tabId = await openTab(p?.session, p.url);
      } else {
        tabId = await working(p?.session, p.tab_id);
        await browser.tabs.update(tabId, { url: p.url });
      }
      await new Promise((r) => setTimeout(r, 200));
      await waitLoaded(tabId);
      await glow(tabId, 'run', WORKING_MS);
      const t = await browser.tabs.get(tabId);
      await runs.record(source, { action: 'navigate', url: t.url ?? p.url, ts: Date.now() }, p?.session);
      const account = await ask<string | undefined>(tabId, { t: 'account' }).catch(() => undefined);
      return { url: t.url, title: unmark(t.title ?? ''), tab_id: tabId, account };
    }
    case 'browser.read': {
      const tabId = await working(p?.session, p.tab_id);
      // Text and what was left out of it, so the MCP server can say so. The address lets the CLI point at a routine for this page.
      if (p.ref) return { text: await ask<string>(tabId, { t: 'text', ref: p.ref }), notes: { omitted: {}, longValues: 0 }, url: (await browser.tabs.get(tabId)).url };
      const out = await ask<{ text: string; notes: unknown }>(tabId, { t: 'read', filter: p.filter, wait: p.wait });
      const account = await ask<string | undefined>(tabId, { t: 'account' }).catch(() => undefined);
      return { ...out, url: (await browser.tabs.get(tabId)).url, account };
    }
    case 'browser.llm': {
      const tabId = await working(p?.session, p.tab_id);
      const out = await llm.find(tabId, { scope: p.scope, full: p.full, maxBytes: p.max_bytes });
      return { ...out, page: (await browser.tabs.get(tabId)).url };
    }
    case 'browser.click': {
      const tabId = await working(p?.session, p.tab_id);
      const { d, after, changed } = await act(source, p?.session, tabId, p.ref, 'click');
      return `Clicked “${d.label || d.loc.name || d.loc.tag}”.${changed ? ` Now at ${after}` : ''}`;
    }
    case 'browser.type': {
      const tabId = await working(p?.session, p.tab_id);
      const { d } = await act(source, p?.session, tabId, p.ref, 'type', p.text);
      if (p.submit) await act(source, p?.session, tabId, p.ref, 'press', 'Enter');
      return `Typed into “${d.label || d.loc.name || d.loc.tag}”.`;
    }
    case 'browser.select': {
      const tabId = await working(p?.session, p.tab_id);
      const { d } = await act(source, p?.session, tabId, p.ref, 'select', p.value);
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
      await ask(tabId, { t: 'act', action: 'press', value: p.key });
      const after = await settle(tabId, before);
      await runs.record(source, { action: 'press', url: before, value: p.key, ts: Date.now(), navigatedTo: after !== before ? after : undefined }, p?.session);
      return `Pressed ${p.key}.`;
    }
    case 'browser.screenshot': {
      const tabId = await working(p?.session, p.tab_id);
      if (p.full) return { data: await pngBase64(tabId), note: 'The whole tab.' };
      const last = lastActed.get(p?.session ?? 'user');
      const ref: string | undefined = p.ref ?? (last?.tabId === tabId ? last.ref : undefined);
      const d = ref ? await ask<Described>(tabId, { t: 'describe', ref }).catch((e) => { if (p.ref) throw e; }) : undefined;
      const { data, area } = await areaBase64(tabId, d?.rect);
      return { data, note: area ? `The area around “${d!.label || d!.loc.name || d!.loc.tag}”. Pass full: true for the whole tab.` : 'The whole tab at half size, as no element was acted on here. Pass full: true for full size.' };
    }
    case 'runs.get':
      return runs.get(p?.run_id, p?.session);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}
