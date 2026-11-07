import { flightOn, saveFlight, startFlight, stopFlight } from '../page/capture';
import { secretForField } from '../page/secrets';
import { compareViewport, CROP_DRIFT, fill, loopValues, spanOf, hashDistance, isIrreversible, onSite, soundsIrreversible, pageSimilarity, SAME_PAGE, type Candidate, type Directive, type HookContext, type HookEvent, type Locator, type PageFingerprint, type Routine, type RunResult, type Step, type Viewport } from '@agentic-routines/core';
import { challengeOn, uploadFile } from '../agent/agent';
import { hashAt, screenshot, type Rect } from './crop';
import * as hooks from './hooks';
import { answerDialog, dialogOn, listenBeforeLeaving, waitDialog } from '../page/dialogs';
import { resolveInTab, textOfTab } from '../page/frames';
import { cancelHandoff, handOver } from '../page/handoff';
import { perform as input } from '../page/input';
import { platform } from '../platform';
import { agentTabId, ask, glow, settle, sleep, waitLoaded, wake } from '../page/tabs';

// Replays compiled steps with no model. Before each step: page structure,
// then the element, then the crop. Stops at pauses and at steps that changed.

interface Found {
  kind: 'found' | 'ambiguous' | 'missing';
  disabled?: boolean;
  role?: string;
  name?: string;
  ref?: string;
  score?: number;
  rect?: Rect;
  view?: Viewport;
  /** first: how many elements are like it. */
  count?: number;
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
  approvedInPanel: string[];
  modelCalls: number;
  fixes: Record<number, Locator>;
  crops: Record<number, string>;
  read: Record<string, string>;
  start: number;
  status: RunResult['status'] | 'running';
  /** Agent that started it; absent when started from the side panel. */
  by?: string;
  /** The session of that agent, to notice when it goes away. */
  session?: string;
  /** The video kept when the run failed, and whether the recorder was started just for this run. */
  flightRecording?: string;
  flightForRun?: boolean;
  /** The panel stopped waiting and gave the pause back to the agent. */
  handedBack?: boolean;
  error?: string;
  candidates?: Candidate[];
  /** Written by someone else (the directory, a Git source or a folder). Held to stricter rules. */
  foreign: boolean;
  /** Set when the page is a very different size from the one the routine was recorded at. */
  viewportNote?: string;
  /** The picture check is off for this run because of it. */
  relaxCrop?: boolean;
  /** A step did not match while the person was looking at something else. */
  hiddenNote?: string;
  handoffs?: { n: number; reason: string }[];
  /** Steps that paused only because they look irreversible. */
  forcedPauses: number[];
  /** The step an agent chose another element for, which waits for the person when that element looks irreversible. */
  chosenAt?: number;
  /** Why it is paused now. A forced pause is the person's alone to answer. */
  pauseKind?: 'asked' | 'forced';
  /** Match the window to the recorded size for the run, and put it back after. */
  fitWindow?: boolean;
  /** The window as it was, to put back. */
  windowWas?: { id: number; width: number; height: number; left?: number; top?: number };
  /** A test of a draft: stops at the first pause without approving it, and changed steps fail it. */
  test?: boolean;
  skipped: number[];
  trace: string[];
  finalUrl?: string;
  /** The routine's hooks for this run, when it has any. */
  hooks?: hooks.HookRun;
  started?: boolean;
  ended?: boolean;
  /** What step.before decided for the step in hand, so it is not asked again when the step resumes after a pause. */
  prepared?: { n: number; ov: { skip?: boolean; value?: string } };
  /** The step whose hook-made pause the agent approved. */
  hookApproved?: number;
  /** The loop going on now. There is at most one: a routine cannot put one inside another. */
  loop?: Loop;
  /** Where to go instead when reaching a step: the end of a branch that ran skips the other one. */
  jumps: Record<number, number>;
  loops: NonNullable<RunResult['loops']>;
  branches: NonNullable<RunResult['branches']>;
  /** How the finished run compared with what the routine expects. */
  outcome?: RunResult['outcome'];
  stepMs: Record<number, number>;
}

interface Loop {
  /** Indexes of the steps that repeat: [first, end). */
  first: number;
  end: number;
  step: Step;
  pass: number;
  /** The values left, for a loop over a parameter. */
  values?: string[];
  /** Which element this pass is on, for a loop over elements, and how many there were. */
  index: number;
  seen: number;
  record: NonNullable<RunResult['loops']>[number];
}

/** A hook asked for the run to stop. */
class HookFail extends Error {}

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
/** A pause only the person can answer ends the run if they do not come to the panel. */
const FORCED_WAIT_MS = 10 * 60_000;

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
    ...(s.test ? { final_url: s.finalUrl } : {}),
    ...(s.hooks ? { hooks: s.hooks.report() } : {}),
    candidates: s.candidates,
    error: s.error,
    read: Object.keys(s.read).length ? s.read : undefined,
    flight_recording: s.flightRecording,
    approved_in_panel: s.approvedInPanel.length ? s.approvedInPanel : undefined,
    viewport_note: s.viewportNote,
    hidden_note: s.hiddenNote,
    handoffs: s.handoffs,
    loops: s.loops.length ? s.loops : undefined,
    branches: s.branches.length ? s.branches : undefined,
    forced_pauses: s.forcedPauses.length ? s.forcedPauses : undefined,
    outcome: s.outcome,
    step_ms: s.stepMs,
    fixes: s.fixes,
    crops: s.crops,
    ...(s.test ? { test: true, skipped: s.skipped, trace: s.trace } : {}),
  };
}

