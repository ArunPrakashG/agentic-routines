import { fastProgram, fastStops, onSite, type FastFrom, type Routine } from '@agentic-routines/core';

// A run through the routine's compiled Playwright code. Compiled here and now from the steps that are installed. Nothing that
// came with an upload is ever run: fastProgram has only the steps to go on, and puts what is in them into the code as strings.
//
// This saves time and not tokens: a normal replay already calls no model. It stops at every step that waits for a person, and
// on anything it cannot do it hands over to the replay at that step, which has the usual checks and can ask for a choice.

/** Off the routine's site, at a step that waits for a person, or not something this way of running can do. */
class Stop extends Error {}

const ACTION_MS = 8000;

function originOf(u: string) {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

function mayBeOn(r: Routine, foreign: boolean, url: string) {
  if (!/^https?:/i.test(url)) return false;
  if (onSite(url, r.meta.site)) return true;
  if (foreign) return false;
  return r.steps.some((s) => [s.url, s.page?.url].some((u) => u && !u.includes('{{') && originOf(u) === originOf(url)));
}

/** Says where the replay should take over. Past the last step when all of it ran, and the replay then only checks the outcome and records it. */
export async function fastRun(r: Routine, params: Record<string, string>, foreign: boolean, endpoint: () => Promise<{ endpoint: string; url?: string }>): Promise<FastFrom> {
  const began = Date.now();
  const state: { params: Record<string, string>; read: Record<string, string>; loop?: FastFrom['loop'] } = { params: { ...params }, read: {} };
  let at = r.steps[0]?.n ?? 1;
  let ran = 0;
  const handOver = (why: string): FastFrom => ({ n: at, loop: state.loop, params: state.params, read: state.read, steps_run: ran, ms: Date.now() - began, why });
  if (r.meta.hooks && Object.keys(r.meta.hooks).length) return handOver('The routine has hooks, which only the replay runs.');
  let browser: import('playwright-core').Browser | undefined;
  try {
    const { chromium } = await import('playwright-core');
    const e = await endpoint();
    browser = await chromium.connectOverCDP(e.endpoint);
    const pages = browser.contexts()[0].pages();
    const page = pages.find((p) => p.url() === e.url) ?? pages[0];
    if (!page) return handOver('The session has no page.');
    page.setDefaultTimeout(ACTION_MS);
    const stops = fastStops(r, foreign);
    const step = async (n: number, o?: { url?: string; pause?: boolean }) => {
      at = n;
      if (o?.pause || stops.has(n)) throw new Stop(`Step ${n} waits for a person, or for something only the replay holds.`);
      const url = o?.url ?? page.url();
      // The first step of a routine can come from a blank tab, and the next will say if it went nowhere.
      if ((o?.url || url !== 'about:blank') && !mayBeOn(r, foreign, url)) throw new Stop(`Step ${n} is off the routine's site.`);
      ran++;
    };
    const secret = () => {
      throw new Stop(`Step ${at} uses a secret, which only the replay holds.`);
    };
    // Only what fastProgram wrote. See the top of this file, and of core/playwright.ts.
    const run = new Function(fastProgram(r, foreign))() as (page: unknown, state: unknown, at: typeof step, secret: () => never) => Promise<void>;
    await run(page, state, step, secret);
    return { n: 0, params: state.params, read: state.read, steps_run: ran, ms: Date.now() - began };
  } catch (e) {
    // Not the message: what Playwright says can quote the page, and this goes to the agent as if it were ours.
    const why = e instanceof Stop ? e.message : `Step ${at} ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'did not work this way'}.`;
    // It counted as run when it began.
    if (!(e instanceof Stop)) ran = Math.max(0, ran - 1);
    return handOver(why);
  } finally {
    await browser?.close().catch(() => {});
  }
}
