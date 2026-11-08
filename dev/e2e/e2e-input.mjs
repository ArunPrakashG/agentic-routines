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
  const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page');
  const t = pages.find((x) => x.url.includes(match));
  if (!t) throw new Error(`No page at ${match}. Open: ${pages.map((x) => x.url).join(', ')}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `document.getElementById(${JSON.stringify(id)})?.textContent`, returnByValue: true } }));
  });
  ws.close();
  return out.result.result.value;
}

// Anything else about the page, the same way.
async function evalIn(expression, match) {
  const pages = (await (await fetch(`${CDP}/json/list`)).json()).filter((x) => x.type === 'page');
  const t = pages.find((x) => x.url.includes(match));
  if (!t) throw new Error(`No page at ${match}. Open: ${pages.map((x) => x.url).join(', ')}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
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
const only = process.env.ONLY;
for (const where of only ? [] : ['behind another tab', 'in front']) {
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
if (!only) {
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

// ---------- pointer tools (#112) ----------
const rectOf = (id, match) => evalIn(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; })()`, match);
for (const where of ['behind another tab', 'in front']) {
  await session();
  await sleep(500);
  const m = where === 'in front' ? 'pointer.html?front' : 'pointer.html?behind';
  let r = await call('navigate', { url: `${SITE}/${m.slice(m.indexOf('pointer'))}` });
  const tab = Number(r.text.match(/\(tab (\d+)\)/)?.[1]);
  if (where === 'in front') await toFront(m);
  const said = (id) => say(id, m);
  let page = await read({ tab_id: tab });
  const ref = (re) => refFor(page, re);

  // A point read off a picture.
  r = await call('screenshot', { full: true, tab_id: tab });
  const size = r.text.match(/picture is (\d+)×(\d+)/);
  check(r.images.length === 1 && !!size, `a screenshot says how big it is, ${where}: ${size?.[0] ?? r.text.slice(0, 300)}`);
  const b = await rectOf('board', m);
  const px = (x, y, v = b) => ({ x: (x * Number(size[1])) / v.vw, y: (y * Number(size[2])) / v.vh });
  r = await call('click', { ...px(b.x + 100, b.y + 50), tab_id: tab });
  await sleep(100);
  const hit = (await said('board-out')).match(/board (\d+),(\d+)/);
  check(hit && Math.abs(hit[1] - 100) <= 2 && Math.abs(hit[2] - 50) <= 2, `a click on a canvas lands where it was aimed, ${where}: ${await said('board-out')}`);
  r = await call('screenshot', { region: [px(b.x, b.y).x, px(b.x, b.y).y, px(b.x + 200, b.y + 100).x, px(b.x + 200, b.y + 100).y], tab_id: tab });
  const zoom = r.text.match(/picture is (\d+)×(\d+)/);
  check(r.images.length === 1 && Number(zoom?.[1]) >= 200, `a region of the picture, enlarged, ${where}: ${zoom?.[0] ?? r.text.slice(0, 300)}`);
  // Points are now in that picture.
  r = await call('click', { x: (20 / 200) * Number(zoom[1]), y: (40 / 100) * Number(zoom[2]), tab_id: tab });
  await sleep(100);
  const hit2 = (await said('board-out')).match(/board (\d+),(\d+)/);
  check(hit2 && Math.abs(hit2[1] - 20) <= 2 && Math.abs(hit2[2] - 40) <= 2, `a point in the region lands right, ${where}: ${await said('board-out')}`);

  // Buttons, counts and keys held.
  await call('click', { ref: ref(/“Twice”/), count: 2, tab_id: tab });
  await sleep(100);
  check((await said('dbl-out')) === 'dbl yes', `a double click, ${where}`);
  await call('click', { ref: ref(/“Context”/), button: 'right', tab_id: tab });
  await sleep(100);
  check((await said('ctx-out')) === 'ctx yes', `a right click, ${where}`);
  await call('click', { ref: ref(/“Held”/), modifiers: 'ctrl', tab_id: tab });
  await sleep(100);
  check((await said('mod-out')) === 'mod ctrl', `a click with ctrl held, ${where}`);

  // A menu that only opens under the pointer.
  check(!/Open file/.test(page), `the menu is shut, ${where}`);
  r = await call('hover', { ref: ref(/“Files”/), tab_id: tab });
  await sleep(150);
  page = await read({ tab_id: tab });
  check(/Open file/.test(page), `hovering opens it, ${where}: ${r.text.split('\n').at(-1).slice(0, 80)}`);
  r = await call('click', { ref: ref(/“Open file”/), tab_id: tab });
  await sleep(100);
  check((await said('open-out')) === 'open yes', `and what opened can be clicked, ${where}${(await said('open-out')) === 'open yes' ? '' : `: ${r.text.slice(0, 160)}`}`);

  // Dragging.
  r = await call('screenshot', { full: true, tab_id: tab });
  const h = await rectOf('handle', m);
  const a = px(h.x + 12, h.y + 12, h);
  const z = px(h.x + 212, h.y + 12, h);
  r = await call('drag', { x: a.x, y: a.y, to_x: z.x, to_y: z.y, tab_id: tab });
  await sleep(150);
  const moved = Number((await said('handle-out')).split(' ')[1]);
  check(!r.error && Math.abs(moved - 200) <= 3, `a drag moves a handle the page follows, ${where}: ${await said('handle-out')} ${r.error ? r.text.slice(0, 120) : ''}`);
  r = await call('drag', { ref: ref(/“Card”/), to_ref: ref(/“Bin”/), tab_id: tab });
  await sleep(300);
  check((await said('bin-out')) === 'bin card', `a drag the browser itself carries, ${where}: ${await said('bin-out')} ${r.text.slice(0, 120)}`);

  // Keys.
  await call('click', { ref: ref(/“Field”/), tab_id: tab });
  r = await call('press', { key: 'ArrowDown', repeat: 3, tab_id: tab });
  await sleep(100);
  check((await said('count')) === 'downs 3', `a key three times, ${where}`);
  await call('press', { key: 'ctrl+a Escape', tab_id: tab });
  await sleep(100);
  check((await said('keys')) === 'keys Escape', `keys one after another, ${where}: ${await said('keys')}`);

  // Scrolling.
  const y0 = await evalIn('scrollY', m);
  r = await call('scroll', { direction: 'down', amount: 4, tab_id: tab });
  await sleep(100);
  const y1 = await evalIn('scrollY', m);
  check(!r.error && y1 > y0, `the page scrolls, ${where}: ${r.text}`);
  r = await call('click', { x: 5, y: 5, tab_id: tab });
  check(r.error && /out of date/.test(r.text), `a point from before the scroll is refused, ${where}`);
  r = await call('scroll', { direction: 'down', amount: 1, ref: ref(/“Panel”/), tab_id: tab });
  await sleep(100);
  check((await said('panel-out')) !== 'panel 0', `a panel scrolls on its own, ${where}: ${r.text} ${await said('panel-out')}`);
  await call('scroll', { direction: 'up', amount: 50, tab_id: tab });
  r = await call('scroll', { ref: ref(/“Far button”/), tab_id: tab });
  const f = await rectOf('far', m);
  check(f.y >= 0 && f.y < f.vh, `a ref is brought into view, ${where}`);
  r = await call('wait', { seconds: 0.2, tab_id: tab });
  check(!r.error, `waits, ${where}`);
  r = await call('hover', { tab_id: tab });
  check(r.error, `a pointer tool with nowhere to go says so, ${where}`);
}

// ---------- and they replay ----------
{
  await session();
  await sleep(1500);
  const m = 'pointer.html?replay';
  await call('navigate', { url: `${SITE}/pointer.html?replay` });
  let page = await read();
  const ref = (re) => refFor(page, re);
  let r = await call('screenshot', { full: true });
  const size = r.text.match(/picture is (\d+)×(\d+)/);
  const b = await rectOf('board', m);
  const px = (x, y, v = b) => ({ x: (x * Number(size[1])) / v.vw, y: (y * Number(size[2])) / v.vh });
  await call('click', px(b.x + 300, b.y + 30));
  await call('click', { ref: ref(/“Twice”/), count: 2 });
  await call('click', { ref: ref(/“Held”/), modifiers: 'ctrl' });
  await call('hover', { ref: ref(/“Files”/) });
  await sleep(150);
  page = await read();
  await call('click', { ref: ref(/“Open file”/) });
  await call('screenshot', { full: true });
  const h = await rectOf('handle', m);
  await call('drag', { ...px(h.x + 12, h.y + 12, h), to_x: px(h.x + 112, 0, h).x, to_y: px(0, h.y + 12, h).y });
  await call('scroll', { direction: 'down', amount: 2 });
  await call('press', { key: 'ArrowDown', repeat: 2 });
  const d = await call('routine_propose', { name: 'pointer-replay', description: 'Everything on the pointer page. Use when the user asks for this.' });
  check(!d.error, `proposes a routine of it: ${d.text.split('\n').filter((l) => /hover|drag|scroll/.test(l)).join(' | ').slice(0, 300)}`);
  const id = d.text.match(/^Draft (d-\S+)/m)?.[1];
  let t = await call('routine_test', { draft_id: id });
  check(!t.error && /passed|ok|done/i.test(t.text), `tests it on the live page: ${t.text.split('\n')[0].slice(0, 200)}`);
  t = await call('routine_save', { draft_id: id });
  check(!t.error, `saves it ${t.error ? t.text.slice(0, 200) : ''}`);
  await call('navigate', { url: `${SITE}/pointer.html?replay2` });
  t = await call('routine_run', { name: 'pointer-replay' });
  check(/done|finished/i.test(t.text), `runs it: ${t.text.split('\n').slice(0, 2).join(' ').slice(0, 240)}`);
  await sleep(200);
  const rm = 'pointer.html?replay';
  const out = (await say('board-out', rm)).match(/board (\d+),(\d+)/);
  check(out && Math.abs(out[1] - 300) <= 3 && Math.abs(out[2] - 30) <= 3, `the replay clicks the same place on the canvas: ${await say('board-out', rm)}`);
  check((await say('dbl-out', rm)) === 'dbl yes', 'the replay double clicks');
  check((await say('mod-out', rm)) === 'mod ctrl', 'the replay holds ctrl');
  check((await say('open-out', rm)) === 'open yes', 'the replay hovers and clicks what opened');
  const moved = Number((await say('handle-out', rm)).split(' ')[1]);
  check(Math.abs(moved - 100) <= 4, `the replay drags: ${await say('handle-out', rm)}`);
  check((await evalIn('scrollY', rm)) > 0, 'the replay scrolls');
  check((await say('count', rm)) === 'downs 2', `the replay presses twice: ${await say('count', rm)}`);
}

// ---------- what the outline used to miss, and fields as states ----------
{
  await session();
  await sleep(1500);
  const m = 'fields.html';
  await call('navigate', { url: `${SITE}/fields.html` });
  let page = await read();
  const ref = (re) => refFor(page, re);
  check(/clickable “Delete list”/.test(page), `a clickable with no role is in the outline: ${page.split('\n').filter((l) => /Delete|Archive/.test(l)).join(' | ')}`);
  check(/clickable “Archive it”/.test(page), 'so is one with only a hand cursor, once');
  check(!/clickable “A real link”/.test(page), 'a wrapper around a real control is not');
  let r = await call('find', { query: 'delete list' });
  check(/ref_\d+ clickable “Delete list”/.test(r.text), `find sees it: ${r.text.slice(0, 200)}`);
  await call('click', { ref: refFor(r.text, /Delete list/) });
  check((await say('plain-out', m)) === 'plain yes', 'and a click on what find gave lands');
  r = await call('find', { query: 'Order total' });
  check(/text “Order total/.test(r.text), `find sees plain words: ${r.text.slice(0, 200)}`);
  for (const hidden of ['secret instruction', 'tiny instruction']) {
    r = await call('find', { query: hidden });
    check(/Nothing on the page/.test(r.text), `find does not see what nobody can: ${hidden}`);
  }
  r = await call('get_page_text');
  check(/Order total/.test(r.text) && !/secret instruction|tiny instruction/.test(r.text), `the page's words, without the hidden ones: ${r.text.slice(0, 160)}`);
  const set = (re, value) => call('form_input', { ref: ref(re), value });
  r = await set(/“Newsletter”/, true);
  check(!r.error && (await evalIn(`document.getElementById('news').checked`, m)) === true, `ticks a checkbox: ${r.text.slice(0, 120)}`);
  r = await set(/“Newsletter”/, true);
  check(/already/.test(r.text) && (await evalIn(`document.getElementById('news').checked`, m)) === true, `ticking it again leaves it: ${r.text.slice(0, 120)}`);
  await set(/“Dark mode”/, 'on');
  check((await evalIn(`document.getElementById('sw').getAttribute('aria-checked')`, m)) === 'true', 'turns on a switch');
  // Large starts chosen: turning it off by itself is refused, and choosing Small turns it off.
  r = await set(/“Large”/, false);
  check(r.error, `a radio does not go off by itself: ${r.text.slice(0, 120)}`);
  await set(/“Small”/, true);
  check((await evalIn(`document.getElementById('small').checked`, m)) === true && (await evalIn(`document.getElementById('large').checked`, m)) === false, 'chooses a radio, and the other goes off');
  const chose = await set(/“Country”/, 'Japan');
  await set(/“Volume”/, 70);
  await set(/“Day”/, '2026-12-25');
  await set(/“Name”/, 'Asha');
  const state = () => evalIn(`[document.getElementById('country').value, document.getElementById('vol').value, document.getElementById('day').value, document.getElementById('who').value].join('|')`, m);
  check((await state()) === 'Japan|70|2026-12-25|Asha', `a select, slider, date and text: ${await state()} (${chose.text.slice(0, 160)})`);
  r = await set(/“Day”/, 'next friday');
  check(r.error && /YYYY-MM-DD/.test(r.text), `a date in the wrong form is refused: ${r.text.slice(0, 160)}`);
  const d = await call('routine_propose', { name: 'fields-replay', description: 'Fill in the fields page. Use when the user asks for this.' });
  check(!d.error && /form_input|set/i.test(d.text), `proposes a routine of it: ${d.text.slice(0, 200)}`);
  const id = d.text.match(/^Draft (d-\S+)/m)?.[1];
  await call('routine_save', { draft_id: id });
  // The replay opens the page it was recorded on, so it starts unticked. A setting is a state: it ticks once and stays.
  await call('navigate', { url: `${SITE}/trusted.html` });
  r = await call('routine_run', { name: 'fields-replay', params: { name: 'Asha' } });
  check(/done|finished/i.test(r.text), `replays it: ${r.text.split('\n').slice(0, 2).join(' ').slice(0, 240)}`);
  const rm = 'fields.html';
  check((await say('news-out', rm)) === 'news changes 1' && (await evalIn(`document.getElementById('news').checked`, rm)) === true, `a replay ticks the box once and leaves it ticked: ${await say('news-out', rm)}`);
  check((await say('plain-out', rm)) === 'plain yes', 'a replay clicks the plain clickable');
}

// ---------- frames and shadow roots (#114) ----------
for (const where of ['behind another tab', 'in front']) {
  await session();
  await sleep(1000);
  const m = where === 'in front' ? 'frames.html?front' : 'frames.html?behind';
  let r = await call('navigate', { url: `${SITE}/${m}` });
  const tab = Number(r.text.match(/\(tab (\d+)\)/)?.[1]);
  if (where === 'in front') await toFront(m);
  await sleep(500);
  let page = await read({ tab_id: tab });
  const ref = (re) => refFor(page, re);
  check(/f\d+:ref_\d+ .*“Open Same”/.test(page), `a frame on the same site is in the outline, ${where}: ${page.split('\n').filter((l) => /Open|frame/.test(l)).join(' | ').slice(0, 300)}`);
  check(/f\d+:ref_\d+ .*“Open Cross”/.test(page), `so is a frame from another site, ${where}`);
  check(/“Shadow go”/.test(page) && /“Shadow name”/.test(page) && /“Deep go”/.test(page), `so is what is in a closed shadow root, ${where}`);
  check(!/Open Off|Open Tiny/.test(page), `a frame nobody can see is not, ${where}`);

  await call('click', { ref: ref(/“Open Same”/), tab_id: tab });
  check((await say('same-out', m)) === 'same pay true', `clicks in a frame on the same site, ${where}: ${await say('same-out', m)}`);
  await call('type', { ref: ref(/“Name Same”/), text: 'Asha', tab_id: tab });
  check((await say('same-out', m)) === 'same typed Asha', `types in it, ${where}: ${await say('same-out', m)}`);
  await call('click', { ref: ref(/“Shadow go”/), tab_id: tab });
  check((await say('shadow-out', m)) === 'shadow go true', `clicks in a closed shadow root, ${where}: ${await say('shadow-out', m)}`);
  await call('type', { ref: ref(/“Shadow name”/), text: 'Ravi', tab_id: tab });
  check((await say('shadow-typed', m)) === 'typed Ravi', `types in it, ${where}: ${await say('shadow-typed', m)}`);
  await call('click', { ref: ref(/“Deep go”/), tab_id: tab });
  check((await say('shadow-out', m)) === 'shadow deep true', `clicks in a shadow root in a shadow root, ${where}`);
  // Far down the page, and in another process: the page has to scroll it on screen for the frame.
  await call('click', { ref: ref(/“Open Cross”/), tab_id: tab });
  check((await say('cross-out', m)) === 'cross pay true', `clicks in a frame from another site, off screen, ${where}: ${await say('cross-out', m)}`);
  await call('type', { ref: ref(/“Name Cross”/), text: 'Mira', tab_id: tab });
  check((await say('cross-out', m)) === 'cross typed Mira', `types in it, ${where}: ${await say('cross-out', m)}`);

  r = await call('find', { query: 'Open Cross', tab_id: tab });
  check(/f\d+:ref_\d+/.test(r.text), `find looks in frames, ${where}: ${r.text.slice(0, 160)}`);
  r = await call('find', { query: 'Shadow go', tab_id: tab });
  check(/ref_\d+/.test(r.text), `and in shadow roots, ${where}`);
  r = await call('get_page_text', { tab_id: tab });
  check(/Words Same/.test(r.text) && /Words Cross/.test(r.text) && !/Words Off/.test(r.text), `a page's words include its frames, ${where}: ${r.text.slice(0, 200)}`);

  // A point on a picture lands in the frame drawn there.
  const shot = await call('screenshot', { tab_id: tab, full: true });
  const size = shot.text.match(/picture is (\d+)×(\d+)/);
  const b = await evalIn(`(() => { const r = document.getElementById('cross').getBoundingClientRect(); return { x: r.x, y: r.y, vw: innerWidth, vh: innerHeight }; })()`, m);
  await evalIn(`document.getElementById('cross-out').textContent = 'cross nothing'`, m);
  r = await call('click', { x: ((b.x + 4 + 50) * Number(size[1])) / b.vw, y: ((b.y + 4 + 30) * Number(size[2])) / b.vh, tab_id: tab });
  check((await say('cross-out', m)) === 'cross pay true', `a point on a frame lands inside it, ${where}: ${await say('cross-out', m)} ${r.error ? r.text.slice(0, 160) : ''}`);

  // And a replay finds each of them where it was recorded.
  if (where === 'behind another tab') {
    const d = await call('routine_propose', { name: 'frames-replay', description: 'Open something in every frame. Use when the user asks for this.' });
    const id = d.text.match(/^Draft (d-\S+)/m)?.[1];
    check(!!id, `proposes a routine of it: ${d.text.slice(0, 200)}`);
    await call('routine_save', { draft_id: id });
    await call('navigate', { url: `${SITE}/frames.html?replay`, tab_id: tab });
    await sleep(500);
    r = await call('routine_run', { name: 'frames-replay', params: { name_same: 'Asha', shadow_name: 'Ravi', name_cross: 'Mira' } });
    check(/done|finished/i.test(r.text), `replays it: ${r.text.split('\n').slice(0, 2).join(' ').slice(0, 240)}`);
    // A replay starts at the address it recorded.
    const rm = 'frames.html?behind';
    check(/^same /.test(await say('same-out', rm)) && (await say('same-out', rm)) !== 'same nothing', `a replay works in the same-site frame: ${await say('same-out', rm)}`);
    check((await say('cross-out', rm)) === 'cross pay true', `and in the frame from another site: ${await say('cross-out', rm)}`);
    check(/^shadow /.test(await say('shadow-out', rm)) && (await say('shadow-out', rm)) !== 'shadow nothing', `and in the closed shadow root: ${await say('shadow-out', rm)}`);
  }
}

// ---------- dialogs and tabs (#115) ----------
{
  await session();
  await sleep(1000);
  const m = 'dialogs.html';
  let r = await call('navigate', { url: `${SITE}/dialogs.html` });
  let page = await read();
  const ref = (re) => refFor(page, re);
  r = await call('click', { ref: ref(/“Show notice”/) });
  check(/alert dialog/.test(r.text) && /Saved a copy/.test(r.text), `a click that opens an alert says so: ${r.text.slice(0, 200)}`);
  r = await call('read_page');
  check(r.error && /Saved a copy/.test(r.text), `reading a stopped page says why and does not hang: ${r.text.slice(0, 200)}`);
  r = await call('dialog', { accept: true });
  check(!r.error && (await say('out', m)) === 'alert done', `answers an alert: ${r.text.slice(0, 160)}`);
  await call('click', { ref: ref(/“Ask to archive”/) });
  await call('dialog', { accept: false });
  check((await say('out', m)) === 'confirm no', `says no to a confirm: ${await say('out', m)}`);
  r = await call('click', { ref: ref(/“Ask for a name”/) });
  check(/prompt dialog/.test(r.text), 'says a prompt opened');
  await call('dialog', { accept: true, text: 'Asha' });
  check((await say('out', m)) === 'prompt Asha', `types into a prompt: ${await say('out', m)}`);
  r = await call('dialog', { accept: true });
  check(r.error, 'with no dialog open, says so');

  const d = await call('routine_propose', { name: 'dialogs-replay', description: 'Answer the dialogs. Use when the user asks for this.' });
  const id = d.text.match(/^Draft (d-\S+)/m)?.[1];
  check(/dialog/.test(d.text), `a routine keeps the answers: ${d.text.slice(0, 300)}`);
  await call('routine_save', { draft_id: id });
  await call('navigate', { url: `${SITE}/dialogs.html?replay` });
  r = await call('routine_run', { name: 'dialogs-replay', params: { dialog_answer: 'Ravi' } });
  check(/done|finished/i.test(r.text), `replays them: ${r.text.split('\n').slice(0, 2).join(' ').slice(0, 240)}`);
  check((await say('out', 'dialogs.html')) === 'prompt Ravi', `with the new answer: ${await say('out', 'dialogs.html')}`);

  // A page that asks before it is left.
  await call('navigate', { url: `${SITE}/dialogs.html?leave` });
  page = await read();
  await call('click', { ref: refFor(page, /“Make unsaved changes”/) });
  r = await call('navigate', { url: `${SITE}/fields.html` });
  check(r.error && /force/.test(r.text), `leaving a page that asks says so: ${r.text.slice(0, 200)}`);
  check((await say('out', 'dialogs.html?leave')) === 'dirty', 'and stays on it');
  r = await call('navigate', { url: `${SITE}/fields.html`, force: true });
  check(!r.error && /fields\.html/.test(r.text), `force leaves: ${r.text.slice(0, 200)}`);

  // Tabs.
  await call('navigate', { url: `${SITE}/dialogs.html?tabs` });
  const home = Number((await call('navigate', { url: `${SITE}/dialogs.html?tabs` })).text.match(/\(tab (\d+)\)/)?.[1]);
  page = await read();
  r = await call('click', { ref: refFor(page, /“Open another”/) });
  const popped = Number(r.text.match(/new tab, (\d+)/)?.[1]);
  check(popped > 0, `a click that opens a tab says which: ${r.text.slice(0, 200)}`);
  const list = JSON.parse((await call('tabs')).text.match(/\[[\s\S]*\]/)[0]);
  check(list.find((t) => t.id === popped)?.yours === true, 'and it counts as yours');
  await call('navigate', { url: `${SITE}/fields.html`, tab_id: popped });
  r = await call('close_tab');
  check(new RegExp(`tab ${home}`).test(r.text), `closing it goes back to where it came from: ${r.text}`);
  const other = list.find((t) => t.yours !== true && t.id !== home && t.id !== popped);
  if (other) {
    r = await call('close_tab', { tab_id: other.id });
    check(r.error && /not one you opened/.test(r.text), `a tab it did not open stays open: ${r.text.slice(0, 160)}`);
  }
}

// ---------- scripts, the console and the network (#116) ----------
{
  await session();
  await sleep(1000);
  const m = 'logs.html';
  const EXT = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo';
  await call('navigate', { url: `${SITE}/logs.html` });
  let page = await read();
  let r = await call('read_console_messages');
  check(!r.error && /page started/.test(r.text), `the console, including from before the first call: ${r.text.slice(0, 200)}`);
  check(/\[hidden/.test(r.text) && !/eyJhbGci/.test(r.text) && !/ghp_abcdef/.test(r.text), 'what looks like a credential is hidden');
  check(!/instruction-looking/.test(r.text) || /UNTRUSTED|untrusted/.test(r.text), 'and it is marked as coming from the site');
  r = await call('read_console_messages', { only_errors: true });
  check(/boom from the page/.test(r.text) && !/page started/.test(r.text), `only the errors: ${r.text.slice(0, 200)}`);
  r = await call('read_network_requests');
  check(/Listening start/.test(r.text), `says when listening started: ${r.text.slice(0, 160)}`);
  await call('click', { ref: refFor(page, /“Send a request”/) });
  await sleep(500);
  r = await call('read_network_requests', { url_contains: 'overview' });
  check(/GET .*overview\.html\?key=…&who=… 200/.test(r.text) && !/s3cret/.test(r.text), `a request, with its values hidden: ${r.text.split('\n').filter((l) => /^[A-Z]+ /.test(l)).join(' | ').slice(0, 240) || r.text.slice(-200)}`);

  // A script waits for the person, and a no is a no.
  const panel = await (await fetch(`${CDP}/json/new?${EXT}/sidepanel.html`, { method: 'PUT' })).json();
  // Signed in, as the panel shows nothing else to someone who is not.
  const signIn = `chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' } })`;
  await sleep(1000);
  await evalIn(signIn, `${EXT}/sidepanel.html`);
  const answer = async (label) => {
    const ws = new WebSocket(panel.webSocketDebuggerUrl);
    await new Promise((res) => (ws.onopen = res));
    const out = await new Promise((res) => {
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id === 1) res(m);
      };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => { for (let i = 0; i < 100; i++) { const b = [...document.querySelectorAll('section[aria-label="Allow a script"] button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (b) { b.click(); return true; } await new Promise((r) => setTimeout(r, 100)); } return document.body.innerText.slice(0, 300); })()`, awaitPromise: true, returnByValue: true } }));
    });
    ws.close();
    if (!out.result) throw new Error(`The side panel did not answer: ${JSON.stringify(out.error ?? out)}`);
    const v = out.result.result.value;
    if (v !== true) console.log(`  the panel shows: ${String(v).replace(/\n/g, ' | ')}`);
    return v === true;
  };
  let run = call('javascript', { code: '1 + 1' });
  check(await answer('No'), 'a script waits in the panel');
  r = await run;
  check(r.error && /chose not/.test(r.text), `and a no stops it: ${r.text.slice(0, 160)}`);
  run = call('javascript', { code: '2 + 2' });
  await answer('This once');
  r = await run;
  check(/4/.test(r.text), `this once runs it: ${r.text.slice(0, 160)}`);
  run = call('javascript', { code: 'await Promise.resolve(document.title)' });
  check(await answer('Always on this site'), 'and asks again the next time');
  r = await run;
  check(/Logs/.test(r.text), `await works: ${r.text.slice(0, 160)}`);
  r = await call('javascript', { code: '6 * 7' });
  check(/42/.test(r.text), `always on this site does not ask again: ${r.text.slice(0, 160)}`);
  r = await call('javascript', { code: 'document.cookie' });
  check(r.error && /cookies/.test(r.text), 'a script cannot read cookies');
  r = await call('javascript', { code: `'token=abcdefghijkl'` });
  check(/\[hidden\]/.test(r.text) && !/abcdefghijkl/.test(r.text), `a credential in the result is hidden: ${r.text.slice(0, 160)}`);
  r = await call('javascript', { code: `throw new Error('nope')` });
  check(r.error && /nope/.test(r.text), 'says when a script fails');
  r = await call('javascript', { code: `document.getElementById('out').textContent = 'set by script'` });
  check((await say('out', m)) === 'set by script', 'and it runs in the page');
  const d = await call('routine_propose', { name: 'logs-replay', description: 'Send a request. Use when the user asks for this.' });
  check(!/set by script|document\.getElementById/.test(d.text), `a script is not in the routine: ${d.text.slice(0, 240)}`);
  await fetch(`${CDP}/json/close/${panel.id}`);
}

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
