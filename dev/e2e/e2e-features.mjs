// What a routine does for itself over many runs: tidying, nudges, the meter, background runs, loops.
// Started by e2e-features.sh.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  // Longer than a replay waits for the side panel at a pause.
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: !!r.isError, images: r.content.filter((c) => c.type === 'image') };
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/(?:f\d+:)?ref_\d+/)?.[0];
const read = async (args = {}) => (await call('read_page', args)).text;

// What a page says, read the way a test reads it and not through the tools under test.
async function evalIn(expr, match = 'chores.html') {
  const list = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page' && x.url.includes(match));
  const ws = new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) res(m);
    };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
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

// ---------- nudge on repeats ----------
{
  console.log('\n# Nudge on repeats');
  await session();
  const NUDGE = /repeat ones you already did/;
  // Everything the task says back: the nudge can only be in these.
  const pass = async (one, two) => {
    const out = [];
    await call('navigate', { url: CHORES });
    const page = await read();
    const item = refFor(page, /textbox.*Item/i);
    const add = refFor(page, /button.*Add item/i);
    out.push((await call('type', { ref: item, text: one })).text);
    out.push((await call('click', { ref: add })).text);
    out.push((await call('type', { ref: item, text: two })).text);
    out.push((await call('click', { ref: add })).text);
    out.push((await call('click', { ref: refFor(page, /button.*Publish/i) })).text);
    return out;
  };
  const count = (texts) => texts.filter((t) => NUDGE.test(t)).length;

  check(count(await pass('Soap', 'Salt')) === 0, 'the first time, nothing');
  const second = await pass('Rice', 'Tea');
  check(count(second) === 1, 'the second time, once, with other values');
  const said = second.find((t) => NUDGE.test(t));
  check(/routine_propose/.test(said) && /remove everything before step \d+/.test(said), `it says what to do: ${said?.slice(-200)}`);
  check(count(await pass('Oil', 'Eggs')) === 0, 'not again for the same task');

  await session();
  const later = await pass('Jam', 'Ham');
  check(count(later) === 1, 'a later session sees the earlier one');
  check(!/remove everything/.test(later.find((t) => NUDGE.test(t)) ?? ''), 'and has no earlier pass of its own to remove');

  const d = await call('routine_propose', { name: 'list-chores', description: 'Adds two items to the chores list and publishes it. Use when someone wants the list published.' });
  await call('routine_save', { draft_id: draftOf(d.text) });
  await session();
  check(count(await pass('Figs', 'Nuts')) === 0, 'silent once a routine covers it');

  await session();
  await call('navigate', { url: CHORES });
  const short = await read();
  check(!NUDGE.test((await call('click', { ref: refFor(short, /button.*Publish/i) })).text), 'silent for something short');
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
  const edited = await call('routine_edit', { draft_id: id, ops: [{ op: 'expect', text: `Added {{${name}}}` }] });
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

// ---------- savings meter ----------
let meterParam;
{
  console.log('\n# Savings meter');
  await session();
  await addByHand('Pears');
  const d = await call('routine_propose', { name: 'meter-chore', description: 'Adds an item for the meter to count. Use when someone wants it counted.' });
  const id = draftOf(d.text);
  const name = paramOf(d.text);
  meterParam = name;
  await call('routine_test', { draft_id: id, params: { [name]: 'Pears' } });
  await call('routine_save', { draft_id: id });
  const statsFile = `${process.env.AGENTIC_ROUTINES_HOME}/routines/local/meter-chore/.stats.json`;
  const stats = JSON.parse(readFileSync(statsFile, 'utf8'));
  check(stats.byHand?.steps >= 3, `saving keeps the run it was recorded from: ${JSON.stringify(stats.byHand)}`);

  const r = await call('routine_run', { name: 'meter-chore', params: { [name]: 'Plums' } });
  check(/^Done/m.test(r.text), `a replay: ${r.text.slice(0, 100)}`);

  const out = await new Promise((res) => execFile(process.execPath, [`${CLI}/dist/index.js`, 'stats'], { env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME } }, (_e, stdout) => res(stdout)));
  check(/This week/.test(out) && /\(measured\)/.test(out) && /\(estimated\)/.test(out), `stats labels what it knows and what it estimates: ${out.slice(0, 200)}`);
  check(/meter-chore: 1 run/.test(out), 'stats lists the routine');
  check(/after 1 recording/.test(out), 'recording counts against the total');
  check(/Nothing here leaves your computer/.test(out), 'stats says how it is worked out');
  const after = JSON.parse(readFileSync(statsFile, 'utf8'));
  check(after.recent.length === 1 && after.recent[0].agent === 'claude-code', 'a run is kept with its agent');

  const panel = await (await fetch(`${CDP}/json/new?chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo/sidepanel.html`, { method: 'PUT' })).json();
  await sleep(1000);
  // Signed in, as the panel shows nothing else to someone who is not.
  await evalIn(`chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' } }).then(() => true)`, 'sidepanel.html');
  await sleep(1500);
  // The run just made is on screen first, as it is to a person who opens the panel then.
  await evalIn(`[...document.querySelectorAll('button')].find((b) => /Back to routines/.test(b.textContent))?.click(), true`, 'sidepanel.html');
  await sleep(500);
  const shown = await evalIn(`document.body.innerText`, 'sidepanel.html');
  check(/This week/.test(shown) && /\(estimated\)/.test(shown), `the panel shows the week: ${String(shown).replace(/\s+/g, ' ').slice(0, 300)}`);
  check(/meter-chore[\s\S]*over 1 run\b/.test(shown), `and the routine: ${String(shown).replace(/\s+/g, ' ').split('meter-chore')[1]?.slice(0, 300)}`);
  await fetch(`${CDP}/json/close/${panel.id}`);
}

