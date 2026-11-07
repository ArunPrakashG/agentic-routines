import type { RecordedEvent, Run } from './types.ts';

// What a routine saves. The replay is measured. What it replaced is estimated, and these say how.
// The numbers come from the benchmark results: node dev/bench/calibrate.mjs prints them. Ten tasks on real sites, Sonnet,
// counting every token the model processed, most of which is context read back from cache at a fraction of the price.

/** A replay saves about this many tokens for each step it does in place of the model. */
export const TOKENS_PER_STEP = 24_400;
/** What a replay still costs: the call, its result and the agent reading it. Short tasks can lose to doing them by hand. */
export const TOKENS_PER_REPLAY = 45_000;
/** Saving a routine costs about this much more than doing the task once: proposing, editing, testing. The median of six tasks. */
export const TOKENS_TO_RECORD = 625_000;
const HAND_MS = 17_500;
const HAND_MS_PER_STEP = 2_500;

export const HOW_ESTIMATED = `Measured: how many replays ran, how long they took and the model calls they needed. Estimated: the rest. About ${Math.round(TOKENS_PER_STEP / 1000)}k tokens for each step a replay does in place of the model, less ${Math.round(TOKENS_PER_REPLAY / 1000)}k for the replay itself, and ${Math.round(TOKENS_TO_RECORD / 1000)}k taken off once for recording a routine. These come from benchmarks on ten tasks, count every token the model processed including cached context, and your tasks will differ. Time saved uses the run a routine was recorded from, or a benchmark figure if that is lower, since a first pass is slower than doing a task you know. Nothing here leaves your computer.`;

export interface ByHand {
  /** How long the recorded steps took. Absent when one step is all there was. */
  ms?: number;
  steps: number;
  at: number;
}

export interface MeteredRun {
  ok: boolean;
  calls: number;
  ms: number;
  at: number;
  steps?: number;
  agent?: string;
}

export interface Metered {
  recent: MeteredRun[];
  byHand?: ByHand;
}

export interface Savings {
  runs: number;
  stopped: number;
  /** Measured. */
  replayMs: number;
  calls: number;
  /** Estimated, and can be below zero: a routine that has not yet paid for recording it. */
  tokens: number;
  ms: number;
  recordings: number;
}

export const noSavings = (): Savings => ({ runs: 0, stopped: 0, replayMs: 0, calls: 0, tokens: 0, ms: 0, recordings: 0 });

export function addSavings(a: Savings, b: Savings): Savings {
  return { runs: a.runs + b.runs, stopped: a.stopped + b.stopped, replayMs: a.replayMs + b.replayMs, calls: a.calls + b.calls, tokens: a.tokens + b.tokens, ms: a.ms + b.ms, recordings: a.recordings + b.recordings };
}

/** What the runs since a moment saved. Recording counts against the time it happened in. */
export function savingsOf(s: Metered | undefined, since = 0, only?: (r: MeteredRun) => boolean): Savings {
  const out = noSavings();
  if (!s) return out;
  for (const r of s.recent) {
    if (r.at < since || (only && !only(r))) continue;
    out.runs++;
    out.replayMs += r.ms;
    out.calls += r.calls;
    if (!r.ok) {
      // It cost its time and its call, and the task still had to be done.
      out.stopped++;
      out.tokens -= TOKENS_PER_REPLAY;
      out.ms -= r.ms;
      continue;
    }
    const steps = s.byHand?.steps ?? r.steps ?? 0;
    const fitted = HAND_MS + HAND_MS_PER_STEP * steps;
    out.tokens += TOKENS_PER_STEP * (steps - r.calls) - TOKENS_PER_REPLAY;
    out.ms += Math.min(s.byHand?.ms ?? fitted, fitted) - r.ms;
  }
  if (!only && s.byHand && s.byHand.at >= since) {
    out.recordings++;
    out.tokens -= TOKENS_TO_RECORD;
  }
  return out;
}

const NOISE = new Set<RecordedEvent['action']>(['scroll', 'hover']);

/** How much of the recorded run the routine stands for. The first pass of something done twice does not count, and clicks replaced by an address still do. */
export function byHandOf(stamps: (number | undefined)[], run: Run, now: number): ByHand | undefined {
  const at = stamps.filter((t): t is number => !!t);
  if (!at.length) return undefined;
  const [a, b] = [Math.min(...at), Math.max(...at)];
  const steps = run.events.filter((e) => e.ts >= a && e.ts <= b && !NOISE.has(e.action)).length;
  return { ...(b - a >= 1000 ? { ms: b - a } : {}), steps, at: now };
}

export const roughTokens = (n: number) => {
  const a = Math.abs(n);
  return a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1000 ? `${Math.round(a / 1000)}k` : `${Math.round(a)}`;
};

export const roughTime = (ms: number) => {
  const a = Math.abs(ms) / 1000;
  return a < 90 ? `${Math.round(a)} s` : a < 5400 ? `${Math.round(a / 60)} min` : `${(a / 3600).toFixed(1)} h`;
};

/** “about 1.2M tokens and 9 min saved”, or what it has not made up yet. */
export function savingsText(v: Savings): string {
  const tokens = v.tokens >= 0 ? `about ${roughTokens(v.tokens)} tokens saved` : `about ${roughTokens(v.tokens)} tokens behind, not paid back yet`;
  const time = v.ms >= 0 ? `about ${roughTime(v.ms)} saved` : `about ${roughTime(v.ms)} lost`;
  return `${tokens}, ${time}`;
}
