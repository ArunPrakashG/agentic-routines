// Everyday chores on real sites, in the person's own Chrome with their sign-ins. Read-only tasks.
//   node dev/bench/real.mjs --tasks release,issue,ci,gmail --reps 5 --tag real-sites
// Per task and per repeat i: Claude in Chrome by hand, then the saved routine on a different value.
// One extra run first records the routine (our tools by hand, then routine_save), so the cost of
// recording is counted and the total over N repeats can be compared.
// A routine pauses before a step that looks irreversible, and nobody is at the panel, so the prompt
// tells the agent the pause is approved in advance; that extra tool call is part of the replay cost.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const BENCH = join(ROOT, '.dev/bench');
const LOCAL = join(homedir(), '.agentic-routines/routines/local');
const opt = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const TASKS = opt('--tasks', 'release').split(',');
const REPS = Number(opt('--reps', '5'));
const TAG = opt('--tag', 'real-sites');
const MODEL = process.env.BENCH_MODEL ?? 'sonnet';
const RESULTS = join(HERE, 'results', `${TAG}.jsonl`);
mkdirSync(join(HERE, 'results'), { recursive: true });
mkdirSync(join(BENCH, 'raw'), { recursive: true });
mkdirSync(join(BENCH, 'work'), { recursive: true });

const gh = (path, q) => {
  const out = execFileSync('gh', ['api', path, ...(q ? ['-q', q] : [])], { encoding: 'utf8' }).trim();
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
};
const REPOS = ['cli/cli', 'BurntSushi/ripgrep', 'sharkdp/fd', 'junegunn/fzf', 'neovim/neovim', 'jesseduffield/lazygit']; // the last one is for recording
const SENDERS = ['GitHub', 'Google', 'Cloudflare', 'Anthropic', 'LinkedIn', 'Vercel'];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const TASK = {
  release: {
    values: REPOS,
    ask: (v) => `On GitHub, find the latest release of ${v}. Tell me its tag and the date it was published.`,
    check: (v, a) => {
      const tag = gh(`repos/${v}/releases/latest`, '.tag_name');
      return norm(a).includes(norm(tag)) ? '' : `answer lacks tag ${tag}`;
    },
  },
  issue: {
    values: REPOS,
    ask: (v) => `On GitHub, open the issues of ${v}. Tell me the title of the newest open issue and who opened it.`,
    check: (v, a) => {
      const top = gh(`repos/${v}/issues?state=open&sort=created&direction=desc&per_page=8`).filter((i) => !i.pull_request).slice(0, 3);
      return top.some((i) => norm(a).includes(norm(i.title).slice(0, 25))) ? '' : `answer matches none of ${top.map((i) => i.title.slice(0, 30))}`;
    },
  },
  ci: {
    values: REPOS,
    ask: (v) => `On GitHub, open the Actions tab of ${v}. Tell me the title and the result (success or failure) of the most recent workflow run.`,
    check: (v, a) => {
      const runs = gh(`repos/${v}/actions/runs?per_page=4`, '.workflow_runs').slice(0, 4);
      const hit = runs.find((r) => norm(a).includes(norm(r.display_title).slice(0, 25)));
      return hit ? '' : `answer matches none of ${runs.map((r) => r.display_title.slice(0, 30))}`;
    },
  },
  gmail: {
    values: SENDERS,
    ask: (v) => `In Gmail, search for mail from ${v}. Tell me the subject and date of the newest message.`,
    check: () => '', // no ground truth: compare the by-hand and replay answers by eye
  },
};

// A small run of our tools by hand that reads or tidies the account. Used to verify writes and to clean up.
async function side(prompt) {
  const r = await runClaude('ours', prompt, join(BENCH, 'raw', `${TAG}-side.jsonl`), 'haiku');
  return parse(r.lines).answer;
}
const DAYS = ['2026-12-03', '2026-12-04', '2026-12-07', '2026-12-09', '2026-12-10', '2026-12-14'];
const WRITES = DAYS.map((d, i) => ({
  n: i + 1,
  title: `Bench dentist ${i + 1}`,
  date: d,
  start: `${9 + i}:00`,
  end: `${9 + i}:45`,
  place: ['Kochi', 'Thrissur', 'Kollam', 'Kottayam', 'Alappuzha', 'Pathanamthitta'][i],
  note: `Cleaning, bring the report ${i + 1}.`,
}));
const hay = (s) => norm(s);
Object.assign(TASK, {
  calendar: {
    vary: 'the title, date, times, location and description',
    values: WRITES,
    label: (v) => v.title,
    ask: (v) => `In Google Calendar, create an event titled "${v.title}" on ${v.date} from ${v.start} to ${v.end}, location ${v.place}, description "${v.note}", with a 30 minute notification. Do not invite anyone. Save it.`,
    check: async (v) => {
      const a = await side(`In Google Calendar, find the event titled "${v.title}" around ${v.date} and open it. Tell me its title, date, start and end time, location and description exactly.`);
      const bad = [v.title, v.date.slice(8).replace(/^0/, ''), v.place, 'cleaning'].filter((x) => !hay(a).includes(hay(x)));
      return bad.length ? `event is missing ${bad}: ${a.replace(/\s+/g, ' ').slice(0, 140)}` : '';
    },
    cleanup: () => side('In Google Calendar, delete every event whose title starts with "Bench dentist" (one at a time, from December 2026). Then tell me how many you deleted.'),
  },
  draft: {
    vary: 'the subject and the body',
    values: WRITES,
    label: (v) => `Bench note ${v.n}`,
    ask: (v) => `In Gmail, write a new message to arun.prakash.456789@gmail.com with the subject "Bench note ${v.n}" and this body: "Hi, the appointment is on ${v.date} at ${v.start} in ${v.place}. ${v.note}". Do not send it. Leave it saved as a draft.`,
    check: async (v) => {
      const a = await side(`In Gmail, open Drafts and find the draft with the subject "Bench note ${v.n}". Tell me its recipient, subject and body exactly. Do not send it.`);
      const bad = [`bench note ${v.n}`, v.place, v.date].filter((x) => !hay(a).includes(hay(x)));
      return bad.length ? `draft is missing ${bad}: ${a.replace(/\s+/g, ' ').slice(0, 140)}` : '';
    },
    cleanup: () => side('In Gmail, open Drafts and discard every draft whose subject starts with "Bench note". Then tell me how many you discarded.'),
  },
});

