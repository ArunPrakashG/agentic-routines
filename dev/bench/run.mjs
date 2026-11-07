// Runs real Claude Code (claude -p) against the bench site and records what each run cost.
//   node dev/bench/run.mjs --arms replay-small,cic-small --reps 3 --tag full
// Arms: cic-* Claude in Chrome by hand, tools-* our browser tools by hand, record-* by hand then
// routine_save, replay-* the saved routine, changed-* the saved routine with a renamed button,
// idle-* no task, to show what Claude Code costs before any browser work.
// The side panel's pause is approved at once, so human waiting is not counted.
// yt arms edit a real video in the real Chrome, with our extension loaded there and its own store.
// BENCH_VIDEO names that video, so its id stays out of the repo.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const BENCH = join(ROOT, '.dev/bench');
const STORE = join(BENCH, 'env/store');
const CDP = `http://127.0.0.1:${process.env.AR_CDP_PORT ?? 9333}`;
const REAL_STORE = join(BENCH, 'real/store');
const VIDEO = process.env.BENCH_VIDEO;
const WORK = join(BENCH, 'workspace');
const SNAP = join(BENCH, 'routines');
const BASE = 'http://127.0.0.1:8766';
const EXT = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo';
const MODEL = process.env.BENCH_MODEL ?? 'sonnet';
const opt = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const ARMS = opt('--arms', '').split(',').filter(Boolean);
const REPS = Number(opt('--reps', '1'));
const TAG = opt('--tag', 'run');
const RESULTS = join(HERE, 'results', `${TAG}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(join(HERE, 'results'), { recursive: true });
mkdirSync(join(BENCH, 'raw'), { recursive: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(SNAP, { recursive: true });
cpSync(join(ROOT, 'dev/fixtures'), WORK, { recursive: true });

// ---------- tasks ----------
const v2 = { file: 'kavyam-2.15.0.aab', size: 28, name: '2.15.0 (215)', notes: 'Dark mode for the reader.' };
const v1 = { file: 'kavyam-2.14.0.aab', size: 21, name: '2.14.0 (214)', notes: 'Faster search.' };
const LISTS = ['QA team', 'Beta Kerala', 'Staff'];
const COUNTRIES = ['India', 'United Arab Emirates', 'Qatar', 'Kuwait', 'Oman'];
const ask = {
  small: (v) => `Open ${BASE}/small/ in the browser and release ${join(WORK, v.file)} to internal testing for the Kavyam app. Release name ${v.name}, notes: ${v.notes} Start the rollout.`,
  console: (v) =>
    `Open ${BASE}/console/ in the browser and release ${join(WORK, v.file)} to internal testing for the Kavyam app. Release name ${v.name}, notes: ${v.notes} ` +
    `Tester lists: ${LISTS.join(', ')}. Feedback URL https://acme.test/feedback. Countries: ${COUNTRIES.join(', ')}. Rollout percentage 20%. Release owner Meera, ticket REL-214, tick "I have tested this build". Start the rollout.`,
};
ask.yt = (v) => `In YouTube Studio (https://studio.youtube.com) find my most recent unlisted video and set its description to exactly "${v.desc}", without the quotes. Save the change.`;
// Read from the public watch page, so a run's own claim of success does not count. Studio's save takes a moment to reach it.
ask.ytlist = ask.yt;
async function verifyYt(v) {
  let got;
  for (let i = 0; i < 18; i++) {
    try {
      const html = await (await fetch(`https://www.youtube.com/watch?v=${VIDEO}`, { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' } })).text();
      got = JSON.parse(`"${html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ''}"`);
      if (got === v.desc) return '';
    } catch (e) {
      got = `fetch failed: ${e.message}`;
    }
    await sleep(5000);
  }
  return `description is ${JSON.stringify(got)}`;
}
const sameSet = (a = [], b = []) => a.length === b.length && b.every((x) => a.includes(x));
function verify(task, v, log) {
  if (log.length !== 1) return `${log.length} rollouts`;
  const r = log[0];
  const bad = [];
  if (r.file !== v.file || r.size !== v.size) bad.push(`file ${r.file} ${r.size}`);
  if (r.name !== v.name) bad.push(`name ${r.name}`);
  if ((r.notes ?? '').replace(/\.$/, '') !== v.notes.replace(/\.$/, '')) bad.push(`notes ${r.notes}`);
  if (task === 'console') {
    if (!sameSet(r.lists, LISTS)) bad.push(`lists ${r.lists}`);
    if (!sameSet(r.countries, COUNTRIES)) bad.push(`countries ${r.countries}`);
    if (r.feedback !== 'https://acme.test/feedback') bad.push(`feedback ${r.feedback}`);
    if (r.pct !== '20%') bad.push(`pct ${r.pct}`);
    if (r.owner !== 'Meera') bad.push(`owner ${r.owner}`);
    if (r.ticket !== 'REL-214') bad.push(`ticket ${r.ticket}`);
    if (r.ack !== true) bad.push('not acknowledged');
  }
  return bad.join('; ');
}

// ---------- agents ----------
const node = process.execPath;
const servers = {
  ours: { mcpServers: { 'agentic-routines': { type: 'stdio', command: node, args: [join(ROOT, 'packages/cli/dist/index.js'), 'mcp'], env: { AGENTIC_ROUTINES_HOME: STORE } } } },
  real: { mcpServers: { 'agentic-routines': { type: 'stdio', command: node, args: [join(ROOT, 'packages/cli/dist/index.js'), 'mcp'], env: { AGENTIC_ROUTINES_HOME: REAL_STORE } } } },
};
for (const [k, v] of Object.entries(servers)) writeFileSync(join(BENCH, `mcp-${k}.json`), JSON.stringify(v));

function runClaude(server, prompt, rawFile) {
  // Claude in Chrome comes from --chrome and drives the real Chrome with its extension.
  const browser = server === 'cic' ? ['--chrome', '--allowedTools', 'mcp__claude-in-chrome'] : ['--mcp-config', join(BENCH, `mcp-${server}.json`), '--allowedTools', 'mcp__agentic-routines'];
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...browser, '--strict-mcp-config', '--setting-sources', 'project,local', '--permission-mode', 'default', '--model', MODEL, '--max-budget-usd', '6'];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('claude', args, { cwd: WORK, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += ''));
    const kill = setTimeout(() => p.kill('SIGKILL'), Number(process.env.BENCH_TIMEOUT ?? 600) * 1000);
    p.on('close', (code) => {
      clearTimeout(kill);
      writeFileSync(rawFile, out);
      resolve({ code, wall_ms: Date.now() - t0, lines: out.split('\n').filter(Boolean) });
    });
  });
}

