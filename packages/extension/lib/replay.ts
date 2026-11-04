import { CROP_DRIFT, fill, hashDistance, pageSimilarity, SAME_PAGE, type Candidate, type Locator, type PageFingerprint, type Routine, type RunResult, type Step } from '@browser-routines/core';
import { uploadFile } from './agent';
import { hashAt, screenshot, type Rect } from './crop';
import { agentTabId, ask, settle, sleep, waitLoaded } from './tabs';

// Replays compiled steps with no model. Before each step: page structure,
// then the element, then the crop. Stops at pauses and at steps that changed.

interface Found {
  kind: 'found' | 'ambiguous' | 'missing';
  ref?: string;
  score?: number;
  rect?: Rect;
  candidates?: (Candidate & { rect: Rect })[];
}

export interface ReplayState {
  id: string;
  routine: Routine;
  params: Record<string, string>;
  secrets: Record<string, string>;
  tabId: number;
  i: number;
  approved: Set<number>;
  modelCalls: number;
  fixes: Record<number, Locator>;
  crops: Record<number, string>;
  read: Record<string, string>;
  start: number;
  status: RunResult['status'] | 'running';
  /** Agent that started it; absent when started from the side panel. */
  by?: string;
  /** The panel stopped waiting and gave the pause back to the agent. */
  handedBack?: boolean;
  error?: string;
  candidates?: Candidate[];
}

const live = new Map<string, ReplayState>();
const watchers = new Set<(s: ReplayState) => void>();
// Approvals given in the side panel while the agent waits.
const panelWaiters = new Map<string, (approve: boolean) => void>();

export function onReplay(fn: (s: ReplayState) => void) {
  watchers.add(fn);
}
// The latest replay, kept after it ends so the panel can show how it went.
let recent: ReplayState | undefined;
function notify(s: ReplayState) {
  recent = s;
  for (const fn of watchers) fn(s);
}

export function current(): ReplayState | undefined {
  return recent;
}

/** Clear a finished replay from the panel. */
export function dismiss() {
  if (recent && !live.has(recent.id)) recent = undefined;
}

/** How long a paused replay waits for the side panel before handing the pause back to the agent. */
const PANEL_WAIT_MS = 90_000;

function result(s: ReplayState): RunResult & { fixes: Record<number, Locator>; crops: Record<number, string> } {
  const step = s.routine.steps[s.i];
  return {
    run_id: s.id,
    status: s.status === 'running' ? 'failed' : s.status,
    routine: s.routine.meta.name,
    version: s.routine.meta.version,
    steps_run: s.i,
    steps_total: s.routine.steps.length,
    model_calls: s.modelCalls,
    ms: Date.now() - s.start,
    at_step: step?.n,
    step_label: step?.label,
    candidates: s.candidates,
    error: s.error,
    read: Object.keys(s.read).length ? s.read : undefined,
    fixes: s.fixes,
    crops: s.crops,
  };
}

async function waitForPage(tabId: number, want?: PageFingerprint): Promise<void> {
  if (!want) return;
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try {
      const fp = await ask<PageFingerprint>(tabId, { t: 'fingerprint' });
      if (pageSimilarity(want, fp) >= SAME_PAGE) return;
    } catch {
      // Page swapping; try again.
    }
    await sleep(250);
  }
  // Advisory: the element check decides.
}

async function findElement(s: ReplayState, step: Step): Promise<Found> {
  const end = Date.now() + 8_000;
  let res: Found = { kind: 'missing' };
  while (Date.now() < end) {
    res = await ask<Found>(s.tabId, { t: 'resolve', target: s.fixes[step.n] ?? step.target! });
    if (res.kind === 'found') break;
    await sleep(300);
  }
  // Two elements look alike: the crop decides, if exactly one is close.
  if (res.kind === 'ambiguous' && step.crop && res.candidates) {
    const img = await screenshot(s.tabId);
    if (img) {
      const close = res.candidates.filter((c) => {
        const h = hashAt(img, c.rect);
        return h && hashDistance(h, step.crop!) <= CROP_DRIFT;
      });
      if (close.length === 1) return { kind: 'found', ref: close[0].ref, rect: close[0].rect, score: close[0].score };
    }
  }
  return res;
}

