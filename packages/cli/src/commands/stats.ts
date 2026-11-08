import { addSavings, HOW_ESTIMATED, noSavings, roughTime, savingsOf, savingsText, type Savings } from '@agentic-routines/core';
import * as store from '../store/routines.ts';

// `stats` is what the routines on this computer have saved. Read from their own folders; nothing is sent anywhere.

const WEEK_MS = 7 * 24 * 60 * 60_000;

function line(v: Savings): string {
  const runs = `${v.runs} run${v.runs === 1 ? '' : 's'}${v.stopped ? `, ${v.stopped} stopped` : ''}`;
  const measured = `took ${roughTime(v.replayMs)}, ${v.calls} model call${v.calls === 1 ? '' : 's'}`;
  return `${runs}, ${measured} (measured). ${savingsText(v)} (estimated)${v.recordings ? `, after ${v.recordings} recording${v.recordings === 1 ? '' : 's'}` : ''}.`;
}

export async function runStats(): Promise<void> {
  const all = await store.list();
  const since = Date.now() - WEEK_MS;
  const week = all.map((r) => savingsOf(r.stats, since)).reduce(addSavings, noSavings());
  console.log(`This week\n  ${line(week)}`);
  const ran = all.filter((r) => r.stats?.recent.length);
  if (ran.length) {
    console.log('\nBy routine, all time');
    for (const r of ran) console.log(`  ${r.owner === store.LOCAL ? '' : `${r.owner}/`}${r.name}: ${line(savingsOf(r.stats))}`);
    const agents = [...new Set(ran.flatMap((r) => r.stats!.recent.map((x) => x.agent ?? 'unknown')))].sort();
    console.log('\nBy agent, this week');
    for (const a of agents) {
      const v = all.map((r) => savingsOf(r.stats, since, (x) => (x.agent ?? 'unknown') === a)).reduce(addSavings, noSavings());
      if (v.runs) console.log(`  ${a}: ${line(v)}`);
    }
  }
  console.log(`\n${HOW_ESTIMATED}`);
}
