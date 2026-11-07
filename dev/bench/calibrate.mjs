// Works out the numbers behind the savings estimate in packages/core/src/savings.ts from the benchmark results.
// Usage: node dev/bench/calibrate.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'results');
const rows = readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).flatMap((f) => readFileSync(join(DIR, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => ({ file: f, ...JSON.parse(l) })));
const median = (a) => {
  const s = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2) : NaN;
};
const NOT_STEPS = /read_page|screenshot|get_page_text|find$|find_|ToolSearch|routines_|routine_|run_steps|tabs|Skill|wait|read_console|read_network/;
const stepsIn = (r) => Object.entries(r.names ?? {}).filter(([k]) => !NOT_STEPS.test(k)).reduce((n, [, v]) => n + v, 0);

// What one task costs by hand and by replay. The task's name is in the row, or in the arm for the older files.
const pairs = new Map();
for (const r of rows.filter((x) => x.ok !== false)) {
  const task = r.task ?? r.arm.split('-').slice(1).join('-').replace(/^ytlist$/, 'yt');
  const arm = r.task ? r.arm : r.arm.split('-')[0];
  const kind = arm === 'hand' || arm === 'cic' ? 'hand' : arm === 'replay' ? 'replay' : arm === 'record' ? 'record' : '';
  if (!kind) continue;
  const p = pairs.get(task) ?? { hand: [], replay: [], record: [] };
  p[kind].push(r);
  pairs.set(task, p);
}

const out = [];
for (const [task, p] of pairs) {
  if (!p.hand.length || !p.replay.length) continue;
  const m = (k, f) => median(p[k].map(f));
  out.push({
    task,
    n: `${p.hand.length}/${p.replay.length}`,
    steps: m('hand', stepsIn),
    tools: m('hand', (r) => r.tools),
    hand: m('hand', (r) => r.total_tokens),
    replay: m('replay', (r) => r.total_tokens),
    saved: m('hand', (r) => r.total_tokens) - m('replay', (r) => r.total_tokens),
    savedUsd: m('hand', (r) => r.cost_usd) - m('replay', (r) => r.cost_usd),
    handMs: m('hand', (r) => r.wall_ms),
    replayMs: m('replay', (r) => r.wall_ms),
    record: p.record.length ? m('record', (r) => r.total_tokens) : undefined,
  });
}
console.table(out);

// saved tokens = perStep * steps - fixed, least squares over the tasks.
const fit = (y) => {
  const xs = out.map((o) => o.steps);
  const ys = out.map(y);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const k = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return { perStep: k, fixed: k * mx - my };
};
console.log('tokens saved per run =', fit((o) => o.saved));
console.log('dollars saved per run =', fit((o) => o.savedUsd));
const rec = out.filter((o) => o.record);
console.log('recording tokens over a run by hand, median ratio =', median(rec.map((o) => o.record / o.hand)), 'from', rec.length, 'tasks');
console.log('recording extra tokens, median =', median(rec.map((o) => o.record - o.hand)));
const time = (() => {
  const saved = fit((o) => o.handMs);
  return { perStep: saved.perStep, base: -saved.fixed };
})();
console.log('milliseconds a run takes by hand =', time);
