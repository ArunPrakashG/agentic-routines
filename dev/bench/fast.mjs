// Fast run against normal replay, on the same saved routine in the same browser. No model on either side, so this measures
// time only: a replay already costs no tokens, and neither does a fast run. The answer decides whether fast becomes the default.
//   node dev/bench/fast.mjs --routine add_chore --params '{"item":"x"}' --reps 10
// Needs a browser with the extension connected and the routine installed. Each run goes the whole way or stops at its first
// pause. Comparing routines that stop at different steps says nothing, so one without a pause is the fair test.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const opt = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const name = opt('--routine');
if (!name) throw new Error('--routine is needed');
const params = JSON.parse(opt('--params', '{}'));
const reps = Number(opt('--reps', '10'));

const client = new Client({ name: 'bench-fast', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { ...process.env } }));

async function once(fast) {
  const t = Date.now();
  const r = await client.callTool({ name: 'routine_run', arguments: { name, params, fast } });
  const text = r.content.map((c) => c.text ?? '').join('\n');
  return { ms: Date.now() - t, whole: !/Step by step from step/.test(text), failed: !!r.isError || /failed/i.test(text.split('\n')[0]), text };
}

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rows = { normal: [], fast: [] };
// Taking turns, so a page that warms up does not favour whichever went second.
for (let i = 0; i < reps; i++) {
  rows.normal.push(await once(false));
  rows.fast.push(await once(true));
}
await client.close();

for (const [arm, list] of Object.entries(rows)) {
  const ok = list.filter((x) => !x.failed);
  console.log(`${arm}: median ${median(ok.map((x) => x.ms))} ms over ${ok.length} of ${list.length} runs${arm === 'fast' ? `, ${list.filter((x) => x.whole).length} went the whole way through compiled code` : ''}`);
}
const n = median(rows.normal.filter((x) => !x.failed).map((x) => x.ms));
const f = median(rows.fast.filter((x) => !x.failed).map((x) => x.ms));
const saved = 1 - f / n;
console.log(`Fast is ${(saved * 100).toFixed(0)}% faster, and saves no tokens: a replay uses none either way.`);
console.log(saved >= 0.3 ? 'That is worth considering as the default, if it also finished as often.' : 'That is not meaningfully faster. Fast stays an option.');
