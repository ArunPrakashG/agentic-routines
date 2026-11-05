import { compileRun, type CompileOptions, type Routine } from '@browser-routines/core';
import * as agent from '../lib/agent';
import * as auth from '../lib/auth';
import * as directory from '../lib/directory';
import * as native from '../lib/native';
import { platform } from '../lib/platform';
import * as replay from '../lib/replay';
import * as runs from '../lib/runs';
import { ask } from '../lib/tabs';
import type { PanelCommand, PanelState } from '../lib/panel-types';

// When each routine last ran and which steps changed then, by owner/name.
type LastRuns = Record<string, { id: string; at: number; changed: number[] }>;

export default defineBackground(() => {
  // ---------- requests from the MCP server, through the host ----------
  native.onRequest(async (method, p) => {
    if (method.startsWith('browser.') || method === 'runs.get') return agent.handle(method, p);
    if (method === 'runs.markSaved') return runs.markSaved(p.run_id);
    // A rebuilt unpacked extension only runs after a reload. Waits so the answer gets out first.
    if (method === 'extension.reload') return void setTimeout(() => browser.runtime.reload(), 100);
    if (method === 'directory.publish') return askToPublish(p.id, agent.agentName(p.agent));
    if (method === 'replay.start') return replay.start(p);
    if (method === 'replay.resume') return replay.resume(p);
    if (method === 'agent.hello') {
      agents.set(p?.session, agent.agentName(p?.agent));
      push();
      return true;
    }
    throw new Error(`Unknown method ${method}`);
  });

  // ---------- side panel ----------
  const panels = new Set<Browser.runtime.Port>();
  // Connected agents by session.
  const agents = new Map<string, string>();
  let routines: PanelState['routines'] = [];
  let recording: { runId: string; tabId: number } | undefined;

  // A routine waiting for the person to say yes to making it public. An agent can ask; only the panel can approve.
  let publishing: { routine: Routine; card: directory.PublishCard; waiter?: { ok: (v: unknown) => void; no: (e: Error) => void } } | undefined;
  type Published = Record<string, { as: string; version: number }>;

  function badge() {
    browser.action.setBadgeText({ text: recording ? 'REC' : publishing && !publishing.card.done ? '1' : '' });
  }

  async function beginPublish(id: string, by?: string, waiter?: NonNullable<typeof publishing>['waiter']) {
    if (publishing && !publishing.card.done) throw new Error('Another routine is waiting for the user to approve publishing it. Try again after that.');
    const account = await auth.account();
    if (!account) throw new Error('The user is not signed in. Ask them to sign in from the Browser Routines side panel.');
    const r = await native.call<Routine & { owner: string }>('store.read', { id });
    if (r.owner !== 'local' && r.owner !== account.handle) throw new Error(`${r.meta.name} is by ${r.owner}, so it cannot be published from here.`);
    const issues = directory.problems(r);
    if (issues.length) throw new Error(issues.join(' '));
    const { shown, more } = directory.publicValues(r);
    publishing = {
      routine: r,
      waiter,
      card: { id, name: r.meta.name, site: r.meta.site, steps: r.steps.length, shown, more, needsHandle: !account.handle, handle: account.handle ?? undefined, by, busy: false },
    };
    badge();
    push();
  }

  /** Called by an agent: answers once the person approved in the panel and it is live, or said no. */
  function askToPublish(id: string, by: string) {
    return new Promise((ok, no) => beginPublish(id, by, { ok, no }).catch(no));
  }

  async function decidePublish(approve: boolean, handle?: string) {
    const p = publishing;
    if (!p) return;
    if (!approve) {
      if (!p.card.done) p.waiter?.no(new Error('The user chose not to publish it.'));
      publishing = undefined;
      badge();
      return;
    }
    if (p.card.done || p.card.busy) return;
    p.card.busy = true;
    p.card.error = undefined;
    push();
    try {
      if (p.card.needsHandle) {
        await directory.claimHandle((handle ?? '').trim().toLowerCase());
        p.card.needsHandle = false;
      }
      const out = await directory.publish(p.routine);
      p.card.done = { as: `${out.owner}/${out.name}`, version: out.version };
      const { published = {} } = (await browser.storage.local.get('published')) as { published?: Published };
      published[`${p.routine.meta.owner ?? 'local'}/${p.routine.meta.name}`] = p.card.done;
      await browser.storage.local.set({ published });
      p.waiter?.ok(out);
      p.waiter = undefined;
    } catch (e) {
      p.card.error = (e as Error).message;
    }
    p.card.busy = false;
    badge();
  }

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
    const { lastRuns = {} } = (await browser.storage.local.get('lastRuns')) as { lastRuns?: LastRuns };
    const { published = {} } = (await browser.storage.local.get('published')) as { published?: Published };
    return {
      account: await auth.account(),
      connected: native.connected(),
      agents: [...new Set(agents.values())],
      routines: routines.map((x) => {
        const last = lastRuns[`${x.owner}/${x.name}`];
        return { ...x, lastRun: last?.at, changed: last?.changed, draftedBy: x.draftedBy ? agent.agentName(x.draftedBy) : undefined, published: published[`${x.owner}/${x.name}`] };
      }),
      runs: all.filter((x) => !x.saved && x.events.length).map((x) => ({ id: x.id, source: x.source, startedAt: x.startedAt, updatedAt: x.updatedAt, events: x.events })),
      recording: recording?.runId,
      publish: publishing?.card,
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

  async function noteRun(s: replay.ReplayState) {
    if (s.status !== 'done' && s.status !== 'failed') return;
    const key = `${s.routine.meta.owner ?? 'local'}/${s.routine.meta.name}`;
    const { lastRuns = {} } = (await browser.storage.local.get('lastRuns')) as { lastRuns?: LastRuns };
    if (lastRuns[key]?.id === s.id) return;
    lastRuns[key] = { id: s.id, at: Date.now(), changed: Object.keys(s.fixes).map(Number) };
    await browser.storage.local.set({ lastRuns });
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
  native.onHostEvent((e, data) => {
    if (e === 'agent.gone') {
      const { session } = data as { session: string };
      agents.delete(session);
      replay.agentGone(session);
      push();
      return;
    }
    if (e === 'routines.changed') refreshRoutines();
  });
  runs.onRunsChanged(push);
  browser.storage.onChanged.addListener((changes) => {
    if (changes.session) push();
  });
  replay.onReplay((s) => noteRun(s).then(push));

  async function setRecording(on: boolean) {
    if (on) {
      const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return;
      recording = { runId: await runs.startHuman(), tabId: tab.id };
      await ask(tab.id, { t: 'record', on: true }).catch(() => {});
      badge();
    } else if (recording) {
      await ask(recording.tabId, { t: 'record', on: false }).catch(() => {});
      recording = undefined;
      badge();
    }
    push();
  }

  async function command(c: PanelCommand): Promise<unknown> {
    switch (c.t) {
      case 'save': {
        const run = await runs.get(c.runId);
        const opts: CompileOptions = { name: c.name, description: c.description, fixed: c.fixed };
        const { routine } = compileRun(run, opts);
        const saved = await native.call<Routine>('store.write', { routine });
        await runs.markSaved(run.id);
        await refreshRoutines();
        // Saving is done either way; a publish that cannot start is not a failed save.
        if (c.publish) await beginPublish(`local/${saved.meta.name}`).catch(() => {});
        return;
      }
      case 'publish':
        return beginPublish(c.id);
      case 'publishDecide':
        return decidePublish(c.approve, c.handle);
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
      case 'signIn':
        return auth.signIn();
      case 'signOut':
        return auth.signOut();
    }
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'panel') return;
    panels.add(port);
    port.onDisconnect.addListener(() => panels.delete(port));
    auth.check();
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

  platform.openPanelOnClick();
  browser.action.setBadgeBackgroundColor?.({ color: '#3530E0' });

  // The session stays out of reach of content scripts.
  (browser.storage.local as any).setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

  // Chrome only wakes a service worker for an event, and agents need the host up.
  browser.runtime.onStartup.addListener(() => {});
  browser.runtime.onInstalled.addListener(() => {});

  native.connect();
});