// ---------- what the extension holds to, whatever the routine or the page says ----------

const originOf = (u: string) => {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
};

/** Where a routine's own steps were recorded. A routine from someone else gets none of this: only its site. */
function recordedOrigins(r: Routine): Set<string> {
  const out = new Set<string>();
  for (const st of r.steps) for (const u of [st.url, st.page?.url]) if (u && !u.includes('{{')) out.add(originOf(u));
  out.delete('');
  return out;
}

/** May the replay act on this address? The routine's own site, and for the person's own routines the pages they recorded it on. */
function mayBeOn(s: ReplayState, url: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  if (onSite(url, s.routine.meta.site)) return true;
  return !s.foreign && recordedOrigins(s.routine).has(originOf(url));
}

function offSite(s: ReplayState, url: string, what: string) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Not an address.
  }
  return new Error(`${what} ${host || 'a page'}, which is not ${s.routine.meta.site}. A routine only works on the site it was recorded for, so it stopped before touching it.`);
}

/** Looked at before every step that touches the page: a redirect or a link can have taken the tab elsewhere. */
async function stayOnSite(s: ReplayState) {
  const url = (await browser.tabs.get(s.tabId)).url ?? '';
  if (!mayBeOn(s, url)) throw offSite(s, url, 'The tab is on');
}

/** Pauses a step needs: its own, and for a routine from someone else also any that looks irreversible. */
function pauseFor(s: ReplayState, step: Step): 'asked' | 'forced' | undefined {
  if (step.pause) return 'asked';
  if (s.foreign && isIrreversible({ action: step.action, target: step.target })) return 'forced';
  // Someone else's routine does not get to use what the person saved without them seeing the step.
  if (s.foreign && step.value?.includes('{{secret:') && !s.secrets[/secret:([a-z0-9_]+)/.exec(step.value)?.[1] ?? '']) return 'forced';
  return undefined;
}

// ---------- viewport ----------

/** Compares the page size now with the one recorded. Once per run; a very different size switches the picture check off. */
function noteViewport(s: ReplayState, view?: Viewport) {
  if (s.viewportNote !== undefined || !view) return;
  const check = compareViewport(s.routine.meta.viewport, view);
  s.viewportNote = check.note ?? '';
  s.relaxCrop = check.match === 'different';
  if (check.note) notify(s);
}

/** Resize the window so the page is the recorded size, only when that can be undone and nothing else is in the way. */
async function fitWindow(s: ReplayState) {
  const want = s.routine.meta.viewport;
  if (!s.fitWindow || !want) return;
  try {
    const now = await ask<Viewport>(s.tabId, { t: 'viewport' });
    if (compareViewport(want, now).match !== 'different') return;
    const tab = await browser.tabs.get(s.tabId);
    const win = await browser.windows.get(tab.windowId);
    if (win.state !== 'normal' || win.width === undefined || win.height === undefined) {
      s.viewportNote = `The window is ${win.state}, so it was not resized to match the recorded ${want.w}px. ${s.viewportNote ?? ''}`.trim();
      return;
    }
    // The person's own tabs are in this window, and a run does not move things under them.
    if ((await browser.tabs.query({ windowId: win.id })).length > 1) {
      s.viewportNote = `The window has other tabs in it, so it was not resized to match the recorded ${want.w}px. ${s.viewportNote ?? ''}`.trim();
      return;
    }
    s.windowWas = { id: win.id!, width: win.width, height: win.height, left: win.left, top: win.top };
    await browser.windows.update(win.id!, { width: Math.max(300, win.width + (want.w - now.w)), height: Math.max(300, win.height + (want.h - now.h)) });
    await sleep(400);
    // Whatever the page reports now decides: a window cannot always get that small or that big.
    s.viewportNote = undefined;
  } catch {
    // Left as it is; the comparison runs on the real size.
  }
}

/** Puts the window back. Safe to call twice. */
async function restoreWindow(s: ReplayState) {
  const w = s.windowWas;
  s.windowWas = undefined;
  if (!w) return;
  try {
    await browser.windows.update(w.id, { width: w.width, height: w.height, ...(w.left !== undefined ? { left: w.left, top: w.top } : {}) });
  } catch {
    // The window is gone.
  }
}

