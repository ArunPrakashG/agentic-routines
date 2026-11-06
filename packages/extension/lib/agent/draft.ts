import { applyOps, draftFromRoutine, draftFromRun, EditError, finalize, renderDraft, validateRoutine, type Draft, type Op, type Routine, type RunResult } from '@agentic-routines/core';
import * as native from './native';
import * as replay from '../replay/replay';
import * as runs from './runs';

// Drafts of routines being refined. They live here, in the extension, and every edit is checked here:
// the agent asks, and cannot get around the rules by what it says.

const KEEP = 8;
let cache: Draft[] | undefined;

async function load(): Promise<Draft[]> {
  if (!cache) cache = ((await browser.storage.local.get('drafts')).drafts as Draft[] | undefined) ?? [];
  return cache;
}
const persist = () => browser.storage.local.set({ drafts: cache });

async function find(id: string): Promise<Draft> {
  const d = (await load()).find((x) => x.id === id);
  if (!d) throw new Error(`No draft ${id}. Start one with routine_propose.`);
  return d;
}

async function put(d: Draft) {
  const all = await load();
  const i = all.findIndex((x) => x.id === d.id);
  if (i >= 0) all[i] = d;
  else {
    all.unshift(d);
    if (all.length > KEEP) all.length = KEEP;
  }
  await persist();
}

/** Errors the agent should read as the answer, not as a broken tool. */
const asAnswer = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof EditError) throw new Error(e.message);
    throw e;
  }
};

// The side panel's library lists what is in the store, so it hears when an agent saves.
const savedListeners: Array<() => void> = [];
export const onSaved = (fn: () => void) => void savedListeners.push(fn);

export async function handle(method: string, p: any): Promise<unknown> {
  switch (method) {
    case 'draft.propose': {
      const meta = { name: String(p.name), description: String(p.description), doNotUse: p.do_not_use_for as string | undefined };
      let d: Draft;
      if (p.from_routine) {
        const r = await native.call<Routine & { owner: string }>('store.read', { id: p.from_routine });
        d = draftFromRoutine(r, { name: p.name ? meta.name : undefined, description: p.description ? meta.description : undefined, doNotUse: meta.doNotUse });
      } else {
        const run = await runs.get(p.run_id, p.session);
        d = asAnswer(() => draftFromRun(run, meta));
      }
      await put(d);
      return { draft_id: d.id, text: renderDraft(d) };
    }
    case 'draft.edit': {
      const d = await find(String(p.draft_id));
      const { draft, notes } = asAnswer(() => applyOps(d, p.ops as Op[]));
      await put(draft);
      return { text: `${notes.join('\n')}\n\n${renderDraft(draft)}` };
    }
    case 'draft.show': {
      return { text: renderDraft(await find(String(p.draft_id))) };
    }
    case 'draft.test': {
      const d = await find(String(p.draft_id));
      const { routine } = finalize(d, p.agent);
      const { problems } = validateRoutine(routine);
      if (problems.length) throw new Error(`Cannot test yet. ${problems.join(' ')}`);
      // The values it was recorded with, unless the agent gives others.
      const params: Record<string, string> = {};
      for (const [k, spec] of Object.entries(routine.meta.params)) params[k] = p.params?.[k] ?? spec.example ?? '';
      const missing = Object.keys(params).filter((k) => !params[k]);
      if (missing.length) throw new Error(`The test needs a value for ${missing.join(', ')}. Pass params.`);
      const files = Object.entries(routine.meta.params).filter(([, s]) => s.type === 'file').map(([k]) => params[k]);
      // The caller gets the files and secrets it must provide before the test runs.
      if (p.prepare) return { files, needs: routine.meta.secrets };
      const result = await replay.start({ routine, params, secrets: p.secrets ?? {}, agent: p.agent, session: p.session, test: true });
      const skipped = result.skipped ?? [];
      // A step after one that was skipped may need what the skipped one does, so failing there does not fail the draft.
      const partial = result.status === 'failed' && skipped.length > 0 && (result.at_step ?? 0) > Math.min(...skipped);
      const summary =
        result.status === 'done'
          ? `all ${result.steps_total - skipped.length} steps that can run in a test passed${skipped.length ? `; step ${skipped.join(', ')} pause${skipped.length === 1 ? 's' : ''} in a real run and ${skipped.length === 1 ? 'was' : 'were'} not performed` : ''}`
          : partial
            ? `steps 1–${(result.at_step ?? 1) - 1} passed; step ${result.at_step} follows the skipped step ${Math.min(...skipped)} and may need its result, so it and the steps after it were not checked`
            : `failed at step ${result.at_step ?? '?'}: ${result.error ?? ''}`;
      d.tested = { rev: d.rev, ok: result.status === 'done' || partial, summary, at: Date.now() };
      await put(d);
      return { result };
    }
    case 'draft.save': {
      const d = await find(String(p.draft_id));
      if (p.name) d.name = String(p.name);
      if (p.description) d.description = String(p.description);
      if (p.do_not_use_for) d.doNotUse = String(p.do_not_use_for);
      const { routine, pinned } = finalize(d, p.agent);
      const { problems, warnings } = validateRoutine(routine);
      if (problems.length) throw new Error(`Not saved. ${problems.join(' ')}`);
      // A routine that is already saved is only replaced after the new steps ran well.
      if (d.base && !(d.tested?.ok && d.tested.rev === d.rev)) throw new Error(`Not saved. This replaces ${d.base.name} v${d.base.version}, so test the latest edit first with routine_test${d.tested && d.tested.rev === d.rev ? `. The last test did not pass: ${d.tested.summary}` : ''}.`);
      const saved = await native.call<Routine>('store.write', { routine });
      savedListeners.forEach((fn) => fn());
      if (d.runId) await runs.markSaved(d.runId).catch(() => {});
      const all = await load();
      cache = all.filter((x) => x.id !== d.id);
      await persist();
      return {
        saved: { name: saved.meta.name, version: saved.meta.version, site: saved.meta.site, steps: saved.steps.length, params: Object.keys(saved.meta.params), pauses: saved.meta.pauses, start: saved.steps[0]?.url },
        recorded: d.initial.steps.length,
        tested: d.tested && d.tested.rev === d.rev ? d.tested.summary : undefined,
        warnings,
        pinned,
      };
    }
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

export type { RunResult };
