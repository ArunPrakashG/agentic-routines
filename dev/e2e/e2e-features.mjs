// What a routine does for itself over many runs: tidying, nudges, the meter, background runs, loops.
// Started by e2e-features.sh.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const CDP = 'http://127.0.0.1:9338';
const SITE = 'http://127.0.0.1:8772';

let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client;
// A session of its own: what it proposes as a routine is only what it did.
async function session() {
  await client?.close();
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME }, stderr: 'inherit' });
  client = new Client({ name: 'claude-code', version: '2.0.0' });
  await client.connect(transport);
}
await session();
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: !!r.isError, images: r.content.filter((c) => c.type === 'image') };
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/(?:f\d+:)?ref_\d+/)?.[0];
const read = async (args = {}) => (await call('read_page', args)).text;

// What the page says, read the way a test reads it and not through the tools under test.
async function say(id, match = 'trusted.html') {
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes(match));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.getElementById(${JSON.stringify(id)})?.textContent`, returnByValue: true } }));
  });
  ws.close();
  return out.result.result.value;
}


const CHORES = `${SITE}/chores.html`;
const draftOf = (t) => /draft_id "(d-[a-z0-9]+)"/.exec(t)?.[1];
const paramOf = (t) => /Asks each run for: ([a-z0-9_]+)/.exec(t)?.[1];
const flags = (o) => evalIn(`(${JSON.stringify(o)}, Object.entries(${JSON.stringify(o)}).forEach(([k, v]) => v === null ? localStorage.removeItem('chores.' + k) : localStorage.setItem('chores.' + k, v)), location.reload(), true)`, 'chores.html');

// The task by hand: type an item, add it.
async function addByHand(item) {
  await call('navigate', { url: CHORES });
  const page = await read();
  await call('type', { ref: refFor(page, /textbox.*Item/i), text: item });
  await call('click', { ref: refFor(page, /button.*(Add item|Put on)/i) });
}

// ---------- self-tidying ----------
{
  console.log('\n# Self-tidying');
  await session();
  await addByHand('Milk');
  const d = await call('routine_propose', { name: 'add-chore', description: 'Adds an item to the chores list. Use when someone wants a chore added.' });
  const id = draftOf(d.text);
  check(!!id, 'proposed a draft');
  check(/op": "expect"/.test(d.text), 'the proposal says to add a check on the result');
  const name = paramOf(d.text);
  const edited = await call('routine_edit', { draft_id: id, edits: [{ op: 'expect', text: `Added {{${name}}}` }] });
  check(/A finished run should show: Added/.test(edited.text), 'the draft shows the check');
  let t = await call('routine_test', { draft_id: id, params: { [name]: 'Milk' } });
  check(/Test passed/.test(t.text) && /as expected/.test(t.text), `the test looks for the result: ${t.text.slice(0, 120)}`);
  t = await call('routine_save', { draft_id: id });
  check(/Saved add-chore/.test(t.text), 'saved');

  let r = await call('routine_run', { name: 'add-chore', params: { [name]: 'Eggs' } });
  check(/^Done/.test(r.text), `a clean run says Done: ${r.text.slice(0, 80)}`);
  check(!/refine it|stale/i.test(r.text), 'a clean run has nothing to tidy');

  await flags({ lose: '1' });
  r = await call('routine_run', { name: 'add-chore', params: { [name]: 'Tea' } });
  check(/may not have worked/.test(r.text) && /Do not report success/.test(r.text), `steps ran and nothing happened is not a success: ${r.text.slice(0, 140)}`);
  await flags({ lose: null });

  // The button is renamed, so the run stops, the agent chooses, and the routine is fixed.
  const breakAndFix = async (label, value) => {
    await flags({ add: label });
    let x = await call('routine_run', { name: 'add-chore', params: { [name]: value } });
    check(/changed/.test(x.text), `step changed after renaming to ${label}`);
    const page = await read();
    const run = /run_id "(rp-[a-z0-9]+)"/.exec(x.text)?.[1];
    x = await call('routine_resume', { run_id: run, choice: refFor(page, new RegExp(`button.*${label}`)) });
    return x;
  };
  r = await breakAndFix('Put on list', 'Rice');
  check(/routine updated to v/.test(r.text) && /no longer matched/.test(r.text), `the result names the step to refine: ${r.text.slice(0, 200)}`);
  check(!/stale/.test(r.text), 'not stale after two bad runs');
  r = await breakAndFix('Put on the pile', 'Salt');
  check(/stale/.test(r.text), `stale after three runs in a row: ${r.text.slice(-160)}`);
  const listed = await call('routines_list');
  check(/Stale:/.test(listed.text), 'routines_list marks it stale');
  const described = await call('routine_describe', { name: 'add-chore' });
  check(/Stale:/.test(described.text), 'routine_describe marks it stale');

  // A deliberate new version starts clean.
  const again = await call('routine_propose', { name: 'add-chore', description: 'Adds an item to the chores list. Use when someone wants a chore added.', from_routine: 'add-chore' });
  const again_id = draftOf(again.text);
  t = await call('routine_test', { draft_id: again_id, params: { [name]: 'Oil' } });
  check(/Test passed/.test(t.text), `the refined draft passes: ${t.text.slice(0, 120)}`);
  await call('routine_save', { draft_id: again_id });
  check(!/Stale:/.test((await call('routines_list')).text), 'refining clears the stale mark');
  await flags({ add: null });
}

await client.close();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