/** A replay is over: forget it, and give the window back. */
function end(s: ReplayState) {
  live.delete(s.id);
  void restoreWindow(s);
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

/** Is the tab where the person can see it? If not, a page that only finishes drawing in front could be why a step did not match. */
async function noteHidden(s: ReplayState, step: Step) {
  try {
    const tab = await browser.tabs.get(s.tabId);
    const win = await browser.windows.get(tab.windowId);
    if (tab.active && win.state !== 'minimized') return;
    s.hiddenNote = `Step ${step.n} ran in a tab behind another (tab ${s.tabId}). Some pages only finish drawing or loading in front. If the page looks unfinished with read_page, ask the user to bring that tab forward and try again.`;
  } catch {
    // The tab is gone, and the run will say so.
  }
}

async function findElement(s: ReplayState, step: Step): Promise<Found> {
  const end = Date.now() + 8_000;
  let res: Found = { kind: 'missing' };
  while (Date.now() < end) {
    const fix = s.fixes[step.n];
    res = await resolveInTab<Found>(s.tabId, step.pick === 'each' ? { t: 'first', target: fix ?? step.target!, index: s.loop?.index ?? 0 } : step.pick === 'first' && !fix ? { t: 'first', target: step.target! } : { t: 'resolve', target: fix ?? step.target!, wide: !!step.pointer?.spot || step.action === 'hover' || step.action === 'drag' || step.action === 'scroll' });
    noteViewport(s, res.view);
    // A button can stay disabled for a moment after the step before it, and a click on it does nothing.
    if (res.kind === 'found' && !res.disabled) break;
    await wake(s.tabId);
    await sleep(300);
  }
  if (res.kind === 'found' && res.disabled) return { kind: 'missing', candidates: res.ref ? [{ ref: res.ref, role: res.role, name: res.name, score: res.score ?? 0, rect: res.rect! }] : [] };
  // Two elements look alike: the crop decides, if exactly one is close.
  if (res.kind === 'ambiguous' && step.crop && res.candidates && !s.relaxCrop) {
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

// ---------- hooks ----------

interface Outcome {
  skip?: boolean;
  value?: string;
}

const detailOf = (d?: HookContext['detail']) => d;

async function contextFor(s: ReplayState, event: HookEvent, step: Step | undefined, o: { targetRef?: string; detail?: HookContext['detail'] }): Promise<HookContext> {
  const m = s.routine.meta;
  const url = await browser.tabs.get(s.tabId).then((t) => t.url ?? '', () => '');
  // Secrets stay as {{secret:name}}; values the person gave are filled in.
  const shown = (v?: string) => v?.replace(/\{\{([a-z0-9_]+)\}\}/g, (x, n) => s.params[n] ?? x);
  const params = Object.fromEntries(Object.entries(s.params).map(([k, v]) => [k, m.params[k]?.type === 'file' ? (v.split(/[\\/]/).pop() ?? '') : v]));
  const dom = await ask<NonNullable<HookContext['dom']>>(s.tabId, { t: 'snapshot', ref: o.targetRef }).catch(() => undefined);
  return {
    event,
    routine: { name: m.name, version: m.version, site: m.site, description: m.description },
    params,
    ...(step ? { step: { n: step.n, total: s.routine.steps.length, action: step.action, label: step.label, value: shown(step.value), url: shown(step.url), pause: !!step.pause } } : {}),
    url,
    ...(dom ? { dom } : {}),
    ...(o.detail ? { detail: detailOf(o.detail) } : {}),
  };
}

/** Does what the directives asked for, as far as it is allowed. What is refused is logged with why. */
async function perform(s: ReplayState, event: HookEvent, ds: Directive[], step?: Step): Promise<Outcome> {
  const h = s.hooks!;
  const entry = h.last!;
  const out: Outcome = {};
  const refuse = (d: Directive, why: string) => entry.refused.push({ directive: JSON.stringify(d).slice(0, 80), why });
  const late = event === 'run.end' || event === 'error';
  for (const d of ds) {
    try {
      if (late && d.do !== 'note') {
        refuse(d, 'The run is over; only a note can still be added.');
        continue;
      }
      switch (d.do) {
        case 'skip':
          out.skip = true;
          entry.done.push('skip this step');
          break;
        case 'set':
          if (d.param) {
            const spec = s.routine.meta.params[d.param];
            if (!spec) refuse(d, `“${d.param}” is not a parameter of this routine.`);
            else if (spec.type === 'file') refuse(d, 'A hook cannot choose a file.');
            else {
              s.params[d.param] = d.value;
              entry.done.push(`set ${d.param}`);
            }
          } else if (!step || !['type', 'select', 'press'].includes(step.action)) refuse(d, 'This step takes no typed value.');
          else if (step.value?.includes('{{secret:')) refuse(d, 'This step uses a secret, and a hook cannot change it.');
          else {
            out.value = d.value;
            entry.done.push(`set the value of step ${step.n}`);
          }
          break;
        case 'click':
        case 'type':
          await ask(s.tabId, { t: 'hookmay', ref: d.ref, action: d.do });
          await input(s.tabId, d.ref, d.do, d.do === 'type' ? d.text : undefined);
          await sleep(150);
          entry.done.push(`${d.do} ${d.ref}`);
          break;
        case 'wait':
          await sleep(d.ms);
          entry.done.push(`wait ${d.ms} ms`);
          break;
        case 'goto':
          if (!onSite(d.url, s.routine.meta.site)) {
            refuse(d, `That address is not on ${s.routine.meta.site}.`);
            break;
          }
          await browser.tabs.update(s.tabId, { url: d.url });
          await sleep(200);
          await waitLoaded(s.tabId);
          entry.done.push(`go to ${d.url}`);
          break;
        case 'note':
          h.notes.push(d.text);
          entry.done.push('note');
          break;
        case 'fail':
          entry.done.push(`stop the run: ${d.reason}`);
          throw new HookFail(d.reason);
        case 'pause':
          h.pause = d.reason;
          entry.done.push(`pause: ${d.reason}`);
          break;
      }
    } catch (e) {
      if (e instanceof HookFail) throw e;
      refuse(d, (e as Error).message.replace(/^refused: /, ''));
    }
  }
  return out;
}

/** Fires the hook for an event, if the routine has one and it may run. Never throws, except to stop the run when a hook said to. */
async function hook(s: ReplayState, event: HookEvent, step?: Step, o: { targetRef?: string; detail?: HookContext['detail'] } = {}): Promise<Outcome> {
  const h = s.hooks;
  if (!h?.has(event)) return {};
  try {
    const ds = await h.fire(event, await contextFor(s, event, step, o));
    return await perform(s, event, ds, step);
  } catch (e) {
    if (e instanceof HookFail) throw e;
    if (h.last) h.last.error = (e as Error).message;
    return {};
  }
}

async function runStep(s: ReplayState, step: Step, ref?: string, ov: Outcome = {}): Promise<'next' | 'stop'> {
  // A secret the person stored is fetched at the field it goes in, and only there.
  const stored = ov.value === undefined && step.action === 'type' ? /^\{\{secret:([a-z0-9_]+)\}\}$/.exec(step.value ?? '')?.[1] : undefined;
  const fromStore = stored !== undefined && s.secrets[stored] === undefined ? stored : undefined;
  let value = fromStore ? undefined : (ov.value ?? fill(step.value, s.params, s.secrets));
  const kind = step.action;
  const hooked = ['click', 'type', 'select', 'upload', 'navigate', 'press', 'read'].includes(kind);
  const urlOf = async () => (await browser.tabs.get(s.tabId)).url ?? '';
  const after = async (from: string, targetRef?: string) => {
    if (hooked) await hook(s, `action.${kind}.after` as HookEvent, step, { targetRef });
    const to = await urlOf();
    if (to !== from || kind === 'navigate') await hook(s, 'page.load', step, { detail: { from, to } });
  };
  if (kind === 'navigate') {
    const from = await urlOf();
    const a = await hook(s, 'action.navigate.before', step);
    if (a.skip) return 'next';
    // Whatever the routine says, and whatever the params fill in, it never leaves its own site. Checked after the values are put in.
    const url = fill(step.url, s.params, {}, true) ?? '';
    if (!mayBeOn(s, url)) throw offSite(s, url, 'This step opens');
    await listenBeforeLeaving(s.tabId);
    await browser.tabs.update(s.tabId, { url });
    await sleep(200);
    await waitLoaded(s.tabId);
    await after(from);
    return 'next';
  }
  if (kind === 'handoff') {
    // A person cannot be asked in a test. A secret never goes on the card.
    if (s.test) {
      if (!s.skipped.includes(step.n)) s.skipped.push(step.n);
      s.trace.push(`${step.n}. skipped “${step.label}”, it hands over to the user in a real run`);
      return 'next';
    }
    await toThePerson(s, fill(step.value, s.params, {}) ?? 'This step needs you.', step);
    return 'next';
  }
  await stayOnSite(s);
  if (kind === 'dialog') {
    const open = await waitDialog(s.tabId, DIALOG_WAIT_MS);
    if (!open) throw new Error(`Stopped: step ${step.n} answers a dialog, and none opened`);
    // The pause was decided by what it said when it was recorded. A page can ask something else now.
    if (!step.dismiss && !isIrreversible(step) && soundsIrreversible(open.message)) throw new Error(`Stopped: step ${step.n} would say yes to a dialog that says something else now: ${open.message}`);
    const before = await urlOf();
    await answerDialog(s.tabId, !step.dismiss, value);
    await settle(s.tabId, before);
    await after(before);
    return 'next';
  }
  if (kind === 'press' && !step.target) {
    const before = await urlOf();
    const a = await hook(s, 'action.press.before', step);
    if (a.skip) return 'next';
    await input(s.tabId, undefined, 'press', a.value ?? value);
    await settle(s.tabId, before);
    await after(before);
    return 'next';
  }
  // Scrolling the page itself has nothing to find.
  if (kind === 'scroll' && !step.target) {
    await input(s.tabId, undefined, 'scroll', undefined, step.pointer);
    return 'next';
  }
  // A routine from someone else stays on its site inside the page too: a frame from elsewhere is someone else's form.
  if (s.foreign && step.target?.frame && !onSite(step.target.frame, s.routine.meta.site)) throw offSite(s, step.target.frame, 'This step works in a frame from');
  await waitForPage(s.tabId, step.page);
  if (!ref) {
    const found = await findElement(s, step);
    if (found.kind !== 'found') {
      await noteHidden(s, step);
      s.status = 'needs_choice';
      s.candidates = (found.candidates ?? []).map(({ rect: _r, ...c }) => c);
      return 'stop';
    }
    ref = found.ref!;
    // Whichever row this pass is on was not the one recorded, so the pause decided from the recording does not speak for it.
    if (step.pick === 'each' && soundsIrreversible(found.name ?? '') && !s.approved.has(step.n)) throw new Error(`Stopped: step ${step.n} would use “${found.name}” on this pass, which looks irreversible and is not what was recorded`);
    // Element agrees; refresh a drifted crop quietly. A page of another size would give a hash for another layout.
    if (step.crop && found.rect && !s.relaxCrop && step.pick !== 'each') {
      const img = await screenshot(s.tabId);
      const h = img && hashAt(img, found.rect);
      if (h && hashDistance(h, step.crop) > CROP_DRIFT) s.crops[step.n] = h;
    }
  }
  const before = await urlOf();
  if (hooked) {
    const a = await hook(s, `action.${kind}.before` as HookEvent, step, { targetRef: ref });
    if (a.skip) return 'next';
    if (a.value !== undefined) value = a.value;
  }
  if (kind === 'upload') {
    // The file is the person's to give: a path written into the routine, or set by a hook, is never read.
    const param = /^\{\{([a-z0-9_]+)\}\}$/.exec(step.value ?? '')?.[1];
    if (!param || s.routine.meta.params[param]?.type !== 'file') throw new Error(`Stopped: step ${step.n} uploads a file the routine picks`);
    await uploadFile(s.tabId, ref, fill(step.value, s.params)!);
  }
  else if (kind === 'read') s.read[s.loop ? `${step.label} (${s.loop.pass})` : step.label] = await ask<string>(s.tabId, { t: 'act', ref, action: 'read' });
  else if (kind === 'drag') {
    const end = await findElement(s, { ...step, target: step.pointer?.to?.target, crop: undefined, pointer: { spot: step.pointer?.to?.spot } });
    if (end.kind !== 'found') throw new Error(`Stopped: step ${step.n} drags to something that is not on the page`);
    await input(s.tabId, ref, kind, undefined, { ...step.pointer, toRef: end.ref });
  }
  else {
    if (fromStore) value = await secretForField(s.tabId, ref, fromStore);
    await input(s.tabId, ref, kind, value, step.pointer);
  }
  await settle(s.tabId, before);
  await after(before, ref);
  return 'next';
}

/** All the steps ran. Did the task happen? Pages take a moment to show it, so this looks for a few seconds. Never fails the run itself. */
async function checkOutcome(s: ReplayState) {
  const want = s.routine.meta.expect;
  if (!want || s.skipped.length) return;
  const plain = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const text = fill(want.text, s.params);
  const url = fill(want.url, s.params, {}, true);
  const wanted = [text && `“${text}”`, url && `an address with ${url}`].filter(Boolean).join(' and ');
  const end = Date.now() + OUTCOME_WAIT_MS;
  while (true) {
    const ok = await (async () => {
      if (url && !((await browser.tabs.get(s.tabId)).url ?? '').includes(url)) return false;
      return !text || plain((await textOfTab(s.tabId)).text).includes(plain(text));
    })().catch(() => false);
    if (ok || Date.now() > end) {
      s.outcome = { ok, wanted };
      return;
    }
    await sleep(500);
  }
}

// ---------- loops and branches ----------

const CONDITION_WAIT_MS = 1500;
const plainText = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/** Is it on the page? A notice can take a moment to show, so a no is looked at again for a moment. */
async function holds(s: ReplayState, when: NonNullable<Step['when']>): Promise<boolean> {
  const text = when.text && plainText(fill(when.text, s.params)!);
  const end = Date.now() + CONDITION_WAIT_MS;
  while (true) {
    const yes = await (async () => {
      if (text) return plainText((await textOfTab(s.tabId)).text).includes(text);
      const r = await resolveInTab<Found>(s.tabId, { t: 'resolve', target: when.has! });
      return r.kind === 'found' || r.kind === 'ambiguous';
    })().catch(() => false);
    if (yes || Date.now() > end) return when.not ? !yes : yes;
    await sleep(250);
  }
}

async function countLike(s: ReplayState, target: Locator): Promise<number> {
  const end = Date.now() + CONDITION_WAIT_MS;
  while (true) {
    const n = await resolveInTab<Found>(s.tabId, { t: 'first', target }).then((r) => r.count ?? 0, () => 0);
    if (n || Date.now() > end) return n;
    await sleep(250);
  }
}

/** Each pass asks again what a pause asked: yes last time is not yes this time. */
function forgetPass(s: ReplayState, l: Loop) {
  for (const st of s.routine.steps.slice(l.first, l.end)) {
    s.approved.delete(st.n);
    if (s.hookApproved === st.n) s.hookApproved = undefined;
    if (s.prepared?.n === st.n) s.prepared = undefined;
    if (s.chosenAt === st.n) s.chosenAt = undefined;
  }
}

/** Starts the next pass of the loop, or ends it. Says where the run goes next. */
async function nextPass(s: ReplayState, l: Loop): Promise<number> {
  forgetPass(s, l);
  const e = l.step.each!;
  let more = true;
  if (l.values) {
    more = l.values.length > 0;
    if (more) s.params[e.param!] = l.values.shift()!;
  } else if (l.pass >= e.limit) {
    const left = await countLike(s, e.matching!);
    if (left > l.index + 1) l.record.note = `It stopped at its limit of ${e.limit}. There may be more on the page.`;
    more = false;
  } else {
    // A pass that took its row off the list leaves the next row where this one was.
    const now = await countLike(s, e.matching!);
    if (l.pass > 0 && now >= l.seen) l.index++;
    l.seen = now;
    more = l.index < now;
  }
  if (!more) {
    // The parameter stays on its last value, which is what a check on the finished run wants to see.
    s.loop = undefined;
    return l.end;
  }
  l.pass++;
  l.record.passes = l.pass;
  if (s.test) s.trace.push(`${l.step.n}. pass ${l.pass}${e.param ? `: ${s.params[e.param]}` : ''}`);
  return l.first;
}

/** Goes to a step, unless that means the end of one way of a branch or of a pass. A loop that ends can be the end of a branch too. */
async function goTo(s: ReplayState, step: number) {
  let next = step;
  while (true) {
    while (s.jumps[next] !== undefined) {
      const to = s.jumps[next];
      delete s.jumps[next];
      next = to;
    }
    if (!s.loop || next < s.loop.end) break;
    next = await nextPass(s, s.loop);
  }
  s.i = next;
}

const advance = (s: ReplayState) => goTo(s, s.i + 1);

/** Runs a step that only decides where to go. */
async function runBlock(s: ReplayState, step: Step) {
  await stayOnSite(s);
  const [first, end] = spanOf(step, s.i);
  if (step.each) {
    const e = step.each;
    const values = e.param ? loopValues(s.params[e.param] ?? '') : undefined;
    if (values && values.length > e.limit) throw new Error(`Stopped: step ${step.n} was given ${values.length} values, and its limit is ${e.limit}. Nothing in it ran.`);
    const record = { n: step.n, passes: 0 };
    s.loops.push(record);
    s.loop = { first, end, step, pass: 0, values, index: 0, seen: 0, record };
    await goTo(s, await nextPass(s, s.loop));
    return;
  }
  const w = step.when!;
  const yes = await holds(s, w);
  const record = s.branches.find((b) => b.n === step.n) ?? s.branches[s.branches.push({ n: step.n, took: [] }) - 1];
  record.took.push(yes ? 'then' : 'else');
  if (s.test) s.trace.push(`${step.n}. “${step.label}”: ${yes ? `yes, ${w.then ? 'runs the steps for yes' : 'nothing to run'}` : `no, ${w.else ? 'runs the steps for no' : 'skips what follows'}`}`);
  if (yes && w.else) s.jumps[first + w.then] = end;
  await goTo(s, yes ? first : first + w.then);
}

// How long a run waits for a person: under what the agent's call waits for the whole run.
const HANDOFF_WAIT_MS = 12 * 60_000;

/** The tab is the person's until they give it back, and the run only waits. */
async function toThePerson(s: ReplayState, reason: string, step: Step) {
  await glow(s.tabId, 'paused', HANDOFF_WAIT_MS);
  notify(s);
  const h = await handOver(s.tabId, { reason, by: s.routine.meta.name, session: s.session, waitMs: HANDOFF_WAIT_MS });
  if (!live.has(s.id)) throw new Error('Stopped while the tab was with the user');
  if (!h.continued) {
    if (!h.closed) cancelHandoff(s.tabId);
    throw new Error(h.closed ? `Stopped: the tab was closed while it was with the user at step ${step.n}` : `Stopped: nobody finished the hand-over at step ${step.n}`);
  }
  (s.handoffs ??= []).push({ n: step.n, reason });
  await waitLoaded(s.tabId).catch(() => {});
  await glow(s.tabId, 'run', DRIVING_MS);
}

/** A bot check where a step should be: reported and handed over, never solved. */
async function passChallenge(s: ReplayState, step: Step) {
  const kind = await challengeOn(s.tabId);
  if (!kind) return;
  if (s.test) throw new Error(`Stopped: the page is a bot check or a refusal (${kind}), which a test cannot get past. A real run hands it to the user`);
  await toThePerson(s, `This page is asking for a check (${kind}) before the routine can go on. Only you can do it.`, step);
}

// The page glows for as long as the replay is driving it, amber while it waits for a person.
const DRIVING_MS = 8000;
const DIALOG_WAIT_MS = 5000;
const OUTCOME_WAIT_MS = 5000;
const PAUSED_MS = 15 * 60_000;

async function loop(s: ReplayState, choiceRef?: string): Promise<ReturnType<typeof result>> {
  try {
    return await drive(s, choiceRef);
  } finally {
    await glow(s.tabId, 'off');
  }
}

/** Tells the hooks the run is over, once. A hook that fails here can only add a note. */
async function ended(s: ReplayState) {
  if (s.ended || !s.started) return;
  s.ended = true;
  if (flightOn(s.tabId)) {
    if (s.status === 'failed') s.flightRecording = await saveFlight(s.tabId).then((f) => f.path, () => undefined);
    if (s.flightForRun) stopFlight(s.tabId);
  }
  await hook(s, 'run.end', undefined, { detail: { status: s.status, error: s.error } }).catch(() => ({}));
}

async function drive(s: ReplayState, choiceRef?: string): Promise<ReturnType<typeof result>> {
  s.status = 'running';
  notify(s);
  try {
    if (!s.started) {
      s.started = true;
      await hook(s, 'run.start');
    }
    while (s.i < s.routine.steps.length) {
      const step = s.routine.steps[s.i];
      if (step.action === 'each' || step.action === 'if') {
        await runBlock(s, step);
        notify(s);
        continue;
      }
      if (s.test && pauseFor(s, step)) {
        // A test never performs a step that pauses, and never approves one. What follows is still checked.
        if (step.action === 'dialog' && dialogOn(s.tabId)) await answerDialog(s.tabId, false);
        if (!s.skipped.includes(step.n)) s.skipped.push(step.n);
        s.trace.push(`${step.n}. skipped “${step.label}”, it pauses in a real run`);
        await advance(s);
        notify(s);
        continue;
      }
      // A step the agent picked a candidate for has already had its hook.
      if (s.prepared?.n !== step.n) s.prepared = { n: step.n, ov: choiceRef ? {} : await hook(s, 'step.before', step) };
      const ov = s.prepared.ov;
      if (ov.skip) {
        s.trace.push(`${step.n}. skipped by a hook`);
        await advance(s);
        notify(s);
        continue;
      }
      // A hook can ask for a person to look before a step. It can never be the one who says yes.
      const asked = s.test || s.hookApproved === step.n ? undefined : s.hooks?.pause;
      if (s.hooks) s.hooks.pause = undefined;
      const kind = pauseFor(s, step) ?? (s.chosenAt === step.n ? 'forced' : undefined) ?? (asked ? 'asked' : undefined);
      if ((kind && !s.approved.has(step.n)) || asked) {
        s.pauseKind = kind;
        if (kind === 'forced' && !s.forcedPauses.includes(step.n)) s.forcedPauses.push(step.n);
        if (s.session && goneSessions.has(s.session)) {
          s.status = 'failed';
          s.error = AGENT_GONE;
          await ended(s);
          end(s);
          notify(s);
          return result(s);
        }
        s.status = 'paused';
        notify(s);
        await hook(s, 'pause.reached', step, { detail: { reason: asked } });
        await glow(s.tabId, 'paused', PAUSED_MS);
        const approved = await new Promise<boolean | undefined>((res) => {
          panelWaiters.set(s.id, res);
          // Runs started in the panel wait for the panel; agents get the pause back. Not when the routine is from
          // someone else and the step looks irreversible: that is the person's to answer, and the run ends if nobody does.
          if (s.by && kind === 'asked') setTimeout(() => res(undefined), PANEL_WAIT_MS);
          if (kind === 'forced') setTimeout(() => res(false), FORCED_WAIT_MS);
        });
        panelWaiters.delete(s.id);
        if (!live.has(s.id)) return result(s);
        if (approved === undefined) {
          s.handedBack = true;
          notify(s);
          return result(s);
        }
        if (!approved) {
          s.status = 'failed';
          s.error = 'Stopped at the pause in the side panel';
          await ended(s);
          end(s);
          notify(s);
          return result(s);
        }
        s.approved.add(step.n);
        s.approvedInPanel.push(`step ${step.n} “${step.label}”`);
        s.status = 'running';
        notify(s);
        await hook(s, 'pause.approved', step);
      }
      await glow(s.tabId, 'run', DRIVING_MS);
      const began = Date.now();
      if (step.action !== 'navigate' && step.action !== 'handoff') await passChallenge(s, step);
      const went = await runStep(s, step, choiceRef, ov);
      s.stepMs[step.n] = (s.stepMs[step.n] ?? 0) + Date.now() - began;
      if (went === 'stop') {
        await hook(s, 'step.changed', step, { detail: { candidates: s.candidates?.length ?? 0 } });
        if (s.test) {
          const near = (s.candidates ?? []).map((c) => `${c.ref} ${c.role ?? ''} “${c.name ?? c.text ?? ''}”`).join('; ');
          s.status = 'failed';
          s.error = `${step.action} “${step.label}” was not on the page the way it was recorded${near ? `. Closest: ${near}` : ''}`;
          await ended(s);
          end(s);
          notify(s);
          return result(s);
        }
        notify(s);
        return result(s);
      }
      choiceRef = undefined;
      if (s.test) {
        const url = (await browser.tabs.get(s.tabId)).url ?? '';
        s.trace.push(`${step.n}. ${step.action} ${step.action === 'navigate' ? (step.url ?? '') : `“${step.label}”`}${url && url !== s.finalUrl ? ` → ${url}` : ''}`);
        s.finalUrl = url;
      }
      await hook(s, 'step.after', step);
      await advance(s);
      notify(s);
    }
    await checkOutcome(s).catch(() => {});
    s.status = 'done';
  } catch (e) {
    s.status = 'failed';
    s.error = e instanceof HookFail ? `Stopped by a hook: ${e.message}` : (e as Error).message;
    await hook(s, 'error', s.routine.steps[s.i], { detail: { error: s.error } }).catch(() => ({}));
  }
  await ended(s);
  end(s);
  if (s.test) s.finalUrl = await browser.tabs.get(s.tabId).then((t) => t.url, () => s.finalUrl);
  notify(s);
  return result(s);
}

// The same routine runs once at a time: two agents sending the same release or the same form would do its side
// effects twice. A second call waits its turn, and gives up with who has it if the first is still going.
const QUEUE_MS = 120_000;
const ACTIVE = new Set<string>(['running', 'paused', 'needs_choice']);
const routineKey = (r: Routine) => `${(r as Routine & { owner?: string }).owner ?? r.meta.owner ?? 'local'}/${r.meta.name}`;

async function waitForRoutine(r: Routine, session?: string): Promise<string | undefined> {
  const key = routineKey(r);
  const holder = () => [...live.values()].find((x) => ACTIVE.has(x.status) && routineKey(x.routine) === key);
  const end = Date.now() + QUEUE_MS;
  for (let h = holder(); h; h = holder()) {
    if (Date.now() > end) return `${r.meta.name} is already running${h.by ? ` for ${h.by}` : ''}${h.status === 'running' ? '' : ' and waiting for an answer'}. Only one run of a routine goes at a time. Try again when it has finished.${h.session && h.session === session ? ' That run is yours: continue or stop it with routine_resume.' : ''}`;
    await sleep(500);
  }
  return undefined;
}

export async function start(p: { routine: Routine; params: Record<string, string>; secrets: Record<string, string>; flight?: boolean; agent?: string; session?: string; test?: boolean; foreign?: boolean; fit?: boolean }) {
  if (p.routine.meta.surface && p.routine.meta.surface !== 'browser')
    return { run_id: 'rp-none', status: 'failed', routine: p.routine.meta.name, version: p.routine.meta.version, steps_run: 0, steps_total: p.routine.steps.length, model_calls: 0, ms: 0, error: `This routine acts on the ${p.routine.meta.surface}, which this version cannot control. Only browser routines run.`, fixes: {}, crops: {} } as ReturnType<typeof result>;
  const busy = await waitForRoutine(p.routine, p.session);
  if (busy) return { run_id: 'rp-none', status: 'failed', routine: p.routine.meta.name, version: p.routine.meta.version, steps_run: 0, steps_total: p.routine.steps.length, model_calls: 0, ms: 0, error: busy, fixes: {}, crops: {} } as ReturnType<typeof result>;
  const s: ReplayState = {
    id: 'rp-' + crypto.randomUUID().slice(0, 4),
    routine: p.routine,
    params: p.params,
    secrets: p.secrets,
    tabId: await agentTabId(p.session),
    i: 0,
    approved: new Set(),
    approvedInPanel: [],
    modelCalls: 0,
    fixes: {},
    crops: {},
    read: {},
    start: Date.now(),
    status: 'running',
    by: p.agent,
    session: p.session,
    test: p.test,
    skipped: [],
    trace: [],
    hooks: await hooks.forRoutine(p.routine),
    foreign: !!p.foreign,
    flightForRun: !!p.flight,
    forcedPauses: [],
    jumps: {},
    loops: [],
    branches: [],
    fitWindow: p.fit,
    stepMs: {},
  };
  if (p.flight && !flightOn(s.tabId)) {
    try {
      startFlight(s.tabId);
    } catch {
      // Firefox: the run goes on without it.
      s.flightForRun = false;
    }
  } else s.flightForRun = false;
  // Attached before the first step, so the bar this puts up has already moved the page before anything is measured.
  await platform.cdp?.(s.tabId, async () => {}).catch(() => {});
  live.set(s.id, s);
  await fitWindow(s);
  return loop(s);
}

export async function resume(p: { run_id: string; approve?: boolean; choice?: string }) {
  const s = live.get(p.run_id);
  if (!s) throw new Error(`No paused run ${p.run_id}`);
  s.handedBack = false;
  if (s.status === 'paused') {
    if (s.pauseKind === 'forced' && p.approve !== false) {
      throw new Error('This step looks irreversible and the routine is from someone else, so only the user can approve it, in the Agentic Routines side panel. Ask them; do not approve it for them.');
    }
    if (p.approve === false) {
      s.status = 'failed';
      s.error = 'Stopped at the pause';
      end(s);
      notify(s);
      return result(s);
    }
    s.approved.add(s.routine.steps[s.i].n);
    s.hookApproved = s.routine.steps[s.i].n;
    return loop(s);
  }
  if (s.status === 'needs_choice') {
    if (!p.choice) {
      s.status = 'failed';
      s.error = 'Stopped where the page changed';
      end(s);
      notify(s);
      return result(s);
    }
    const d = await ask<{ loc: Locator }>(s.tabId, { t: 'describe', ref: p.choice });
    const step = s.routine.steps[s.i];
    // An element picked in place of the recorded one gets the same look a recorded step does.
    if (!step.pause && isIrreversible({ action: step.action, target: d.loc })) s.chosenAt = step.n;
    s.fixes[step.n] = d.loc;
    s.modelCalls++;
    s.candidates = undefined;
    return loop(s, p.choice);
  }
  throw new Error(`Run ${p.run_id} is ${s.status}`);
}

const AGENT_GONE = 'The agent that started this replay disconnected';
const goneSessions = new Set<string>();

/** Nobody is left to answer a pause or a changed step, so the replay ends. A running one ends at its next pause. */
export function agentGone(session: string) {
  goneSessions.add(session);
  for (const s of live.values()) {
    if (s.session !== session || (s.status !== 'paused' && s.status !== 'needs_choice')) continue;
    s.status = 'failed';
    s.error = AGENT_GONE;
    end(s);
    notify(s);
    panelWaiters.get(s.id)?.(false);
  }
}

/** Approve or stop from the side panel. */
export function panelDecide(id: string, approve: boolean) {
  panelWaiters.get(id)?.(approve);
}

/** Drop a run that stopped where the page changed. */
/** The person took the tab back: a run on it stops. */
export function stopOnTab(tabId: number) {
  for (const s of live.values()) if (s.tabId === tabId) stop(s.id);
}

export function stop(id: string) {
  const s = live.get(id);
  if (!s) return;
  if (panelWaiters.has(id)) return panelWaiters.get(id)!(false);
  s.status = 'failed';
  s.error = 'Stopped in the side panel';
  end(s);
  cancelHandoff(s.tabId);
  notify(s);
}
