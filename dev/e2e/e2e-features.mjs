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

// ---------- savings meter ----------
{
  console.log('\n# Savings meter');
  await session();
  await addByHand('Pears');
  const d = await call('routine_propose', { name: 'meter-chore', description: 'Adds an item for the meter to count. Use when someone wants it counted.' });
  const id = draftOf(d.text);
  const name = paramOf(d.text);
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
  await sleep(1500);
  const shown = await evalIn(`document.body.innerText`, 'sidepanel.html');
  check(/This week/.test(shown) && /\(estimated\)/.test(shown), 'the panel shows the week');
  check(/meter-chore[\s\S]*over 1 run\b/.test(shown), 'and the routine');
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
      if (await evalIn(`[...document.querySelectorAll('button')].some((b) => /approve/i.test(b.textContent))`, 'sidepanel.html')) return true;
    }
    return false;
  })();
  check(reached, 'the pause reaches the panel');
  const badge = await evalIn(`(chrome.action.getBadgeText({}, (t) => (window.badge = t)), true)`, 'sidepanel.html').then(() => sleep(200)).then(() => evalIn(`window.badge`, 'sidepanel.html'));
  check(badge === '1', `the toolbar icon says something waits: ${badge}`);
  check((await evalIn(`document.visibilityState`, 'docs.html')) === 'visible' && (await evalIn(`window.moved`, 'docs.html')) === 0, 'the page did not come forward at the pause');
  await evalIn(`[...document.querySelectorAll('button')].find((b) => /approve/i.test(b.textContent)).click()`, 'sidepanel.html');
  const done = await run;
  check(/^Done/m.test(done.text), `it finishes: ${done.text.slice(0, 100)}`);
  check((await evalIn(`document.visibilityState`, 'docs.html')) === 'visible' && (await evalIn(`window.moved`, 'docs.html')) === 0, 'the person was never moved off their tab');
  await fetch(`${CDP}/json/close/${person.id}`);
  await fetch(`${CDP}/json/close/${panel.id}`);

  // A step that does not match behind another tab says so.
  const person2 = await (await fetch(`${CDP}/json/new?${SITE}/docs.html`, { method: 'PUT' })).json();
  await fetch(`${CDP}/json/activate/${person2.id}`);
  await flags({ add: 'Renamed for this' });
  const changed = await call('routine_run', { name: 'meter-chore', params: { [(paramOf((await call('routine_propose', { name: 'x-x', description: 'Only to read its parameter. Use when never.', from_routine: 'meter-chore' })).text) ?? 'item')]: 'Kale' } });
  check(/behind another/.test(changed.text), `behind another tab the result says so: ${changed.text.slice(0, 220)}`);
  const stop = /run_id "(rp-[a-z0-9]+)"/.exec(changed.text)?.[1];
  if (stop) await call('routine_resume', { run_id: stop, approve: false });
  await flags({ add: null });
  await fetch(`${CDP}/json/close/${person2.id}`);
}

await client.close();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
