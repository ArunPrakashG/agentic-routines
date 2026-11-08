import type { ParamSpec, Step } from './types.ts';

// A routine stays a flat list of steps, numbered in the order they read. A step can say that the next ones repeat,
// or that they only run sometimes. Everything else about a step, its checks and its pause included, is unchanged.

export const MAX_LOOP = 100;
export const DEFAULT_LOOP = 25;
const MAX_WHEN_TEXT = 300;

export const isBlock = (s: Pick<Step, 'action'>) => s.action === 'each' || s.action === 'if';

/** The steps a block covers, as indexes into the list: [first, end). */
export function spanOf(s: Step, i: number): [number, number] {
  const n = s.action === 'each' ? (s.each?.count ?? 0) : (s.when?.then ?? 0) + (s.when?.else ?? 0);
  return [i + 1, i + 1 + n];
}

/** The values one param gives a loop: one per line, or separated by commas when it is all on one line. */
export function loopValues(raw: string): string[] {
  return raw.split(raw.includes('\n') ? /\r?\n/ : ',').map((v) => v.trim()).filter(Boolean);
}

const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** What is wrong with a routine's loops and branches. Nothing, for one that has none. */
export function blockProblems(steps: Step[], params: Record<string, ParamSpec>): string[] {
  const out: string[] = [];
  const spans: { n: number; at: number; z: number; loop: boolean; arms: [number, number][] }[] = [];
  steps.forEach((s, i) => {
    if (s.action === 'each') {
      const e = s.each;
      if (!e || !whole(e.count) || e.count < 1) out.push(`Step ${s.n} repeats no steps.`);
      else if (!!e.param === !!e.matching) out.push(`Step ${s.n} repeats for a parameter or for elements on the page, one of the two.`);
      else if (e.param && params[e.param]?.type !== 'string') out.push(`Step ${s.n} repeats for ${e.param}, which is not a parameter that takes text.`);
      if (e && (!whole(e.limit) || e.limit < 1 || e.limit > MAX_LOOP)) out.push(`Step ${s.n} has a limit outside 1 to ${MAX_LOOP}.`);
    }
    if (s.action === 'if') {
      const w = s.when;
      if (!w || !whole(w.then) || !whole(w.else) || w.then + w.else < 1) out.push(`Step ${s.n} decides between no steps.`);
      else if (!w.text && !w.has) out.push(`Step ${s.n} has nothing to look for.`);
      if ((w?.text?.length ?? 0) > MAX_WHEN_TEXT) out.push(`Step ${s.n} looks for text over ${MAX_WHEN_TEXT} characters.`);
    }
    if (isBlock(s)) {
      const [a, z] = spanOf(s, i);
      if (z > steps.length) out.push(`Step ${s.n} covers steps past the end of the routine.`);
      spans.push({ n: s.n, at: i, z, loop: s.action === 'each', arms: s.action === 'each' ? [[a, z]] : [[a, a + (s.when?.then ?? 0)], [a + (s.when?.then ?? 0), z]] });
    }
  });
  // A block that starts inside another, or inside one way of a branch, ends there too.
  for (const x of spans) {
    for (const y of spans) {
      const arm = x.arms.find(([p, q]) => p <= y.at && y.at < q);
      if (!arm) continue;
      if (y.z > arm[1]) out.push(`Step ${y.n} runs past the end of what step ${x.n} covers. One has to be wholly inside the other.`);
      if (x.loop && y.loop) out.push(`Step ${y.n} is a loop inside the loop at step ${x.n}, which a routine cannot do.`);
    }
  }
  steps.forEach((s, i) => {
    if (s.pick !== 'each') return;
    const inLoop = steps.some((h, j) => h.action === 'each' && !!h.each?.matching && i >= j + 1 && i < spanOf(h, j)[1]);
    if (!inLoop) out.push(`Step ${s.n} takes each element in turn but is not inside a loop over elements.`);
  });
  return [...new Set(out)];
}