async function runStep(s: ReplayState, step: Step, ref?: string): Promise<'next' | 'stop'> {
  const value = fill(step.value, s.params, s.secrets);
  if (step.action === 'navigate') {
    await browser.tabs.update(s.tabId, { url: fill(step.url, s.params) });
    await sleep(200);
    await waitLoaded(s.tabId);
    return 'next';
  }
  if (step.action === 'press' && !step.target) {
    const before = (await browser.tabs.get(s.tabId)).url ?? '';
    await ask(s.tabId, { t: 'act', action: 'press', value });
    await settle(s.tabId, before);
    return 'next';
  }
  await waitForPage(s.tabId, step.page);
  if (!ref) {
    const found = await findElement(s, step);
    if (found.kind !== 'found') {
      s.status = 'needs_choice';
      s.candidates = (found.candidates ?? []).map(({ rect: _r, ...c }) => c);
      return 'stop';
    }
    ref = found.ref!;
    // Element agrees; refresh a drifted crop quietly.
    if (step.crop && found.rect) {
      const img = await screenshot(s.tabId);
      const h = img && hashAt(img, found.rect);
      if (h && hashDistance(h, step.crop) > CROP_DRIFT) s.crops[step.n] = h;
    }
  }
  const before = (await browser.tabs.get(s.tabId)).url ?? '';
  if (step.action === 'upload') await uploadFile(s.tabId, ref, value!);
  else if (step.action === 'read') s.read[step.label] = await ask<string>(s.tabId, { t: 'act', ref, action: 'read' });
  else await ask(s.tabId, { t: 'act', ref, action: step.action, value });
  await settle(s.tabId, before);
  return 'next';
}

async function loop(s: ReplayState, choiceRef?: string): Promise<ReturnType<typeof result>> {
  s.status = 'running';
  notify(s);
  try {
    while (s.i < s.routine.steps.length) {
      const step = s.routine.steps[s.i];
      if (step.pause && !s.approved.has(step.n)) {
        s.status = 'paused';
        notify(s);
        const approved = await new Promise<boolean | undefined>((res) => {
          panelWaiters.set(s.id, res);
          // Runs started in the panel wait for the panel; agents get the pause back.
          if (s.by) setTimeout(() => res(undefined), PANEL_WAIT_MS);
        });
        panelWaiters.delete(s.id);
        if (approved === undefined) {
          s.handedBack = true;
          notify(s);
          return result(s);
        }
        if (!approved) {
          s.status = 'failed';
          s.error = 'Stopped at the pause in the side panel';
          return result(s);
        }
        s.approved.add(step.n);
        s.status = 'running';
        notify(s);
      }
      if ((await runStep(s, step, choiceRef)) === 'stop') {
        notify(s);
        return result(s);
      }
      choiceRef = undefined;
      s.i++;
      notify(s);
    }
    s.status = 'done';
  } catch (e) {
    s.status = 'failed';
    s.error = (e as Error).message;
  }
  live.delete(s.id);
  notify(s);
  return result(s);
}

export async function start(p: { routine: Routine; params: Record<string, string>; secrets: Record<string, string>; agent?: string }) {
  const s: ReplayState = {
    id: 'rp-' + crypto.randomUUID().slice(0, 4),
    routine: p.routine,
    params: p.params,
    secrets: p.secrets,
    tabId: await agentTabId(),
    i: 0,
    approved: new Set(),
    modelCalls: 0,
    fixes: {},
    crops: {},
    read: {},
    start: Date.now(),
    status: 'running',
    by: p.agent,
  };
  live.set(s.id, s);
  return loop(s);
}

export async function resume(p: { run_id: string; approve?: boolean; choice?: string }) {
  const s = live.get(p.run_id);
  if (!s) throw new Error(`No paused run ${p.run_id}`);
  s.handedBack = false;
  if (s.status === 'paused') {
    if (p.approve === false) {
      s.status = 'failed';
      s.error = 'Stopped at the pause';
      live.delete(s.id);
      notify(s);
      return result(s);
    }
    s.approved.add(s.routine.steps[s.i].n);
    return loop(s);
  }
  if (s.status === 'needs_choice') {
    if (!p.choice) {
      s.status = 'failed';
      s.error = 'Stopped where the page changed';
      live.delete(s.id);
      notify(s);
      return result(s);
    }
    const d = await ask<{ loc: Locator; rect: Rect }>(s.tabId, { t: 'describe', ref: p.choice });
    const step = s.routine.steps[s.i];
    s.fixes[step.n] = d.loc;
    s.modelCalls++;
    s.candidates = undefined;
    return loop(s, p.choice);
  }
  throw new Error(`Run ${p.run_id} is ${s.status}`);
}

/** Approve or stop from the side panel. */
export function panelDecide(id: string, approve: boolean) {
  panelWaiters.get(id)?.(approve);
}

/** Drop a run that stopped where the page changed. */
export function stop(id: string) {
  const s = live.get(id);
  if (!s) return;
  if (panelWaiters.has(id)) return panelWaiters.get(id)!(false);
  s.status = 'failed';
  s.error = 'Stopped in the side panel';
  live.delete(id);
  notify(s);
}
