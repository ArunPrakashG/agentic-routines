import { siteOf } from './compile.ts';
import { urlPattern } from './match.ts';
import type { RecordedEvent, Run, Step } from './types.ts';

// The same steps a second time, whatever was typed. An agent told so saves the task without being asked.

const MIN_STEPS = 5;
const MIN_ACTS = 2;
const MAX_LOOKED_AT = 300;
const NOISE = new Set(['scroll', 'hover']);
const NOT_ACTS = new Set(['navigate', 'read']);

export interface Repeat {
  /** The same for as long as the repeat goes on, so it is mentioned once. */
  key: string;
  site: string;
  shapes: string[];
  steps: number;
  /** Set when the earlier pass is in this run: the step this pass started at. */
  first?: number;
}

/** What a step is, without what was typed or which row it was. A field is known by its label; a button or a link may be named after the row it is on. */
function shape(action: string, target: Step['target'], url: string | undefined) {
  const who = !target ? '' : action === 'click' || action === 'hover' ? target.role ?? target.tag : `${target.role ?? target.tag}:${target.name ?? ''}`;
  return `${action}|${who}|${urlPattern(url ?? '')}`;
}

interface Shaped {
  key: string;
  /** Tells a retry from another step of the same shape. */
  same: string;
  act: boolean;
  url: string;
  i: number;
}

function shapesOf(events: RecordedEvent[]): Shaped[] {
  const out: Shaped[] = [];
  events.forEach((e, i) => {
    if (NOISE.has(e.action)) return;
    const key = shape(e.action, e.target, e.url);
    const same = `${key}|${e.target?.name ?? ''}`;
    // A retry does not make a task a different task.
    if (out.at(-1)?.same === same) return;
    out.push({ key, same, act: !NOT_ACTS.has(e.action), url: e.url, i });
  });
  return out.slice(-MAX_LOOKED_AT);
}

/** How many steps end the same at these two places, looking back. */
function sameEnding(a: Shaped[], i: number, b: Shaped[], j: number, most: number) {
  let n = 0;
  while (n < most && i - n >= 0 && j - n >= 0 && a[i - n].key === b[j - n].key) n++;
  return n;
}

/** Do the steps that end this run repeat ones earlier in it, or in another recorded run? Too short a task is not worth saying anything about. */
export function findRepeat(current: Run, others: Run[]): Repeat | null {
  const cur = shapesOf(current.events);
  const end = cur.length - 1;
  if (cur.length < MIN_STEPS) return null;
  let best = 0;
  let within = false;
  for (let p = end - 1; p >= 0; p--) {
    const n = sameEnding(cur, end, cur, p, end - p);
    if (n > best) [best, within] = [n, true];
  }
  for (const run of others) {
    const e = shapesOf(run.events);
    for (let p = e.length - 1; p >= 0; p--) {
      const n = sameEnding(cur, end, e, p, Infinity);
      if (n > best) [best, within] = [n, false];
    }
  }
  if (best < MIN_STEPS) return null;
  const tail = cur.slice(-best);
  if (tail.filter((s) => s.act).length < MIN_ACTS) return null;
  return {
    key: tail.slice(0, MIN_STEPS).map((s) => s.key).join('\n'),
    site: siteOf(tail[0].url),
    shapes: tail.map((s) => s.key),
    steps: best,
    ...(within ? { first: tail[0].i + 1 } : {}),
  };
}

/** How much of what was just repeated this routine already does. */
export function shareInRoutine(shapes: string[], steps: Step[]): number {
  const has = new Set(steps.map((s) => shape(s.action, s.target, s.page?.url ?? s.url)));
  return shapes.filter((k) => has.has(k)).length / (shapes.length || 1);
}