// ---------- behind the person's tab ----------
{
  console.log('\n# Run in the background');
  await session();
  await addByHand('Figs');
  await call('click', { ref: refFor(await read(), /button.*Publish/i) });
  const d = await call('routine_propose', { name: 'publish-chore', description: 'Adds an item and publishes the list. Use when someone wants an item published.' });
  const id = draftOf(d.text);
  const name = paramOf(d.text);
  check(/Test passed/.test((await call('routine_test', { draft_id: id, params: { [name]: 'Figs' } })).text), 'the routine tests');
  check(/pauses before step/.test((await call('routine_save', { draft_id: id })).text), 'the routine pauses before publishing');

  // The person is reading something else, with the panel open beside it.
  const panel = await (await fetch(`${CDP}/json/new?chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo/sidepanel.html`, { method: 'PUT' })).json();
  const person = await (await fetch(`${CDP}/json/new?${SITE}/docs.html`, { method: 'PUT' })).json();
  await fetch(`${CDP}/json/activate/${person.id}`);
  await sleep(800);
  await evalIn(`window.moved = 0; document.addEventListener('visibilitychange', () => window.moved++); true`, 'docs.html');
  const before = await evalIn(`document.visibilityState`, 'docs.html');
  check(before === 'visible', 'the person has their own tab in front');

  const run = call('routine_run', { name: 'publish-chore', params: { [name]: 'Dates' } });
  const reached = await (async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await evalIn(`!!document.querySelector('.btn-stop') && !!document.querySelector('.btn.btn-primary')`, 'sidepanel.html')) return true;
    }
    return false;
  })();
  check(reached, 'the pause reaches the panel');
  const badge = await evalIn(`(chrome.action.getBadgeText({}, (t) => (window.badge = t)), true)`, 'sidepanel.html').then(() => sleep(200)).then(() => evalIn(`window.badge`, 'sidepanel.html'));
  check(badge === '1', `the toolbar icon says something waits: ${badge}`);
  check((await evalIn(`document.visibilityState`, 'docs.html')) === 'visible' && (await evalIn(`window.moved`, 'docs.html')) === 0, 'the page did not come forward at the pause');
  await evalIn(`document.querySelector('.btn.btn-primary').click()`, 'sidepanel.html');
  const done = await run;
  check(/^Done/m.test(done.text), `it finishes: ${done.text.slice(0, 100)}`);
  check((await evalIn(`document.visibilityState`, 'docs.html')) === 'visible' && (await evalIn(`window.moved`, 'docs.html')) === 0, 'the person was never moved off their tab');
  await fetch(`${CDP}/json/close/${person.id}`);
  await fetch(`${CDP}/json/close/${panel.id}`);

  // A step that does not match behind another tab says so.
  const person2 = await (await fetch(`${CDP}/json/new?${SITE}/docs.html`, { method: 'PUT' })).json();
  await fetch(`${CDP}/json/activate/${person2.id}`);
  await flags({ add: 'Renamed for this' });
  const changed = await call('routine_run', { name: 'meter-chore', params: { [meterParam]: 'Quince' } });
  check(/behind another/.test(changed.text), `behind another tab the result says so: ${changed.text.slice(0, 220)}`);
  const stop = /run_id "(rp-[a-z0-9]+)"/.exec(changed.text)?.[1];
  if (stop) await call('routine_resume', { run_id: stop, approve: false });
  await flags({ add: null });
  await fetch(`${CDP}/json/close/${person2.id}`);
}

