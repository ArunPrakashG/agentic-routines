// What the browser features added for parity do, end to end. Started by e2e-parity.sh.
// Each section stands on its own page and session. Clicks a person would make go through CDP, so the page sees them as real.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const CDP = 'http://127.0.0.1:9339';
const SITE = 'http://127.0.0.1:8773';

let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const open = async (name = 'claude-code') => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME } });
  const c = new Client({ name, version: '2.0.0' });
  await c.connect(transport);
  return c;
};
let client = await open();
const session = async () => {
  await client?.close();
  client = await open();
};
const callOn = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 900_000 });
  return { text: r.content.map((x) => x.text ?? `[${x.type}]`).join('\n'), error: !!r.isError };
};
const call = (name, args) => callOn(client, name, args);
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/(?:f\d+:)?ref_\d+/)?.[0];
const read = async (args = {}) => (await call('read_page', args)).text;

async function cdp(target, method, params = {}) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return out.result;
}
const pageOf = async (match) => (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes(match));
const evalIn = async (match, expression) => (await cdp(await pageOf(match), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
/** In the extension's own service worker, for what only the browser's own buttons can do. */
const inExtension = async (expression) => {
  const sw = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'));
  return (await cdp(sw, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
};
const realClick = async (match, x, y) => {
  const t = await pageOf(match);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp(t, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
const toolbar = (match) => inExtension(`chrome.tabs.query({}).then((ts) => { const t = ts.find((x) => (x.url ?? '').includes(${JSON.stringify(match)})); chrome.action.onClicked.dispatch(t); return t.id; })`);
const badgeOf = (id) => inExtension(`chrome.action.getBadgeText({ tabId: ${id} })`);
// The card sits in a closed root, so where it is comes from its host: the last element of the body. Its button fills the bottom.
const cardRect = (match) => evalIn(match, `(() => { const h = [...document.querySelectorAll('body > div, html > div')].find((d) => d.style.zIndex === '2147483647'); if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 38, connected: h.isConnected }; })()`);
const clickCard = async (match) => {
  const r = await cardRect(match);
  await realClick(match, r.x, r.y);
};
const pending = async (p, ms = 1500) => (await Promise.race([p.then(() => false), sleep(ms).then(() => true)]));
const CHORES = `${SITE}/chores.html`;
const CHALLENGE = `${SITE}/challenge.html`;
const draftOf = (t) => /draft_id "(d-[a-z0-9]+)"/.exec(t)?.[1];

// ---------- handing a tab to the person ----------
{
  await session();
  const nav = await call('navigate', { url: CHORES });
  const tab = Number(/\(tab (\d+)\)/.exec(nav.text)?.[1]);
  const asking = call('handoff', { reason: 'Sign in for me' });
  await sleep(800);
  check(!!(await cardRect('chores.html')), 'the card is on the page');
  check((await badgeOf(tab)) === 'WAIT', 'the badge says WAIT');
  const page = await pageOf('chores.html');
  check(/with the user/.test((await call('read_page')).text), 'no tool can touch the tab while it is with the person');
  await evalIn('chores.html', `(() => { const h = [...document.querySelectorAll('body > div')].find((d) => d.style.zIndex === '2147483647'); h.click(); h.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
  check(await pending(asking), 'a click the page scripts does not finish it');
  await evalIn('chores.html', `[...document.querySelectorAll('body > div')].find((d) => d.style.zIndex === '2147483647').remove()`);
  await sleep(200);
  check(!!(await cardRect('chores.html')), 'a page that takes the card away gets it back');
  await cdp(page, 'Page.reload');
  await sleep(1500);
  check(!!(await cardRect('chores.html')), 'the card comes back on a new document');
  await clickCard('chores.html');
  const back = await asking;
  check(/gave the tab back \(card\)/.test(back.text), `a real click gives it back: ${back.text.slice(0, 120)}`);
  check(!(await cardRect('chores.html')), 'the card is gone');
  check(!/with the user/.test((await call('read_page')).text), 'and the tools work again');

  const short = await call('handoff', { reason: 'Still here?', wait_seconds: 5 });
  check(/Still with the user/.test(short.text) && !!(await cardRect('chores.html')), 'a wait that runs out leaves the card up');
  const again = call('handoff', { reason: 'Still here?' });
  await sleep(500);
  await toolbar('chores.html');
  check(/gave the tab back \(toolbar\)/.test((await again).text), 'the toolbar button gives it back too, to a second call that picked it up');
}

// ---------- a routine that hands over ----------
{
  await session();
  await call('navigate', { url: CHORES });
  const page = await read();
  await call('type', { ref: refFor(page, /textbox.*Item/i), text: 'Oak' });
  await call('click', { ref: refFor(page, /button.*Add item/i) });
  const asking = call('handoff', { reason: 'Check the list' });
  await sleep(800);
  await clickCard('chores.html');
  await asking;
  const proposed = await call('routine_propose', { name: 'hand-over-chore', description: 'Adds an item and asks. Use when testing.' });
  const id = draftOf(proposed.text);
  check(/Hand over: Check the list/.test(proposed.text), `the hand-over is a step of the draft: ${proposed.text.slice(0, 200)}`);
  const test = await call('routine_test', { draft_id: id });
  check(/hands over to the user|skipped/i.test(test.text), `a test skips it and says so: ${test.text.slice(0, 200)}`);
  await call('routine_save', { draft_id: id });
  await call('navigate', { url: CHORES });
  const running = call('routine_run', { name: 'hand-over-chore', params: { item: 'Elm' } });
  for (let i = 0; i < 40 && !(await cardRect('chores.html').catch(() => null)); i++) await sleep(250);
  check(await pending(running, 800), 'the replay waits at the hand-over');
  await clickCard('chores.html');
  const done = await running;
  check(/^Done/m.test(done.text) && /went to the user/.test(done.text), `and carries on: ${done.text.slice(0, 200)}`);
}

// ---------- a bot check is reported and handed over, never solved ----------
{
  await session();
  const nav = await call('navigate', { url: CHALLENGE });
  check(/bot check/.test(nav.text) && /handoff/.test(nav.text), `navigate reports it: ${nav.text.slice(-200)}`);
  check(/bot check/.test((await call('read_page')).text), 'read_page reports it');
  const asking = call('handoff', { reason: 'Please pass the check' });
  await sleep(800);
  await evalIn('challenge.html', `document.getElementById('pass').click()`);
  await clickCard('challenge.html');
  await asking;
  check(!/bot check/.test((await call('read_page')).text), 'once the person is through, it is not reported');
}

// ---------- lending a tab ----------
{
  await session();
  const before = await (await fetch(`${CDP}/json/new?${encodeURIComponent(`${CHORES}?lent=1`)}`, { method: 'PUT' })).json();
  await sleep(800);
  const refused = await call('session_adopt', { url: `${CHORES}?lent=1` });
  check(refused.error && /not been lent/.test(refused.text), `a tab not lent cannot be adopted: ${refused.text.slice(0, 120)}`);
  const id = await toolbar('lent=1');
  await sleep(300);
  check((await badgeOf(id)) === 'ON', 'the toolbar button lends it, and the badge says ON');
  check(/"lent": ?true/.test((await call('tabs')).text), 'the tabs tool marks it');
  const adopted = await call('session_adopt', { url: `${CHORES}?lent=1` });
  check(!adopted.error && new RegExp(`tab ${id}`).test(adopted.text), `adopted by address: ${adopted.text.slice(0, 120)}`);
  check((await badgeOf(id)) === 'RUN', 'the badge says RUN');
  const page = await read();
  await call('type', { ref: refFor(page, /textbox.*Item/i), text: 'Lent' });
  await call('click', { ref: refFor(page, /button.*Add item/i) });
  const proposed = await call('routine_propose', { name: 'from-a-lent-tab', description: 'Use when testing.' });
  check(/Add item/.test(proposed.text), 'what it did there is recorded');
  const closing = await call('close_tab', { tab_id: id });
  check(closing.error && /stays open/.test(closing.text), 'it cannot close it');
  await toolbar('lent=1');
  await sleep(300);
  check(!(await badgeOf(id)), 'clicking again takes it back');
  const told = await call('read_page');
  check(told.error && /took tab/.test(told.text), `the agent is told: ${told.text.slice(0, 120)}`);
  check((await call('session_adopt', { tab_id: id })).error, 'and it cannot adopt it again until it is lent again');
  await fetch(`${CDP}/json/close/${before.id}`);
}

// ---------- named sessions ----------
{
  await session();
  const OTHER = SITE.replace('127.0.0.1', 'localhost');
  const tabList = async () => JSON.parse(/\[[\s\S]*\]/.exec((await call('tabs')).text)[0]);
  const made = await call('session_new', { name: 'limits', hosts: ['127.0.0.1'] });
  check(!made.error && /only 127.0.0.1/.test(made.text), 'session_new starts a session held to a site');
  check(!(await call('navigate', { url: CHORES })).error, 'a listed site opens');
  const off = await call('navigate', { url: `${OTHER}/chores.html` });
  check(off.error && /outside this session/.test(off.text), 'an address off the list is refused');
  check((await call('navigate', { url: `${OTHER}/chores.html`, new_tab: true })).error, 'so is a new tab to one');
  const redirect = await call('navigate', { url: `${SITE}/away.html?go` });
  check(redirect.error && /outside this session/.test(redirect.text), 'a redirect off the list is stopped and said');
  check(!(await call('navigate', { url: `${SITE}/away.html` })).error, 'and the session can go on from a listed page');
  await call('click', { ref: refFor(await read(), /Open elsewhere/) });
  await sleep(800);
  check(!(await pageOf('localhost:8773')), 'a popup off the list is closed');
  check(/outside this session/.test((await call('read_page')).text), 'and the session hears about it once');
  await call('click', { ref: refFor(await read(), /Open here/) });
  await sleep(500);
  check(!!(await pageOf('chores.html?popup')), 'a popup on the list opens');
  check(!/localhost/.test((await call('tabs')).text), 'tabs shows only listed sites');
  const wider = await call('session_allowlist', { name: 'limits', hosts: ['127.0.0.1', 'example.com'] });
  check(wider.error && /Only the person/.test(wider.text), 'an agent cannot widen a list');

  const tabId = (await tabList()).find((t) => t.held_by === 'you')?.id;
  await session();
  check(!(await call('session_use', { name: 'limits' })).error, 'a new server picks the session up by name');
  check((await tabList()).find((t) => t.held_by === 'you')?.id === tabId, 'and it still has its tab after the old server went away');
  check(/→ limits/.test((await call('session_list')).text), 'session_list marks the one in use');
  await call('session_reset', { name: 'limits' });
  await sleep(500);
  check(!/held_by/.test((await call('tabs')).text), 'session_reset leaves it with no tab');

  await call('session_new', { name: 'looking', read_only: true });
  await call('navigate', { url: CHORES });
  const typed = await call('type', { ref: refFor(await read(), /Item/), text: 'x' });
  check(typed.error && /read-only/.test(typed.text), 'a read-only session cannot type');
  check((await call('click', { ref: refFor(await read(), /Add item/) })).error, 'or click');
  check(!(await call('read_page')).error, 'but can read');

  // A public name that answers from this computer, as a rebinding attack would. Needs a resolver that knows it.
  await call('session_new', { name: 'rebind', hosts: ['127.0.0.1.nip.io'] });
  const rebound = await call('navigate', { url: SITE.replace('127.0.0.1', '127.0.0.1.nip.io') + '/chores.html' });
  check(rebound.error && /private address/.test(rebound.text), 'a listed name on a private address is left');

  for (const name of ['limits', 'looking', 'rebind']) await call('session_delete', { name });
  check(/No named sessions/.test((await call('session_list')).text), 'session_delete forgets them');
}

await client.close();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