function parse(lines) {
  const turns = new Map();
  let result;
  let tools = 0;
  let toolChars = 0;
  let images = 0;
  let imageChars = 0;
  let engine;
  const names = {};
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'assistant') {
      if (e.message?.usage) turns.set(e.message.id, e.message.usage);
      for (const b of e.message?.content ?? []) {
        if (b.type !== 'tool_use') continue;
        tools++;
        names[b.name] = (names[b.name] ?? 0) + 1;
      }
    } else if (e.type === 'user') {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('');
        for (const c of Array.isArray(b.content) ? b.content : []) {
          if (c.type !== 'image') continue;
          images++;
          imageChars += c.source?.data?.length ?? 0;
        }
        toolChars += text.length;
        const m = text.match(/^Done · .*· (\d+):(\d\d)/m);
        if (m) engine = (Number(m[1]) * 60 + Number(m[2])) * 1000;
      }
    } else if (e.type === 'result') result = e;
  }
  const last = [...turns.values()].pop() ?? {};
  const u = result?.usage ?? {};
  return {
    cost_usd: result?.total_cost_usd,
    duration_ms: result?.duration_ms,
    api_ms: result?.duration_api_ms,
    turns: result?.num_turns,
    is_error: result?.is_error,
    input: u.input_tokens ?? 0,
    cache_write: u.cache_creation_input_tokens ?? 0,
    cache_read: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    total_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
    context_end: (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0),
    tools,
    tool_chars: toolChars,
    images,
    image_chars: imageChars,
    engine_ms: engine,
    names,
    answer: String(result?.result ?? '').slice(0, 300),
  };
}

// ---------- side panel: approves a pause as soon as it shows ----------
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const wait = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m.result);
      wait.delete(m.id);
    }
  };
  return { send: (method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }) };
}
let panel;
async function openPanel() {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const b = await cdp(v.webSocketDebuggerUrl);
  const { targetId } = await b.send('Target.createTarget', { url: `${EXT}/sidepanel.html`, newWindow: true });
  await sleep(800);
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === targetId);
  panel = await cdp(t.webSocketDebuggerUrl);
}
const panelEval = async (expression) => (await panel.send('Runtime.evaluate', { expression, returnByValue: true }))?.result?.value;
function approver() {
  let on = true;
  let approvals = 0;
  (async () => {
    while (on) {
      const hit = await panelEval(`(() => { if (!document.body.innerText.includes('Paused before')) return false; const b = document.querySelector('.btn-primary'); if (!b) return false; b.click(); return true; })()`);
      if (hit) approvals++;
      await sleep(hit ? 500 : 120);
    }
  })();
  return { stop: () => ((on = false), approvals) };
}
const backToRoutines = () => panel && panelEval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Back to routines')); if (b) b.click(); })()`);