// ---------- loops and branches ----------
{
  console.log('\n# Loops and branches');
  // Stays open so what the page logged can be read after a run has tidied up its own tabs.
  const watch = await (await fetch(`${CDP}/json/new?${CHORES}`, { method: 'PUT' })).json();
  const log = async () => JSON.parse((await evalIn(`localStorage.getItem('chores.log')`)) ?? '[]');
  const fresh = () => evalIn(`localStorage.removeItem('chores.log'); true`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Over a list of values.
  await session();
  await addByHand('Apples');
  let d = await call('routine_propose', { name: 'add-many', description: 'Adds items to the chores list. Use when someone wants several chores added.' });
  let id = draftOf(d.text);
  const item = paramOf(d.text);
  let t = await call('routine_edit', { draft_id: id, ops: [{ op: 'each', from: 2, to: 3, param: item }] });
  check(/for each value of/.test(t.text), `the draft shows the loop: ${t.text.slice(0, 200)}`);
  await fresh();
  t = await call('routine_test', { draft_id: id, params: { [item]: 'Kiwi, Lime, Mango' } });
  check(/Test passed/.test(t.text) && /repeated 3 times/.test(t.text), `three values, three passes: ${t.text.slice(0, 200)}`);
  check(same(await log(), ['add:Kiwi', 'add:Lime', 'add:Mango']), `each pass had its own value: ${await log()}`);
  await call('routine_save', { draft_id: id });
  await fresh();
  t = await call('routine_run', { name: 'add-many', params: { [item]: 'Nut, with a comma\nOat' } });
  check(/^Done/m.test(t.text) && same(await log(), ['add:Nut, with a comma', 'add:Oat']), `one per line keeps commas: ${await log()}`);
  await fresh();
  t = await call('routine_run', { name: 'add-many', params: { [item]: 'Pea' } });
  check(/^Done/m.test(t.text) && same(await log(), ['add:Pea']), 'one value is one pass');
  await fresh();
  t = await call('routine_run', { name: 'add-many', params: { [item]: Array.from({ length: 26 }, (_, i) => `x${i}`).join(',') } });
  check(!/^Done/m.test(t.text) && /limit/.test(t.text) && same(await log(), []), `over the limit, nothing runs: ${t.text.slice(0, 160)}`);

  // Edits keep a loop around the steps it had, and refuse what cannot be.
  const edit = draftOf((await call('routine_propose', { name: 'add-many', description: 'Adds items to the chores list. Use when someone wants several chores added.', from_routine: 'add-many' })).text);
  t = await call('routine_edit', { draft_id: edit, ops: [{ op: 'if', from: 2, to: 3, text: 'Chores' }] });
  check(!!t.error && /wholly|runs past/.test(t.text), `a branch across a loop's edge is refused: ${t.text.slice(0, 200)}`);
  t = await call('routine_edit', { draft_id: edit, ops: [{ op: 'each', from: 3, to: 3, param: item }] });
  check(!!t.error && /loop inside/.test(t.text), `a loop in a loop is refused: ${t.text.slice(0, 200)}`);
  t = await call('routine_edit', { draft_id: edit, ops: [{ op: 'remove', steps: [2] }] });
  check(!/for each/.test(t.text), 'removing the loop keeps its steps');
  await call('routine_edit', { draft_id: edit, ops: [{ op: 'undo' }] });

  // Both ways of a branch: a notice that only sometimes shows.
  await session();
  await flags({ banner: '1' });
  await call('navigate', { url: CHORES });
  const page = await read();
  await call('click', { ref: refFor(page, /button.*Close notice/i) });
  await call('type', { ref: refFor(page, /textbox.*Item/i), text: 'Tea' });
  await call('click', { ref: refFor(page, /button.*Add item/i) });
  d = await call('routine_propose', { name: 'add-past-notice', description: 'Adds an item, past the notice when there is one. Use when someone wants a chore added.' });
  id = draftOf(d.text);
  const tea = paramOf(d.text);
  t = await call('routine_edit', { draft_id: id, ops: [{ op: 'if', from: 2, to: 2, has_step: 2 }] });
  check(/^2\. if /m.test(t.text), `the draft shows the branch: ${t.text.slice(0, 200)}`);
  await fresh();
  t = await call('routine_test', { draft_id: id, params: { [tea]: 'Tea' } });
  check(/Test passed/.test(t.text) && /“yes” way/.test(t.text) && /not tried/.test(t.text), `with the notice: ${t.text.slice(0, 220)}`);
  check(same(await log(), ['dismiss', 'add:Tea']), `closes it and goes on: ${await log()}`);
  await flags({ banner: null });
  await fresh();
  t = await call('routine_test', { draft_id: id, params: { [tea]: 'Tea' } });
  check(/Test passed/.test(t.text) && /“no” way/.test(t.text), `without it: ${t.text.slice(0, 220)}`);
  check(same(await log(), ['add:Tea']), `skips it and goes on: ${await log()}`);
  await call('routine_save', { draft_id: id });

  // One thing or another, on text on the page.
  await session();
  await flags({ banner: '1' });
  await call('navigate', { url: CHORES });
  // A seeded row is kept by the tab, so it goes in once this session has its own.
  await flags({ seed: 'Ash' });
  await sleep(500);
  const row = await read({ wait: 1000 });
  await call('click', { ref: refFor(row, /button.*Close notice/i) });
  const star = (await call('click', { ref: refFor(row, /button.*Star/i) })).text;
  const both = (await call('routine_propose', { name: 'notice-or-star', description: 'Closes the notice, or stars the row when there is none. Use when someone wants that.' })).text;
  id = draftOf(both);
  t = await call('routine_edit', { draft_id: id, ops: [{ op: 'if', from: 2, to: 2, else_to: 3, text: 'The terms have changed' }] });
  check(/otherwise run/.test(t.text), `the draft shows both ways: ${t.text.slice(0, 200)} ${star} ${both.replace(/\s+/g, ' ').slice(0, 700)}`);
  await flags({ seed: 'Ash' });
  await fresh();
  t = await call('routine_test', { draft_id: id });
  check(/Test passed/.test(t.text) && same(await log(), ['dismiss']), `yes runs one: ${await log()}`);
  await flags({ banner: null, seed: 'Ash' });
  await fresh();
  t = await call('routine_test', { draft_id: id });
  check(/Test passed/.test(t.text) && same(await log(), ['star:Ash']), `no runs the other: ${await log()}`);

  // A step that pauses pauses on every pass.
  await session();
  await addByHand('Figs');
  await call('click', { ref: refFor(await read(), /button.*Publish/i) });
  d = await call('routine_propose', { name: 'publish-each', description: 'Adds and publishes each item. Use when someone wants items published one by one.' });
  id = draftOf(d.text);
  const fig = paramOf(d.text);
  await call('routine_edit', { draft_id: id, ops: [{ op: 'each', from: 2, to: 4, param: fig }] });
  t = await call('routine_test', { draft_id: id, params: { [fig]: 'One, Two' } });
  check(/Test passed/.test(t.text), `the test runs both passes and skips the publishing: ${t.text.slice(0, 200)}`);
  await call('routine_save', { draft_id: id });
  await fresh();
  t = await call('routine_run', { name: 'publish-each', params: { [fig]: 'One, Two' } });
  let run = /run_id "(rp-[a-z0-9]+)"/.exec(t.text)?.[1];
  check(!!run && !/^Done/m.test(t.text) && same(await log(), ['add:One']), `pauses on the first pass: ${await log()}`);
  t = await call('routine_resume', { run_id: run, approve: true });
  check(!/^Done/m.test(t.text) && same(await log(), ['add:One', 'publish', 'add:Two']), `and again on the second: ${await log()}`);
  t = await call('routine_resume', { run_id: run, approve: true });
  check(/^Done/m.test(t.text) && same(await log(), ['add:One', 'publish', 'add:Two', 'publish']), `then finishes: ${t.text.slice(0, 120)}`);

  // Over the elements on a page: rows that stay, rows that go.
  const byRow = async (name, button) => {
    await session();
    await call('navigate', { url: CHORES });
    await flags({ seed: 'Ash,Birch,Cedar' });
    await sleep(500);
    await call('click', { ref: refFor(await read({ wait: 1000 }), button) });
    const id = draftOf((await call('routine_propose', { name, description: 'Goes down the list. Use when someone wants every row done.' })).text);
    return id;
  };
  id = await byRow('star-all', /button.*Star/i);
  t = await call('routine_edit', { draft_id: id, ops: [{ op: 'each', from: 2, to: 2, step: 2 }] });
  check(/each element in turn/.test(t.text), `the draft shows which step moves along: ${t.text.slice(0, 200)}`);
  await flags({ seed: 'Ash,Birch,Cedar' });
  await fresh();
  t = await call('routine_test', { draft_id: id });
  check(/repeated 3 times/.test(t.text) && same(await log(), ['star:Ash', 'star:Birch', 'star:Cedar']), `rows that stay, one each: ${await log()}`);
  await call('routine_save', { draft_id: id });
  await flags({ seed: 'Ash,!Birch,Cedar' });
  await fresh();
  t = await call('routine_run', { name: 'star-all' });
  check(!/^Done/m.test(t.text) && /Delete/.test(t.text) && same(await log(), ['star:Ash']), `it stops short of what looks irreversible on another row: ${t.text.slice(0, 200)}`);

  id = await byRow('tick-all', /button.*Tick off/i);
  await call('routine_edit', { draft_id: id, ops: [{ op: 'each', from: 2, to: 2, step: 2, limit: 2 }] });
  await flags({ seed: 'Ash,Birch,Cedar' });
  await fresh();
  t = await call('routine_test', { draft_id: id });
  check(/repeated 2 times/.test(t.text) && /may be more/.test(t.text) && same(await log(), ['tick:Ash', 'tick:Birch']), `its limit stops it and it says so: ${t.text.slice(0, 200)}`);
  t = await call('routine_edit', { draft_id: id, ops: [{ op: 'undo' }, { op: 'each', from: 2, to: 2, step: 2 }] });
  await flags({ seed: 'Ash,Birch,Cedar' });
  await fresh();
  t = await call('routine_test', { draft_id: id });
  check(/repeated 3 times/.test(t.text) && same(await log(), ['tick:Ash', 'tick:Birch', 'tick:Cedar']), `rows that go, none skipped: ${await log()}`);
  await call('routine_save', { draft_id: id });
  await flags({ seed: '' });
  await fresh();
  t = await call('routine_run', { name: 'tick-all' });
  check(/^Done/m.test(t.text) && /repeated 0 times/.test(t.text) && same(await log(), []), `an empty list is no passes: ${t.text.slice(0, 160)}`);

  // A routine with neither still runs.
  t = await call('routine_run', { name: 'meter-chore', params: { [meterParam]: 'Rye' } });
  check(/^Done/m.test(t.text) && !/repeated/.test(t.text), 'one with neither runs as it did');
  await fetch(`${CDP}/json/close/${watch.id}`);
}

await client.close();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
