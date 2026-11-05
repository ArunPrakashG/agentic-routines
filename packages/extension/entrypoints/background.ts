import { compileRun, type CompileOptions, type Routine } from '@browser-routines/core';
import * as agent from '../lib/agent';
import * as native from '../lib/native';
import * as replay from '../lib/replay';
import * as runs from '../lib/runs';
import { ask } from '../lib/tabs';
import type { PanelCommand, PanelState } from '../lib/panel-types';

export default defineBackground(() => {
  // ---------- requests from the MCP server, through the host ----------
  native.onRequest(async (method, p) => {
    if (method.startsWith('browser.') || method === 'runs.get') return agent.handle(method, p);
    if (method === 'runs.markSaved') return runs.markSaved(p.run_id);
    if (method === 'replay.start') return replay.start(p);
    if (method === 'replay.resume') return replay.resume(p);
    if (method === 'agent.hello') {
      agents.add(agent.agentName(p?.agent));
      push();
      return true;
    }
    throw new Error(`Unknown method ${method}`);
  });

  // ---------- side panel ----------
  const panels = new Set<Browser.runtime.Port>();
  const agents = new Set<string>();
  let routines: PanelState['routines'] = [];
  let recording: { runId: string; tabId: number } | undefined;

  async function refreshRoutines() {
    try {
      routines = await native.call('store.list');
    } catch {
      routines = [];
    }
    push();
  }

  async function state(): Promise<PanelState> {
    const all = await runs.list();
    const r = replay.current();
    return {
      connected: native.connected(),
      agents: [...agents],
      routines,
      runs: all.filter((x) => !x.saved && x.events.length).map((x) => ({ id: x.id, source: x.source, startedAt: x.startedAt, updatedAt: x.updatedAt, events: x.events })),
      recording: recording?.runId,
      replay: r && {
        id: r.id,
        name: r.routine.meta.name,
        version: r.routine.meta.version,
        status: r.status,
        i: r.i,
        steps: r.routine.steps.map((s) => ({ n: s.n, action: s.action, label: s.label, value: s.value, pause: !!s.pause })),
        modelCalls: r.modelCalls,
        start: r.start,
        by: r.by && agent.agentName(r.by),
        handedBack: !!r.handedBack,
        fixed: Object.keys(r.fixes).map(Number),
        error: r.error,
      },
    };
  }

  async function push() {
    if (!panels.size) return;
    const s = await state();
    for (const p of panels) p.postMessage(s);
  }

  native.onConnection((ok) => {
    if (ok) refreshRoutines();
    else push();
  });
  native.onHostEvent((e) => {
    if (e === 'routines.changed') refreshRoutines();
  });
  runs.onRunsChanged(push);
  replay.onReplay(push);

  async function setRecording(on: boolean) {
    if (on) {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      recording = { runId: await runs.startHuman(), tabId: tab.id };
      await ask(tab.id, { t: 'record', on: true }).catch(() => {});
      browser.action.setBadgeText({ text: 'REC' });
    } else if (recording) {
      await ask(recording.tabId, { t: 'record', on: false }).catch(() => {});
      recording = undefined;
      browser.action.setBadgeText({ text: '' });
    }
    push();
  }

  async function command(c: PanelCommand): Promise<unknown> {
    switch (c.t) {
      case 'save': {
        const run = await runs.get(c.runId);
        const opts: CompileOptions = { name: c.name, description: c.description, fixed: c.fixed };
        const { routine } = compileRun(run, opts);
        await native.call('store.write', { routine });
        await runs.markSaved(run.id);
        await refreshRoutines();
        return;
      }
      case 'discard':
        return runs.discard(c.runId);
      case 'inputs': {
        const r = await native.call<Routine>('store.read', { id: c.id });
        return { params: r.meta.params, secrets: r.meta.secrets };
      }
      case 'run': {
        const r = await native.call<Routine>('store.read', { id: c.id });
        // Secrets typed in the panel live only as long as this replay.
        const secrets = Object.fromEntries(r.meta.secrets.map((n) => [n, c.params[`secret:${n}`] ?? '']));
        replay.start({ routine: r, params: c.params, secrets }).catch(() => {});
        return;
      }
      case 'decide':
        return replay.panelDecide(c.id, c.approve);
      case 'stop':
        return replay.stop(c.id);
      case 'dismiss':
        return replay.dismiss();
      case 'record':
        return setRecording(c.on);
      case 'remove':
        await native.call('store.remove', { id: c.id });
        return refreshRoutines();
      case 'refresh':
        return refreshRoutines();
    }
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return;
    panels.add(port);
    port.onDisconnect.addListener(() => panels.delete(port));
    port.onMessage.addListener(async (c: PanelCommand & { reqId?: number }) => {
      try {
        port.postMessage({ reqId: c.reqId, ok: true, result: await command(c) });
      } catch (e) {
        port.postMessage({ reqId: c.reqId, err: (e as Error).message });
      }
      push();
    });
    push();
  });

  // ---------- human demos ----------
  browser.runtime.onMessage.addListener((msg: any, sender) => {
    if (msg?.t !== 'human' || !recording || sender.tab?.id !== recording.tabId) return;
    runs.record('You', msg.event);
  });
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (!recording || tabId !== recording.tabId) return;
    if (info.url) runs.markNavigated('You', info.url);
    if (info.status === 'complete') ask(tabId, { t: 'record', on: true }).catch(() => {});
  });
  browser.commands?.onCommand.addListener((cmd) => {
    if (cmd === 'record') setRecording(!recording);
  });

  // Chrome opens the side panel from the toolbar button; Firefox toggles its sidebar.
  const b = browser as any;
  if (b.sidePanel) b.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  else if (b.sidebarAction) browser.action.onClicked.addListener(() => b.sidebarAction.toggle());
  browser.action.setBadgeBackgroundColor?.({ color: '#3530E0' });

  // Chrome only wakes a service worker for an event, and agents need the host up.
  browser.runtime.onStartup.addListener(() => {});
  browser.runtime.onInstalled.addListener(() => {});

  native.connect();
});