// ---------- store ----------
let local = join(STORE, 'routines/local');
function parkRoutines() {
  rmSync(local, { recursive: true, force: true });
  mkdirSync(local, { recursive: true });
}
function restoreRoutine(name) {
  parkRoutines();
  cpSync(join(SNAP, name), join(local, name), { recursive: true });
}

function memoryOk() {
  const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
  return Number(m[1]) / 1024;
}
async function waitForMemory() {
  for (let i = 0; i < 60; i++) {
    if (memoryOk() > 1200) return;
    console.log(`waiting for memory: ${Math.round(memoryOk())} MB free`);
    await sleep(10_000);
  }
  console.log('stopping: not enough memory');
  process.exit(3);
}

// ---------- one run ----------
async function one(arm, rep) {
  const [kind, task] = arm.split('-');
  const yt = task.startsWith('yt');
  const name = task === 'ytlist' ? 'yt-list' : yt ? 'yt-description' : `${task}-release`;
  local = join(yt ? REAL_STORE : STORE, 'routines/local');
  let server = kind === 'cic' ? 'cic' : yt ? 'real' : 'ours';
  let v = yt ? { desc: `Benchmark edit ${TAG} ${arm} ${rep}` } : v2;
  let prompt = ask[task]?.(v);
  let variant = 'a';
  if (kind === 'idle') {
    server = task === 'cic' ? 'cic' : 'ours';
    prompt = 'Reply with the single word ok.';
  } else if (kind === 'record') {
    if (!yt) v = v1;
    prompt = ask[task](v) + (task === 'ytlist' ? ' Find the video through the Filter box on the Content page, choosing Visibility, Unlisted and Apply, not through a filter address.' : '') + ` Then save what you did as a routine named ${name}. Only ${yt ? 'the description' : 'the app bundle, release name and release notes'} should change each run. Everything else stays as you did it.`;
  } else if (kind === 'replay' || kind === 'changed' || kind === 'dialog' || kind === 'field') {
    prompt += ' Use the saved routine.';
    if (kind === 'changed') variant = 'b';
    if (kind === 'dialog') variant = 'c';
    if (kind === 'field') {
      variant = 'd';
      prompt += ' If the console asks for a change window, choose Tonight.';
    }
  }
  if (kind === 'cic' || kind === 'tools' || kind === 'record' || kind === 'idle') parkRoutines();
  else restoreRoutine(name);
  if (!yt) await fetch(`${BASE}/__reset?variant=${variant}`, { method: 'POST' });
  await backToRoutines();
  const a = !yt && (kind === 'replay' || kind === 'changed' || kind === 'dialog' || kind === 'field' || kind === 'record') ? approver() : undefined;
  const raw = join(BENCH, 'raw', `${TAG}-${arm}-${rep}.jsonl`);
  const r = await runClaude(server, prompt, raw);
  const approvals = a?.stop() ?? 0;
  const m = parse(r.lines);
  const problem = kind === 'idle' ? '' : yt ? await verifyYt(v) : verify(task, v, await (await fetch(`${BASE}/__log`)).json());
  const row = { arm, rep, model: MODEL, ok: !problem && !m.is_error, problem, wall_ms: r.wall_ms, exit: r.code, approvals, ...m };
  appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  if (kind === 'record' && row.ok) {
    if (existsSync(join(local, name))) {
      rmSync(join(SNAP, name), { recursive: true, force: true });
      cpSync(join(local, name), join(SNAP, name), { recursive: true });
    } else console.log('record: no routine saved');
  }
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${arm} #${rep} ${(r.wall_ms / 1000).toFixed(1)}s $${(m.cost_usd ?? 0).toFixed(3)} tok=${m.total_tokens} ctx=${m.context_end} tools=${m.tools} chars=${m.tool_chars} images=${m.images} ${problem}`);
}

if (ARMS.some((a) => a.includes('-yt')) && !VIDEO) {
  console.log('Set BENCH_VIDEO to the id of the video the yt arms edit.');
  process.exit(2);
}
if (!ARMS.every((a) => a.includes('-yt'))) await openPanel();
// Round robin, so prompt caching and machine load fall evenly across arms.
for (let rep = 1; rep <= REPS; rep++) {
  for (const arm of ARMS) {
    await waitForMemory();
    await one(arm, rep);
  }
}
process.exit(0);
