import { createReadStream, existsSync, statSync, watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { debugOn, setDebug, type Entry } from '../debug.ts';
import { paths } from '../paths.ts';

// `debug on|off|status` turns the action log on or off. `logs` reads it.

export function runDebug(args: string[]): void {
  const [what = 'status'] = args;
  if (what === 'on' || what === 'off') {
    setDebug(what === 'on');
    console.log(what === 'on' ? `Debug log on. Every tool call an agent makes is written to ${paths.actions()}.\nRead it with: agentic-routines logs (add -f to follow). No restart needed.` : 'Debug log off.');
  } else if (what === 'status') {
    const via = process.env.AGENTIC_ROUTINES_DEBUG ? 'AGENTIC_ROUTINES_DEBUG is set' : 'turned on with "debug on"';
    console.log(debugOn() ? `Debug log: on (${via}). File: ${paths.actions()}` : 'Debug log: off. Turn on with: agentic-routines debug on');
  } else {
    console.error('Usage: agentic-routines debug [on|off|status]');
    process.exit(1);
  }
}

const time = (ts: string) => ts.slice(11, 23);

function show(e: Entry): string {
  const args = e.args && typeof e.args === 'object' ? Object.entries(e.args).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`).join(' ') : '';
  const who = e.kind === 'tool' ? `${e.agent ?? '?'} ${e.name}` : `    ↳ ${e.name}`;
  const call = e.call ? `#${e.call} ` : '';
  const out = e.out ? `  ${e.out}` : '';
  return `${time(e.ts)} ${e.ok ? '✓' : '✗'} ${call}${who}${args ? ` ${args}` : ''} ${e.ms}ms${out}`;
}

function print(lines: string[], raw: boolean, failed: boolean) {
  for (const l of lines) {
    if (!l) continue;
    try {
      const e = JSON.parse(l) as Entry;
      if (failed && e.ok) continue;
      console.log(raw ? l : show(e));
    } catch {
      // A line cut off by rotation.
    }
  }
}

export async function runLogs(args: string[]): Promise<void> {
  const follow = args.includes('-f') || args.includes('--follow');
  const raw = args.includes('--raw');
  const failed = args.includes('--errors');
  const n = Number(args[args.indexOf('-n') + 1]) || 40;
  const file = paths.actions();
  if (!existsSync(file)) {
    console.log(`Nothing logged yet. ${debugOn() ? 'Debug log is on: make an agent use the browser.' : 'Turn it on with: agentic-routines debug on'}`);
    if (!follow) return;
  }
  let size = 0;
  if (existsSync(file)) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    print(lines.slice(-n - 1), raw, failed);
    size = statSync(file).size;
  }
  if (!follow) return;
  console.error('Following. Ctrl+C to stop.');
  watchFile(file, { interval: 300 }, (cur) => {
    if (cur.size < size) size = 0;
    if (cur.size === size) return;
    let buf = '';
    createReadStream(file, { start: size, end: cur.size - 1, encoding: 'utf8' })
      .on('data', (d) => (buf += d))
      .on('end', () => print(buf.split('\n'), raw, failed));
    size = cur.size;
  });
  process.on('SIGINT', () => {
    unwatchFile(file);
    process.exit(0);
  });
}
