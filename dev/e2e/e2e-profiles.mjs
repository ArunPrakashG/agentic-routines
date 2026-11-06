// Two browser profiles sharing one routine store: which one an agent works in, switching, naming, and one run of a
// routine at a time across both. Started by e2e-profiles.sh.
import { mkdirSync, readdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const STORE = process.env.AGENTIC_ROUTINES_HOME;
const DEV = process.env.DEV_DIR;
const A = { cdp: 'http://127.0.0.1:9333', site: 'http://127.0.0.1:8765' };
const B = { cdp: 'http://127.0.0.1:9334', site: 'http://127.0.0.1:8766' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};
const pages = async (b) => (await (await fetch(`${b.cdp}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.url);

const connect = async (env = {}) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: DEV, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: STORE, ...env }, stderr: 'inherit' });
  const client = new Client({ name: 'claude-code', version: '2.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: !!r.isError };
  };
  return { call, close: () => client.close() };
};

// Both browsers have to have said which profile they are.
const hostFiles = () => {
  const dir = join(STORE, 'hosts');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : [];
};
let hosts = [];
for (let i = 0; i < 100; i++) {
  hosts = hostFiles().filter((h) => h.profile);
  if (hosts.length >= 2) break;
  await sleep(200);
}
check(hosts.length === 2 && hosts[0].profile !== hosts[1].profile, 'two hosts registered, each with a profile id of its own');
const [first, second] = [...hosts].sort((x, y) => x.startedAt - y.startedAt);

// ---------- 1. what an agent sees ----------
let agent = await connect();
let r = await agent.call('browser_profile');
const lines = r.text.split('\n');
check(lines.length === 2 && lines.some((l) => l.startsWith('→')), 'browser_profile lists both profiles and marks the one in use after the first call');
r = await agent.call('navigate', { url: `${B.site}/index.html` });
// Nothing chose, so the profile used last (the one that started last here) is it, and the agent is told once.
check(/2 browser profiles are open/.test(r.text) && /browser_profile/.test(r.text), 'the first answer says two profiles are open and how to switch');
check((await pages(B)).some((u) => u.startsWith(B.site)) && !(await pages(A)).some((u) => u.startsWith(B.site)), 'with no choice it works in the profile used last');
r = await agent.call('tabs');
check(!/profiles are open/.test(r.text), 'and does not say it again');

// ---------- 2. switching ----------
const idA = first.profile;
const idB = second.profile;
r = await agent.call('browser_profile', { use: idA });
check(!r.error && new RegExp(`→.*id=${idA}`).test(r.text), 'use <id> switches to that profile');
await agent.call('navigate', { url: `${A.site}/index.html?switched=1` });
check((await pages(A)).some((u) => u.includes('switched=1')) && !(await pages(B)).some((u) => u.includes('switched=1')), 'the next action happens in the profile it switched to');
r = await agent.call('browser_profile', { use: 'no-such-profile' });
check(r.error && /No open browser profile matches/.test(r.text) && /Open now/.test(r.text), 'an unknown profile is a clear error that lists the ones open');

// ---------- 3. names ----------
writeFileSync(join(STORE, 'profiles.json'), JSON.stringify({ [idB]: 'Work' }));
r = await agent.call('browser_profile');
check(/Work/.test(r.text), 'a name given to a profile shows in the list');
r = await agent.call('browser_profile', { use: 'work' });
check(!r.error && new RegExp(`→.*Work`).test(r.text), 'and can be used to pick it, in any case');
await agent.close();

// ---------- 4. chosen up front ----------
agent = await connect({ AGENTIC_ROUTINES_PROFILE: idA });
r = await agent.call('navigate', { url: `${A.site}/index.html?env=1` });
check(!/profiles are open/.test(r.text) && (await pages(A)).some((u) => u.includes('env=1')), 'AGENTIC_ROUTINES_PROFILE picks the profile and there is nothing to be told');
await agent.close();
agent = await connect({ AGENTIC_ROUTINES_PROFILE: 'nobody' });
r = await agent.call('navigate', { url: `${A.site}/index.html` });
check(r.error && /No open browser profile matches “nobody”/.test(r.text), 'a profile that is not open fails with what is open');
await agent.close();

// ---------- 5. one run of a routine at a time, across profiles ----------
agent = await connect({ AGENTIC_ROUTINES_PROFILE: idA, AGENTIC_ROUTINES_LOCK_WAIT_MS: '1500' });
await agent.call('navigate', { url: `${A.site}/index.html` });
await agent.call('read_page');
const proposed = await agent.call('routine_propose', { name: 'open-home', description: 'Open the home page of the test site. Use when the user asks to open the test home page.' });
const draft = proposed.text.match(/Draft (d-[a-z0-9]+)/)?.[1];
const saved = draft ? await agent.call('routine_save', { draft_id: draft }) : proposed;
check(!saved.error && !!draft, 'a routine saved in one profile');
const locks = join(STORE, 'locks');
const held = () => (existsSync(locks) ? readdirSync(locks) : []);

r = await agent.call('routine_run', { name: 'open-home', params: {} });
check(!r.error && held().length === 0, 'a run goes, and leaves no lock behind');

// Another process holds it: the second profile's agent, here stood in for by this process.
mkdirSync(join(locks, 'local__open-home'), { recursive: true });
writeFileSync(join(locks, 'local__open-home', 'holder.json'), JSON.stringify({ pid: process.pid, who: 'codex in Chrome', since: Date.now() }));
r = await agent.call('routine_run', { name: 'open-home', params: {} });
check(r.error && /already running for codex in Chrome/.test(r.text), 'a run waits, then says who has the routine');
writeFileSync(join(locks, 'local__open-home', 'holder.json'), JSON.stringify({ pid: 2 ** 22 + 17, who: 'gone', since: Date.now() }));
r = await agent.call('routine_run', { name: 'open-home', params: {} });
check(!r.error && held().length === 0, 'the lock of a process that is gone does not block the next run');
rmSync(locks, { recursive: true, force: true });
await agent.close();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
