// The browser tools on pages that only believe the browser, in front and behind another tab, and replays of what they recorded.
// Started by e2e-input.sh.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const CDP = 'http://127.0.0.1:9336';
const SITE = 'http://127.0.0.1:8768';

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

async function browserCdp() {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const wait = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (wait.has(m.id)) wait.get(m.id)(m), wait.delete(m.id);
  };
  const send = (method, params = {}) => new Promise((res) => (wait.set(++id, res), ws.send(JSON.stringify({ id, method, params }))));
  return { send, close: () => ws.close() };
}
const toFront = async (match) => {
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes(match));
  const b = await browserCdp();
  await b.send('Target.activateTarget', { targetId: t.id });
  b.close();
  await sleep(300);
};

// ---------- real input (#111) ----------
for (const where of ['behind another tab', 'in front']) {
  let r = await call('navigate', { url: `${SITE}/trusted.html?${where === 'in front' ? 'front' : 'behind'}` });
  check(!r.error, `opens the page, ${where}`);
  const tab = Number(r.text.match(/\(tab (\d+)\)/)?.[1]);
  if (where === 'in front') await toFront('trusted.html');
  let page = await read({ tab_id: tab });
  r = await call('click', { ref: refFor(page, /“Count me”/), tab_id: tab });
  await sleep(100);
  check(!r.error && (await say('count')) === 'clicks 1', `a click the page believes, ${where}`);
  r = await call('type', { ref: refFor(page, /“Name”/), text: 'Asha', tab_id: tab });
  await sleep(100);
  check((await say('name-out')) === 'name Asha', `typing the page believes, ${where}`);
  r = await call('type', { ref: refFor(page, /“Name”/), text: 'Ravi', tab_id: tab });
  await sleep(100);
  check((await say('name-out')) === 'name Ravi', `typing again replaces what was there, ${where}`);
  r = await call('type', { ref: refFor(page, /“Rich”/), text: 'hello', tab_id: tab });
  await sleep(100);
  check((await say('rich-out')) === 'rich hello', `typing into a rich text field, ${where}`);
  r = await call('type', { ref: refFor(page, /“Search”/), text: 'books', submit: true, tab_id: tab });
  await sleep(100);
  check((await say('form-out')) === 'sent books', `Enter submits the form, ${where}`);
  await call('click', { ref: refFor(page, /“Name”/), tab_id: tab });
  r = await call('press', { key: 'Escape', tab_id: tab });
  await sleep(100);
  check((await say('keys')) === 'keys Escape', `a key the page believes, ${where}`);
  r = await call('click', { ref: refFor(page, /checkbox/), tab_id: tab });
  await sleep(100);
  check(!r.error && (await say('c1-out')) === 'ticked', `a hidden checkbox behind its label, ${where}${(await say('c1-out')) === 'ticked' ? '' : `: ${r.text.slice(0, 200)} ${page.split('\n').filter((l) => /Agree|checkbox/.test(l))}`}`);
  r = await call('click', { ref: refFor(page, /“Under”/), tab_id: tab });
  check(/drawn over it/.test(r.text), `a button with something on top of it says so, ${where}: ${r.text.split('\n').at(-1).slice(0, 120)}`);
}

// ---------- and a replay does the same ----------
{
  await session();
  await sleep(1500);
  await call('navigate', { url: `${SITE}/trusted.html?replay` });
  const page = await read();
  await call('click', { ref: refFor(page, /“Count me”/) });
  await call('type', { ref: refFor(page, /“Name”/), text: 'Meera' });
  await call('press', { key: 'Escape' });
  const d = await call('routine_propose', { name: 'input-replay', description: 'Count and name on the input page. Use when the user asks for this.' });
  check(!d.error, 'proposes a routine of it');
  const id = d.text.match(/^Draft (d-\S+)/m)?.[1];
  let t = await call('routine_test', { draft_id: id });
  check(!t.error && /passed|ok|done/i.test(t.text), `tests it on the live page: ${t.text.split('\n')[0].slice(0, 120)}`);
  t = await call('routine_save', { draft_id: id });
  check(!t.error, 'saves it');
  await call('navigate', { url: `${SITE}/trusted.html?replay2` });
  const t0 = Date.now();
  t = await call('routine_run', { name: 'input-replay', params: { name: 'Meera' } });
  check(Date.now() - t0 < 5000, `in ${Date.now() - t0} ms, in a tab behind another`);
  await sleep(200);
  check(/done|finished/i.test(t.text), `runs it: ${t.text.split('\n')[0].slice(0, 120)}`);
  check((await say('count', '?replay')) === 'clicks 1', 'the replay clicks for real');
  check((await say('name-out', '?replay')) === 'name Meera', 'the replay types for real');
  check((await say('keys', '?replay')) === 'keys Escape', 'the replay presses for real');
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
