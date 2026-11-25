// Putting routines one after another: each says where it starts and where it leaves the tab, the agent is told
// which routines fit before and after, and a routine run from the wrong page still runs, with a note on how to
// get to its page. Nothing is refused. Usage: dev/e2e/e2e-chain.sh
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const SITE = `http://127.0.0.1:${process.env.AR_SITE_PORT ?? 8765}`;
const HOST = new URL(SITE).host;

const log = (...a) => console.log('·', ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

const client = new Client({ name: 'claude-code', version: '2.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME }, stderr: 'inherit' }));
const tryCall = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return { text: r.content.map((c) => c.text ?? '').join('\n'), error: !!r.isError };
};
const call = async (name, args) => {
  const r = await tryCall(name, args);
  if (r.error) log(`${name} error:`, r.text);
  return r.text;
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/ref_\d+/)?.[0];
const save = async (name, description, params = {}) => {
  const t = await call('routine_propose', { name, description });
  const id = t.match(/Draft (d-[a-z0-9]+)/)?.[1];
  const ops = Object.entries(params).map(([n, value]) => ({ op: 'param', name: n, value }));
  if (ops.length) await call('routine_edit', { draft_id: id, ops });
  return call('routine_save', { draft_id: id });
};

// ---------- three routines, recorded by hand: one gets to the release page, two work on it ----------
await call('navigate', { url: `${SITE}/apps.html` });
let page = await call('read_page');
await call('click', { ref: refFor(page, /“Kavyam”/) });
page = await call('read_page');
check(/Create internal testing release/.test(page), 'reached the release page by hand');
log(await save('chain-open-app', 'Open the Kavyam app in the console. Use when the user wants to work on the Kavyam app.'));

await call('type', { ref: refFor(page, /“Release name”/), text: '1.0 (10)' });
log(await save('chain-fill-name', 'Fill in the release name on the release page. Use when the user names a release.', { release_name: '1.0 (10)' }));

await call('type', { ref: refFor(page, /“Release notes”/), text: 'first notes' });
// Saving always gives a routine a first step that opens its page. A routine written by hand or installed from Git
// can start on a page without opening it: this one is cut down to the typing alone, as such a routine would be.
log(await save('chain-notes', 'Write the release notes on the release page. Use when the user gives release notes.', { notes: 'first notes' }));
{
  const f = join(process.env.AGENTIC_ROUTINES_HOME, 'routines/local/chain-notes/steps.json');
  const steps = JSON.parse(readFileSync(f, 'utf8'));
  const list = Array.isArray(steps) ? steps : steps.steps;
  const rest = list.filter((x, i) => !(i === 0 && x.action === 'navigate')).map((x, i) => ({ ...x, n: i + 1 }));
  writeFileSync(f, JSON.stringify(Array.isArray(steps) ? rest : { ...steps, steps: rest }, null, 2));
  await call('routines_list');
}

// The rt_ tools come a moment after a save.
const toolFor = async (name, ok = () => true) => {
  for (let i = 0; i < 40; i++) {
    const t = (await client.listTools()).tools.find((x) => x.name === name);
    if (t && ok(t)) return t;
    await new Promise((r) => setTimeout(r, 250));
  }
};
const notesTool = await toolFor('rt_chain_notes', (t) => /Starts on/.test(t.description));
const fillTool = await toolFor('rt_chain_fill_name');

// ---------- the agent is told how they fit, before any run ----------
let list = await call('routines_list');
const block = (name) => list.split('\n').reduce((acc, l) => (/^\S/.test(l) ? { on: l.startsWith(name), out: acc.out } : acc.on ? { on: true, out: acc.out + l + '\n' } : acc), { on: false, out: '' }).out;
check(new RegExp(`Starts from any page: it opens ${HOST}/apps\\.html itself`).test(block('chain-open-app')), 'a routine that opens its own page says it starts from anywhere');
check(new RegExp(`Its last step is on ${HOST}/apps\\.html\\.`).test(block('chain-open-app')), 'before it has run, it says where its last step is');
check(new RegExp(`Starts from any page: it opens ${HOST}/release\\.html itself`).test(block('chain-fill-name')), 'so does the routine that opens the release page');
check(new RegExp(`Starts on ${HOST}/release\\.html: the tab should be on that page first`).test(block('chain-notes')), 'a routine that does not open its page says which page it starts on');
check(!!notesTool && /Starts on .*release\.html/.test(notesTool.description), 'the rt_ tool description says where it starts');
check(!!fillTool && !!fillTool.inputSchema?.properties?.keep_page, 'rt_ tools take keep_page');

// ---------- the routine that gets there, then what can follow ----------
let r = await tryCall('rt_chain_open_app', {});
log(r.text.split('\n')[0]);
check(/^Done/.test(r.text), 'the opening routine runs');
check(new RegExp(`The tab is now on .*${HOST}/release\\.html`).test(r.text), 'after it, the agent is told where the tab is');
check(/Routines that start on this page: rt_chain_notes/.test(r.text), 'and which routine starts there');
check(/Routines that open this page: rt_chain_fill_name[^\n]*keep_page: true/.test(r.text), 'and which routine opens that page, with keep_page to keep it');

const field = async (id) => {
  const t = await call('javascript', { code: `'value=[' + document.getElementById(${JSON.stringify(id)}).value + ']'` });
  return (v) => t.includes(`value=[${v}]`);
};
r = await tryCall('rt_chain_notes', { notes: 'kept notes' });
log(r.text.split('\n')[0]);
check(/^Done/.test(r.text), 'on its page, the routine that starts there finishes');

// ---------- keep_page: work on the page as the last routine left it ----------
r = await tryCall('rt_chain_fill_name', { release_name: '2.0 (20)', keep_page: true });
log(r.text.split('\n')[0]);
check(/^Done/.test(r.text) && /did not open it again/.test(r.text), 'with keep_page on its page, the routine leaves out its opening step and says so');
let has = await field('notes');
check(has('kept notes'), 'what the earlier routine typed is still there');
has = await field('rname');
check(has('2.0 (20)'), 'and this routine did its part');

r = await tryCall('rt_chain_fill_name', { release_name: '3.0 (30)' });
check(/^Done/.test(r.text) && !/keep_page/.test(r.text), 'without keep_page, it opens its page as before');
has = await field('notes');
check(!has('kept notes'), 'so the page starts fresh');

await call('navigate', { url: `${SITE}/index.html` });
r = await tryCall('rt_chain_fill_name', { release_name: '4.0 (40)', keep_page: true });
check(/^Done/.test(r.text) && /was not on the page this routine opens, so it opened it/.test(r.text), 'keep_page on another page opens the page as usual');

// ---------- run from the wrong page: it runs anyway, and says how to get there ----------
await call('navigate', { url: `${SITE}/index.html` });
r = await tryCall('rt_chain_notes', { notes: 'x' });
log(r.text.split('\n')[0]);
check(!/^Done/.test(r.text), 'started from the wrong page, the routine was run and could not finish');
check(new RegExp(`This routine starts on ${HOST}/release\\.html, and the tab was on`).test(r.text), 'the result says which page it starts on and where the tab was');
if (!/first run (the routine|one of the routines) that ends? there: [^\n]*rt_chain_open_app/.test(r.text)) log('NOTE:', r.text.split('\n').filter((l) => /starts on/.test(l)).join(' | '));
check(/first run (the routine|one of the routines) that ends? there: [^\n]*rt_chain_open_app/.test(r.text), 'and names the routine that gets there');
const runId = r.text.match(/run_id "([^"]+)"/)?.[1];
if (runId) await tryCall('routine_resume', { run_id: runId, approve: false });

// ---------- where a routine ends is learned from its runs ----------
list = await call('routines_list');
check(new RegExp(`Leaves the tab on ${HOST}/release\\.html\\. .*rt_chain_notes.* can start there`).test(block('chain-open-app')), 'after a run, where it leaves the tab comes from the run, with what can follow');
check(/rt_chain_open_app[^\n]* there: run after [^\n]*keep_page: true/.test(block('chain-fill-name')), 'a routine that opens a page names the ones that end there, and keep_page');
check(/rt_chain_open_app[^\n]* there\./.test(block('chain-notes')), 'the routine that starts there names the one that gets there');
const d = await call('routine_describe', { name: 'chain-notes' });
check(/Putting routines together: Starts on .*release\.html/.test(d), 'routine_describe says it too');
const s = await call('routines_search', { url: `${SITE}/release.html` });
check(/rt_chain_notes[\s\S]*Starts on/.test(s), 'and so does routines_search');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await client.close();
process.exit(failures ? 1 : 0);
