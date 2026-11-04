import type { Locator, PageFingerprint, RecordedEvent } from '@browser-routines/core';
import { cropHash, pngBase64, type Rect } from './crop';
import * as native from './native';
import * as runs from './runs';
import { agentTabId, ask, settle, setAgentTab, waitLoaded } from './tabs';

// The browser tools agents call. Each call is done and recorded.

interface Described {
  loc: Locator;
  rect: Rect;
  field: RecordedEvent['field'];
  label: string;
  page: PageFingerprint;
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

/** Put a local file into a file input. Chrome sets the path directly; Firefox streams it through the host. */
export async function uploadFile(tabId: number, ref: string, path: string) {
  if (browser.debugger && (await ask<boolean>(tabId, { t: 'markUpload', ref }))) {
    const target = { tabId };
    await browser.debugger.attach(target, '1.3');
    try {
      const { result } = (await browser.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.querySelector("[data-br-upload]")' })) as any;
      await browser.debugger.sendCommand(target, 'DOM.setFileInputFiles', { files: [path], objectId: result.objectId });
      await browser.debugger.sendCommand(target, 'Runtime.evaluate', { expression: 'document.querySelector("[data-br-upload]").removeAttribute("data-br-upload")' });
    } finally {
      await browser.debugger.detach(target).catch(() => {});
    }
    return;
  }
  const parts: string[] = [];
  let offset = 0;
  let name = path.split(/[\\/]/).pop() ?? 'file';
  for (;;) {
    const c = await native.call<{ name: string; size: number; data: string }>('fs.readChunk', { path, offset });
    name = c.name;
    parts.push(c.data);
    offset += (c.data.length * 3) / 4 - (c.data.endsWith('==') ? 2 : c.data.endsWith('=') ? 1 : 0);
    if (offset >= c.size || !c.data) break;
  }
  const bin = parts.map((p) => atob(p)).join('');
  await ask(tabId, { t: 'attach', ref, files: [{ name, type: '', b64: btoa(bin) }] });
}

async function act(source: string, tabId: number, ref: string, action: RecordedEvent['action'], value?: string, extra: Partial<RecordedEvent> = {}) {
  const d = await ask<Described>(tabId, { t: 'describe', ref });
  const crop = d.field === 'password' ? undefined : await cropHash(tabId, d.rect);
  const before = (await browser.tabs.get(tabId)).url ?? '';
  if (action === 'upload') await uploadFile(tabId, ref, value!);
  else await ask(tabId, { t: 'act', ref, action, value });
  const after = await settle(tabId, before);
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
    navigatedTo: after !== before ? after : undefined,
    ...extra,
  });
  return { d, after, changed: after !== before };
}

export async function handle(method: string, p: any): Promise<unknown> {
  const source = agentName(p?.agent);
  switch (method) {
    case 'browser.tabs': {
      const tabs = await browser.tabs.query({});
      return tabs.filter((t) => /^https?:/.test(t.url ?? '')).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    }
    case 'browser.navigate': {
      let tabId: number;
      if (p.new_tab) {
        const t = await browser.tabs.create({ url: p.url, active: true });
        tabId = t.id!;
        setAgentTab(tabId);
      } else {
        tabId = await agentTabId(p.tab_id);
        await browser.tabs.update(tabId, { url: p.url, active: true });
      }
      await new Promise((r) => setTimeout(r, 200));
      await waitLoaded(tabId);
      const t = await browser.tabs.get(tabId);
      await runs.record(source, { action: 'navigate', url: t.url ?? p.url, ts: Date.now() });
      return { url: t.url, title: t.title, tab_id: tabId };
    }
    case 'browser.read': {
      const tabId = await agentTabId(p.tab_id);
      return ask<string>(tabId, { t: 'read', filter: p.filter });
    }
    case 'browser.click': {
      const tabId = await agentTabId(p.tab_id);
      const { d, after, changed } = await act(source, tabId, p.ref, 'click');
      return `Clicked “${d.label || d.loc.name || d.loc.tag}”.${changed ? ` Now at ${after}` : ''}`;
    }
    case 'browser.type': {
      const tabId = await agentTabId(p.tab_id);
      const { d } = await act(source, tabId, p.ref, 'type', p.text);
      if (p.submit) await act(source, tabId, p.ref, 'press', 'Enter');
      return `Typed into “${d.label || d.loc.name || d.loc.tag}”.`;
    }
    case 'browser.select': {
      const tabId = await agentTabId(p.tab_id);
      const { d } = await act(source, tabId, p.ref, 'select', p.value);
      return `Picked “${p.value}” in “${d.label}”.`;
    }
    case 'browser.upload': {
      const tabId = await agentTabId(p.tab_id);
      const { d } = await act(source, tabId, p.ref, 'upload', p.path, { field: 'file' });
      return `Attached ${p.path.split(/[\\/]/).pop()} to “${d.label || d.loc.name}”.`;
    }
    case 'browser.press': {
      const tabId = await agentTabId(p.tab_id);
      const before = (await browser.tabs.get(tabId)).url ?? '';
      await ask(tabId, { t: 'act', action: 'press', value: p.key });
      const after = await settle(tabId, before);
      await runs.record(source, { action: 'press', url: before, value: p.key, ts: Date.now(), navigatedTo: after !== before ? after : undefined });
      return `Pressed ${p.key}.`;
    }
    case 'browser.screenshot':
      return pngBase64(await agentTabId(p.tab_id));
    case 'runs.get':
      return runs.get(p?.run_id);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}
