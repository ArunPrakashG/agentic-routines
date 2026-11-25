import { isBlock } from './blocks.ts';
import type { Step } from './types.ts';
import { globOf } from './urls.ts';

// Where a routine starts and where it leaves the tab, so an agent can put small routines one after another.
// None of it is enforced: a routine still runs from wherever the tab is. It is what the agent is told, so it can
// choose the order, open the right page first, or pick the routine that gets it there.

export interface Chain {
  /** The first step opens this page itself, so the routine can start from anywhere. */
  opens?: string;
  /** The first step acts on this page without opening it: the tab has to be there already. */
  startsOn?: string;
  /** Where the tab was when runs of it finished, the most common one. */
  endsOn?: string;
  /** Set when endsOn is only the page the last step acts on: no run has said where it ends yet. */
  endGuessed?: boolean;
}

/** Ends of finished runs, as globs, newest last. Only clean runs say where the routine ends. */
export type RunEnds = { ok: boolean; end?: string }[];

const firstStep = (steps: Step[]) => steps.find((s) => !isBlock(s));

/** Where a routine starts and ends, from its steps and, when it has run, from where its runs ended. */
export function chainOf(steps: Step[], runs: RunEnds = []): Chain {
  const out: Chain = {};
  const first = firstStep(steps);
  if (first?.action === 'navigate' && first.url) out.opens = globOf(first.url) ?? undefined;
  else if (first?.page?.url) out.startsOn = globOf(first.page.url) ?? undefined;

  const count = new Map<string, number>();
  for (const r of runs.slice(-20)) if (r.ok && r.end) count.set(r.end, (count.get(r.end) ?? 0) + 1);
  const seen = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (seen) out.endsOn = seen;
  else {
    const last = [...steps].reverse().find((s) => !isBlock(s));
    const at = last?.action === 'navigate' ? last.url : last?.page?.url;
    const g = at ? globOf(at) : null;
    if (g) {
      out.endsOn = g;
      out.endGuessed = true;
    }
  }
  return out;
}

/** Whether two page globs can name the same page: segment by segment, with * for one and a final ** for the rest. */
export function globsMeet(a: string, b: string): boolean {
  const x = a.toLowerCase().split('/');
  const y = b.toLowerCase().split('/');
  if (x[0] !== y[0]) return false;
  for (let i = 1; i < Math.max(x.length, y.length); i++) {
    if (x[i] === '**' || y[i] === '**') return true;
    if (x[i] === undefined || y[i] === undefined) return false;
    if (x[i] !== y[i] && x[i] !== '*' && y[i] !== '*') return false;
  }
  return true;
}

/** Whether a routine that starts on `glob` can start on the page at `url`. */
export function startsAt(glob: string | undefined, url: string | undefined): boolean {
  if (!glob || !url) return false;
  const g = globOf(url);
  return !!g && globsMeet(glob, g);
}

/**
 * Whether the tab at `current` is already the page `target` opens: same address and path, and every query value
 * the target sets is there. A routine run after another can then work on the page as that one left it.
 */
export function samePage(current: string | undefined, target: string | undefined): boolean {
  if (!current || !target) return false;
  try {
    const a = new URL(current);
    const b = new URL(target);
    const path = (u: URL) => u.pathname.replace(/\/+$/, '') || '/';
    if (a.origin !== b.origin || path(a) !== path(b)) return false;
    for (const [k, v] of b.searchParams) if (a.searchParams.get(k) !== v) return false;
    return true;
  } catch {
    return false;
  }
}
