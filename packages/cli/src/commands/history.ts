import { readFile } from 'node:fs/promises';
import { historyDays, historyFile, historyOn, setHistory, type HistoryEntry } from '../history.ts';
import { paths } from '../paths.ts';

// `history on|off|status` turns the lasting history on or off; `history show` reads it.

function show(e: HistoryEntry): string {
  const time = e.ts.slice(0, 19).replace('T', ' ');
  if (e.kind === 'tool') return `${time} ${e.ok ? '✓' : '✗'} ${e.agent ?? '?'} ${e.name} ${e.ms}ms${e.out ? `  ${e.out}` : ''}`;
  const what = e.target ? ` ${e.target.role ?? e.target.tag ?? ''}${e.target.name ? ` "${e.target.name}"` : ''}` : '';
  const to = e.navigatedTo && e.navigatedTo !== e.url ? ` → ${e.navigatedTo}` : '';
  return `${time}   ${e.source} ${e.action}${what} @ ${e.url}${to}`;
}

export async function runHistory(args: string[]): Promise<void> {
  const [what = 'status'] = args;
  if (what === 'on' || what === 'off') {
    setHistory(what === 'on');
    console.log(what === 'on' ? `History on. Every tool call and browser step is kept in ${paths.history()}, one file per day.` : 'History off. What is already kept stays until you remove the folder.');
    return;
  }
  if (what === 'status') {
    const days = historyDays();
    const state = historyOn() ? 'on' : `off${process.env.AGENTIC_ROUTINES_HISTORY ? ' (AGENTIC_ROUTINES_HISTORY is set)' : ''}`;
    console.log(`History: ${state}. ${days.length ? `${days.length} day(s), ${days[0]} to ${days.at(-1)}` : 'Nothing kept yet'}. Folder: ${paths.history()}`);
    return;
  }
  if (what === 'show') {
    const raw = args.includes('--raw');
    const steps = args.includes('--steps');
    const tools = args.includes('--tools');
    const n = Number(args[args.indexOf('-n') + 1]) || 60;
    const lines: string[] = [];
    for (const day of historyDays().reverse()) {
      const text = await readFile(historyFile(day), 'utf8').catch(() => '');
      lines.unshift(...text.split('\n').filter(Boolean));
      if (lines.length >= n * 4) break;
    }
    const out: string[] = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as HistoryEntry;
        if ((steps && e.kind !== 'step') || (tools && e.kind !== 'tool')) continue;
        out.push(raw ? l : show(e));
      } catch {
        // A line cut short.
      }
    }
    for (const l of out.slice(-n)) console.log(l);
    if (!out.length) console.log('Nothing kept yet.');
    return;
  }
  console.error('Usage: agentic-routines history [on|off|status|show [-n 100] [--steps|--tools] [--raw]]');
  process.exit(1);
}