const node = process.execPath;
writeFileSync(join(BENCH, 'mcp-default.json'), JSON.stringify({ mcpServers: { 'agentic-routines': { type: 'stdio', command: node, args: [join(ROOT, 'packages/cli/dist/index.js'), 'mcp'] } } }));

function runClaude(kind, prompt, raw, model = MODEL) {
  const browser = kind === 'cic' ? ['--chrome', '--allowedTools', 'mcp__claude-in-chrome'] : ['--mcp-config', join(BENCH, 'mcp-default.json'), '--allowedTools', 'mcp__agentic-routines'];
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...browser, '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', '--strict-mcp-config', '--setting-sources', 'project,local', '--permission-mode', 'default', '--model', model, '--max-budget-usd', '6'];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('claude', args, { cwd: join(BENCH, 'work'), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const kill = setTimeout(() => p.kill('SIGKILL'), 600_000);
    p.on('close', (code) => {
      clearTimeout(kill);
      writeFileSync(raw, out);
      resolve({ code, wall_ms: Date.now() - t0, lines: out.split('\n').filter(Boolean) });
    });
  });
}

function parse(lines) {
  let result;
  let tools = 0;
  let chars = 0;
  let images = 0;
  const names = {};
  for (const l of lines) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === 'assistant') {
      for (const b of e.message?.content ?? []) if (b.type === 'tool_use') (tools++, (names[b.name] = (names[b.name] ?? 0) + 1));
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== 'tool_result') continue;
        const parts = Array.isArray(b.content) ? b.content : [{ text: String(b.content ?? '') }];
        for (const c of parts) (c.type === 'image' ? images++ : (chars += (c.text ?? '').length));
      }
    } else if (e.type === 'result') result = e;
  }
  const u = result?.usage ?? {};
  return {
    cost_usd: result?.total_cost_usd,
    turns: result?.num_turns,
    is_error: result?.is_error,
    total_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
    output: u.output_tokens ?? 0,
    tools,
    tool_chars: chars,
    images,
    names,
    answer: String(result?.result ?? '').slice(0, 600),
  };
}

mkdirSync(LOCAL, { recursive: true });
const wipe = (name) => rmSync(join(LOCAL, name), { recursive: true, force: true });
const have = (name) => readdirSync(LOCAL).includes(name);
const PRE = ' The person has approved every step in advance. If a routine run pauses before a step, resume it with approve true.';

async function one(task, arm, i) {
  const t = TASK[task];
  const name = `bench-${task}`;
  const v = t.values[arm === 'record' ? t.values.length - 1 : i - 1];
  const label = t.label ? t.label(v) : typeof v === 'string' ? v : v.title;
  let kind = arm === 'hand' ? 'cic' : 'ours';
  let prompt = t.ask(v);
  if (arm === 'record') prompt += ` Then save what you did as a routine named ${name}. Only ${t.vary ?? 'the repository'} should change each run.${PRE}`;
  if (arm === 'replay') prompt += ` Use the saved routine ${name}.${PRE}`;
  const raw = join(BENCH, 'raw', `${TAG}-${task}-${arm}-${i}.jsonl`);
  const r = await runClaude(kind, prompt, raw);
  const m = parse(r.lines);
  let problem = '';
  try {
    problem = await t.check(v, m.answer);
  } catch (e) {
    problem = `check failed: ${e.message}`.slice(0, 120);
  }
  if (arm === 'record' && !have(name)) problem ||= 'no routine saved';
  const row = { task, arm, rep: i, value: label, model: MODEL, ok: !problem && !m.is_error, problem, wall_ms: r.wall_ms, exit: r.code, ...m };
  appendFileSync(RESULTS, JSON.stringify(row) + '\n');
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${task} ${arm} #${i} ${(r.wall_ms / 1000).toFixed(1)}s $${(m.cost_usd ?? 0).toFixed(3)} tok=${m.total_tokens} tools=${m.tools} images=${m.images} ${problem}`);
}

for (const task of TASKS) {
  wipe(`bench-${task}`);
  await one(task, 'record', 0);
  for (let i = 1; i <= REPS; i++) {
    await one(task, 'hand', i);
    await one(task, 'replay', i);
  }
  wipe(`bench-${task}`);
  if (TASK[task].cleanup) console.log('cleanup:', String(await TASK[task].cleanup()).slice(0, 160).replace(/\n/g, ' '));
}
process.exit(0);
