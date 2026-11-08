// What the browser features added for parity do, end to end. Started by e2e-parity.sh.
// Each section stands on its own page and session. Clicks a person would make go through CDP, so the page sees them as real.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) res(m);
    };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  return out.result;
}
const pageOf = async (match) => (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.includes(match));
const evalIn = async (match, expression) => (await cdp(await pageOf(match), 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
// Chromium runs extensions of its own too.
const OURS = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo/';
/** In the extension's own service worker, for what only the browser's own buttons can do. */
const inExtension = async (expression) => {
  const sw = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'service_worker' && x.url.startsWith(OURS));
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
  const proposed = await call('routine_propose', { name: 'from-a-lent-tab', description: 'Adds an item in a lent tab. Use when testing.' });
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

// ---------- settings, status, cleanup ----------
{
  await session();
  const read0 = JSON.parse((await call('settings')).text);
  check(read0.grouping === 'session' && read0.idleMinutes === 30, 'settings reads the defaults');
  const changed = JSON.parse((await call('settings', { idle_close_minutes: 10, agent_cursor: false })).text);
  check(changed.idleMinutes === 10 && changed.agentCursor === false, 'settings changes them');
  const wrote = await inExtension(`chrome.storage.local.get('settings').then((s) => s.settings.idleMinutes)`);
  check(wrote === 10, 'and the browser has the change');
  const bad = await client.callTool({ name: 'settings', arguments: { update_channel: 'off' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  check(!(await inExtension(`chrome.storage.local.get('settings').then((s) => 'update_channel' in s.settings)`)), 'a setting it does not know goes nowhere');
  await call('settings', { idle_close_minutes: 30, agent_cursor: true });

  await call('navigate', { url: CHORES });
  await call('navigate', { url: `${CHORES}?second`, new_tab: true });
  const stat = await call('status');
  check(/Tabs lent by the person: 0/.test(stat.text) && /\?second \(working here\)/.test(stat.text), 'status says what the session has open and where it is working');
  const cleaned = await call('tabs_cleanup');
  check(/Closed 1 tab/.test(cleaned.text), 'tabs_cleanup closes the tab it left');
  check(!!(await pageOf('?second')), 'and keeps the one it is in');

  await call('settings', { grouping: 'none' });
  await session();
  await call('navigate', { url: `${CHORES}?grouped` });
  const groupId = await inExtension(`chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url ?? '').includes('?grouped')).groupId)`);
  check(groupId === -1, 'grouping none leaves the tab out of any group');
  await call('settings', { grouping: 'session', tabs_where: 'separate' });
  await session();
  const windowsBefore = await inExtension(`chrome.windows.getAll().then((w) => w.length)`);
  await call('navigate', { url: `${CHORES}?apart` });
  check((await inExtension(`chrome.windows.getAll().then((w) => w.length)`)) === windowsBefore + 1, 'a separate window opens for agent tabs');
  await call('settings', { tabs_where: 'auto' });
  await session();
}

// ---------- secrets kept for a site ----------
{
  await session();
  const { add, remove, totp } = await import(`${CLI}/src/store/secrets.ts`).catch(() => ({}));
  check(!!add, 'the store can be loaded directly for the test (node strips types)');
  const value = 'correct-horse-9142';
  await add({ name: 'site_pw', origin: SITE, kind: 'value', value });
  await add({ name: 'other_pw', origin: 'https://example.com', kind: 'value', value: 'not-for-this-site' });
  await add({ name: 'site_code', origin: SITE, kind: 'totp', value: 'JBSWY3DPEHPK3PXP' });
  const names = await call('secrets_list');
  check(/site_pw/.test(names.text) && !names.text.includes(value), 'secrets_list gives names and no value');

  await call('navigate', { url: `${SITE}/fields.html` });
  const outline = await read();
  const field = refFor(outline, /textbox “Name”/);
  const typed = await call('type_secret', { ref: field, name: 'site_pw' });
  check(!typed.error && !typed.text.includes(value), 'type_secret types it and does not say it');
  const after = await read();
  check(!after.includes(value) && /\(filled\)/.test(after), 'read_page says filled, even in a plain text field');
  const inPage = await evalIn('fields.html', `[...document.querySelectorAll('input,textarea')].some((e) => e.value === ${JSON.stringify(value)})`);
  check(inPage === true, 'the value is really in the field');
  const shown = await evalIn('fields.html', `getComputedStyle([...document.querySelectorAll('input,textarea')].find((e) => e.value === ${JSON.stringify(value)})).webkitTextSecurity`);
  check(shown === 'disc', 'and shows as dots in a picture');
  const script = await call('javascript', { code: 'document.title' });
  check(script.error && /no script may run/.test(script.text), 'no script runs in the tab after that');

  const wrong = await call('type_secret', { ref: refFor(await read(), /textbox “Name”/), name: 'other_pw' });
  check(wrong.error && /kept for/.test(wrong.text) && !wrong.text.includes('not-for-this-site'), 'a secret for another site does not go in');
  await call('navigate', { url: `${SITE}/frames.html` });
  const framed = refFor(await read(), /^.*f\d+:ref_\d+.*textbox/m) ?? refFor(await read(), /f\d+:ref_\d+/);
  if (framed) check((await call('type_secret', { ref: framed, name: 'other_pw' })).error, 'nor in a frame of a site it was not kept for');
  await call('navigate', { url: `${SITE}/fields.html` });
  const code = await call('type_secret', { ref: refFor(await read(), /textbox “Name”/), name: 'site_code' });
  check(!code.error, 'a one-time code goes in by name');
  const day = await call('type_secret', { ref: refFor(await read(), /“Day”/), name: 'site_pw' });
  check(day.error && /not typed text/.test(day.text) && !day.text.includes(value), `a field that takes a date refuses it and says so: ${day.text.slice(0, 160)}`);
  check(/^\d{6}$/.test(totp('JBSWY3DPEHPK3PXP')) && totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000) === '287082', 'and is the code an authenticator would show');

  const run = await call('routine_propose', { name: 'sign-in-with-secret', description: 'Fill the field. Use when testing secrets.' });
  check(!run.text.includes(value) && /\{\{secret:site_pw\}\}|site_pw/.test(run.text), 'a routine proposed from it holds the name, not the value');
  for (const n of ['site_pw', 'other_pw', 'site_code']) await remove(n);
}

// ---------- video, flight recorder, network ----------
{
  const { statSync, readFileSync } = await import('node:fs');
  await session();
  await call('navigate', { url: CHORES });
  const pathOf = (t) => /Saved (\S+)/.exec(t)?.[1];
  const started = await call('recording', { action: 'start', format: 'webm' });
  check(!started.error, 'recording starts');
  const id = JSON.parse(/\[[\s\S]*\]/.exec((await call('tabs')).text)[0]).find((t) => t.held_by === 'you')?.id;
  check((await badgeOf(id)) === 'REC', 'the toolbar button says REC');
  await call('type', { ref: refFor(await read(), /Item/), text: 'on video' });
  await sleep(2500);
  const stopped = await call('recording', { action: 'stop' });
  const video = pathOf(stopped.text);
  check(!!video && statSync(video).size > 1000, 'it leaves a video file');
  check(readFileSync(video).subarray(0, 4).toString('hex') === '1a45dfa3', 'and it really is WebM');
  check((statSync(video).mode & 0o077) === 0, 'readable only by this account');

  const mp4 = await call('recording', { action: 'start', format: 'mp4' });
  if (!mp4.error) {
    await sleep(1500);
    const file = pathOf((await call('recording', { action: 'stop' })).text);
    check(!!file && readFileSync(file).subarray(4, 8).toString() === 'ftyp', 'MP4 is really MP4');
  }

  // Behind another tab: the page is not drawn, and the pictures still have to come.
  await call('recording', { action: 'start' });
  await inExtension(`chrome.tabs.create({ url: 'about:blank', active: true }).then(() => 1)`);
  await sleep(2500);
  const behind = await call('recording', { action: 'stop' });
  check(!behind.error && !!pathOf(behind.text), 'recording works on a tab behind another');

  await call('flight_recorder', { action: 'start' });
  await sleep(2500);
  const kept = await call('flight_recorder', { action: 'save_last' });
  check(!kept.error && !!pathOf(kept.text), 'flight_recorder saves what it kept');
  await call('flight_recorder', { action: 'cancel' });

  await call('network', { action: 'start' });
  await call('navigate', { url: `${SITE}/logs.html?token=abcdef123456` });
  await evalIn('logs.html', `fetch('/chores.html', { method: 'POST', headers: { Authorization: 'Bearer abc123456789' }, body: 'user=me&password=hunter22xyz' }).catch(() => 0)`);
  await sleep(500);
  const har = pathOf((await call('network', { action: 'stop' })).text);
  const raw = readFileSync(har, 'utf8');
  check(!!JSON.parse(raw).log.entries.length, 'network writes a HAR');
  check(!/abc123456789|hunter22xyz|abcdef123456/.test(raw), 'with credentials, passwords and tokens gone');
}

// ---------- a local CDP endpoint, for Playwright ----------
{
  await session();
  const { chromium } = await import(`${CLI}/node_modules/playwright-core/index.mjs`);
  const { default: WebSocket } = await import(`${CLI}/node_modules/ws/wrapper.mjs`);
  const { request } = await import('node:http');
  const raw = (url, headers = {}) =>
    new Promise((resolve) => {
      const r = request(url, { headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve(0));
      r.end();
    });

  await call('navigate', { url: `${SITE}/chores.html` });
  const said = (await call('cdp_endpoint', {})).text;
  const endpoint = /Endpoint: (\S+)/.exec(said)?.[1];
  check(!!endpoint, 'cdp_endpoint gives an address');
  const u = new URL(endpoint);
  check(u.hostname === '127.0.0.1', 'on localhost only');
  check((await raw(`http://127.0.0.1:${u.port}/json/version`)) === 403, 'with no token, refused');
  check((await raw(`http://127.0.0.1:${u.port}/json/version?token=nope`)) === 403, 'with a wrong token, refused');
  check((await raw(`${endpoint.replace('/?', '/json/version?')}`, { Host: 'evil.example' })) === 403, 'with a foreign Host, refused');
  check((await raw(`${endpoint.replace('/?', '/json/version?')}`, { Origin: 'https://evil.example' })) === 403, 'from a web page, refused');
  check((await raw(`${endpoint.replace('/?', '/json/version?')}`)) === 200, 'with the token, it answers');

  // A tab that is the person's, which this session must not see.
  await inExtension(`chrome.tabs.create({ url: '${SITE}/away.html', active: false }).then(() => 1)`);
  const browser = await chromium.connectOverCDP(endpoint);
  const pages = browser.contexts()[0].pages();
  check(pages.length === 1 && pages[0].url().includes('chores.html'), 'Playwright connects, and sees only the session\'s tab');
  await pages[0].fill('#item', 'via playwright');
  await pages[0].click('#add');
  check((await pages[0].textContent('#status')) === 'Added via playwright', 'and drives it');
  await pages[0].evaluate(() => (document.cookie = 'mine=1'));
  const cookies = await browser.contexts()[0].cookies();
  check(cookies.every((c) => c.domain === '127.0.0.1'), 'cookie reads stay on the session\'s pages');
  const cleared = await browser.contexts()[0].clearCookies().then(() => 'done', (e) => e.message);
  check(/refused/.test(cleared), 'clearing data is refused');
  const fresh = await browser.newContext().then(() => 'made', (e) => e.message);
  check(fresh !== 'made', 'a new context is refused');
  const front = await pages[0].bringToFront().then(() => 'done', (e) => e.message);
  check(/refused/.test(front), 'bringToFront is refused');
  const popup = await browser.contexts()[0].newPage();
  check(!!popup, 'a new page opens as a tab of the session');
  await popup.close();
  await browser.close();

  const direct = await new Promise((resolve) => {
    const ws = new WebSocket(endpoint.replace('http://', 'ws://').replace('/?', '/devtools/browser/relay?'));
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
    ws.on('message', (d) => {
      ws.close();
      resolve(JSON.parse(String(d)));
    });
    ws.on('error', () => resolve({ error: { message: 'no connection' } }));
  });
  check(!!direct.error, 'closing the browser is refused');

  const again = await chromium.connectOverCDP(endpoint);
  await again.close();
  check(true, 'a client can come back after the last one left');

  await session();
  check((await raw(`http://127.0.0.1:${u.port}/json/version?token=${u.searchParams.get('token')}`)) === 0, 'when the agent goes, nothing is listening');
}

// ---------- routines as Playwright code, and fast runs ----------
{
  await session();
  const { execFileSync } = await import('node:child_process');
  const name = `fast-${Date.now()}`;
  await call('navigate', { url: `${SITE}/chores.html` });
  await evalIn('chores.html', `localStorage.clear(); sessionStorage.clear(); 1`);
  const page = await read();
  await call('type', { ref: refFor(page, /“Item”/), text: 'first' });
  await call('click', { ref: refFor(page, /“Add item”/) });
  await call('click', { ref: refFor(page, /“Publish list”/) });
  const proposed = await call('routine_propose', { name, description: 'Add a chore and publish the list. Use when a chore needs adding.' });
  const draft = draftOf(proposed.text);
  await call('routine_edit', { draft_id: draft, ops: [{ op: 'param', name: 'item', value: 'first' }] });
  await call('routine_save', { draft_id: draft });

  const code = (await call('routine_playwright', { name })).text;
  check(/getBy|locator/.test(code) && /param\(params, "item"\)/.test(code), 'routine_playwright gives a script with its parameters');
  const out = execFileSync(process.execPath, [`${CLI}/dist/index.js`, 'export', name, '--playwright'], { encoding: 'utf8' });
  check(/No model wrote it/.test(out), 'and so does the CLI');
  check(out === execFileSync(process.execPath, [`${CLI}/dist/index.js`, 'export', name, '--playwright'], { encoding: 'utf8' }), 'the same each time');

  // Publish pauses: a fast run does the rest, stops there, and the replay asks.
  const paused = await call('routine_run', { name, params: { item: 'fast one' }, fast: true });
  check(/Fast run: \d+ step/.test(paused.text), 'a fast run says what it ran');
  check(/paused|waits/i.test(paused.text), 'and stops at the pause');
  check((await evalIn('chores.html', `document.querySelector('#status').textContent`)) !== 'Published 2 items', 'with the step behind the pause not done');
  const run = /rp-[0-9a-f]+/.exec(paused.text)?.[0];
  await call('routine_resume', { run_id: run, approve: false });

  // A button that has gone: it carries on step by step from there, which asks for a choice as any replay would.
  await evalIn('chores.html', `localStorage.setItem('chores.add', 'Add a chore'); 1`);
  const broke = await call('routine_run', { name, params: { item: 'broken' }, fast: true });
  check(/Step by step from step/.test(broke.text), 'on a failure it carries on step by step from that step');
  const rid = /rp-[0-9a-f]+/.exec(broke.text)?.[0];
  if (rid) await call('routine_resume', { run_id: rid, approve: false });
  await evalIn('chores.html', `localStorage.removeItem('chores.add'); 1`);
}

// ---------- execute: Playwright code on the session's page ----------
{
  await session();
  await call('navigate', { url: `${SITE}/chores.html` });
  const title = await call('execute', { code: `console.log('hello'); return { title: await page.title(), n: await page.locator('button').count() };` });
  check(/"title":"Chores"/.test(title.text) && /hello/.test(title.text), `code runs on the page, sees the page's own title, and says what it returned and logged: ${title.text.slice(0, 200)}`);

  const bare = await call('execute', { code: `return [typeof process, typeof require, typeof fetch, typeof Buffer].join();` });
  check(/undefined,undefined,undefined,undefined/.test(bare.text), 'it has no Node');
  const imported = await call('execute', { code: `return await import('node:fs').catch((e) => { try { return typeof e.constructor.constructor('return process')(); } catch { return 'shut'; } });` });
  check(/shut/.test(imported.text), 'import gives nothing to climb out with');
  const shot = await call('execute', { code: `await page.screenshot({ path: '/tmp/agentic-routines-should-not-exist.png' });` });
  check(/with a path is not available/.test(shot.text), 'a path to a file is refused');
  const browserRoute = await call('execute', { code: `await context.browser();` });
  check(/not available/.test(browserRoute.text), 'the browser itself stays out of reach');
  const written = await call('execute', { code: `return files.write('../../note.txt', 'hi');` });
  check(/agentic-routines-execute-[^/]+\/_?\.?\.?_?\.?\.?_?note\.txt/.test(written.text), 'files.write stays in a folder of its own');

  const looped = await call('execute', { code: `while (true) {}` });
  check(/without yielding/.test(looped.text), 'code that does not yield is stopped');
  const after = await call('read_page', {});
  check(/Chores/.test(after.text), 'and the server carries on');

  await call('type', { ref: refFor(after.text, /Item/), text: 'stepped' });
  await call('click', { ref: refFor(after.text, /Add item/) });
  const acted = await call('execute', { code: `await page.locator('#item').fill('by code'); await page.locator('#add').click(); return 1;` });
  check(/Did, in order/.test(acted.text) && /fill\(\)/.test(acted.text) && !/by code/.test(acted.text.split('Did, in order')[1]), 'what it did is listed, without the values');
  check(/cannot become a routine/.test(acted.text), 'the agent is told it cannot become a routine');
  const proposed = await call('routine_propose', { name: 'pr-execute-kept', description: 'Add a chore. Use when a chore needs adding.' });
  check(/Not in these steps: the run also used execute/.test(proposed.text), 'proposing the run says what is missing from it');
}

// ---------- a browser on another computer, on this one ----------
{
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // The agent's computer is another home. The browser keeps its native link to this one all along.
  const far = mkdtempSync(join(tmpdir(), 'ar-far-'));
  const cli = (args) => execFileSync(process.execPath, [`${CLI}/dist/index.js`, ...args], { env: { ...process.env, AGENTIC_ROUTINES_HOME: far }, encoding: 'utf8' });
  const listener = () => JSON.parse(readFileSync(`${far}/remote/listener.json`, 'utf8'));
  const code = /Code: (\S+)/.exec(cli(['remote', 'pair', '127.0.0.1:47990']))?.[1];
  // Pairing leaves a listener running, which a test that stops early must not leave behind.
  process.on('exit', () => {
    try {
      cli(['remote', 'stop']);
    } catch {}
  });
  check(!!code, 'pairing gives a code without a terminal, as the person typing it is what connects it');

  // What the settings form sends. The form itself is for a person to look at.
  const panelTab = await (await fetch(`${CDP}/json/new?${OURS}sidepanel.html`, { method: 'PUT' })).json();
  await sleep(1000);
  const toPanel = async (command) => (await cdp(panelTab, 'Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((res) => { const p = chrome.runtime.connect({ name: 'panel' }); p.onMessage.addListener((m) => { if (m.reqId === 1) { p.disconnect(); res(m.err ?? 'done'); } }); p.postMessage(${JSON.stringify({ ...command, reqId: 1 })}); })` })).result.value;
  check(/say-so/.test(await toPanel({ t: 'linkPair', address: '93.184.216.34', code })), 'a public address needs the person to confirm');
  check(/Turned down/.test(await toPanel({ t: 'linkPair', address: '127.0.0.1:47990', code: 'AAAA-AAAA' })), 'a wrong code is turned down');
  check((await toPanel({ t: 'linkPair', address: '127.0.0.1:47990', code })) === 'done', 'the right code connects the service worker to the listener');
  await sleep(1000);
  check(listener().connected.length === 1, 'the listener has it');

  const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { PATH: process.env.PATH, HOME: process.env.DEV_DIR, AGENTIC_ROUTINES_HOME: far } });
  const farClient = new Client({ name: 'far', version: '2.0.0' });
  await farClient.connect(transport);
  const farCall = (name, args = {}) => callOn(farClient, name, args);
  check(/chores\.html/.test((await farCall('navigate', { url: `${SITE}/chores.html` })).text), 'an agent on the other computer drives the browser');
  check(/Chores/.test((await farCall('read_page')).text), 'and reads it');
  check(/another computer/.test((await farCall('browser_profile')).text), 'and is told where the browser is');
  check(/127\.0\.0\.1/.test((await farCall('cdp_endpoint')).text), 'the DevTools address is on the agent\'s computer');
  check(/"?Chores/.test((await farCall('execute', { code: 'return await page.title();' })).text), 'and execute works through it');
  check(!(await call('tabs')).error, 'an agent on this computer still works alongside');

  const file = `${far}/report.txt`;
  writeFileSync(file, 'the agent has this file');
  await farCall('navigate', { url: `${SITE}/upload.html` });
  const ref = refFor((await farCall('read_page')).text, /Choose files/);
  check(!(await farCall('upload', { ref, path: file })).error, 'an upload crosses the link');
  check(/report\.txt/.test((await farCall('read_page', { filter: 'all' })).text), 'and the page has the file');

  await farCall('navigate', { url: `${SITE}/chores.html` });
  await farCall('execute', { code: `await page.evaluate(() => { const a = document.createElement('a'); a.href = '/chores.html'; a.download = 'chores-copy.html'; document.body.append(a); a.click(); });` });
  await sleep(1500);
  const list = (await farCall('download')).text;
  check(/chores-copy/.test(list), 'the download is on the list');
  const got = (await farCall('download', { id: Number(/^(\d+)\s+chores-copy/m.exec(list)?.[1]) })).text;
  const path = /(\S+downloads\S+) \(/.exec(got)?.[1];
  check(path?.startsWith(far) && readFileSync(path, 'utf8').includes('<title>Chores'), 'and comes over to the agent\'s computer');
  await farClient.close();

  const id = /^\s*([0-9a-f]{16})\s/m.exec(cli(['remote', 'status']))?.[1];
  cli(['remote', 'revoke', id]);
  await sleep(4000);
  check(listener().connected.length === 0, 'a revoked key is dropped');
  check((await toPanel({ t: 'linkForget' })) === 'done', 'and the panel can forget the link');
  await fetch(`${CDP}/json/close/${panelTab.id}`);
  cli(['remote', 'stop']);
  await sleep(4000);
  check(/Not listening|nothing is listening/.test(cli(['remote', 'status'])), 'it can stop listening');
}

// ---------- input at a person's pace ----------
{
  await session();
  const before = JSON.parse((await call('settings', {})).text);
  check(before.humanInput === false, "input at a person's pace is off by default");
  let page = await call('navigate', { url: `${SITE}/chores.html` });
  page = await call('read_page', {});
  const t0 = Date.now();
  await call('type', { ref: refFor(page.text, /textbox.*Item/i), text: 'fast' });
  const quick = Date.now() - t0;
  await call('settings', { human_input: true });
  check(JSON.parse((await call('settings', {})).text).humanInput === true, 'a setting turns it on');
  page = await call('read_page', {});
  const t1 = Date.now();
  await call('type', { ref: refFor(page.text, /textbox.*Item/i), text: 'slowly by hand' });
  const slow = Date.now() - t1;
  check(slow > quick, `typing takes longer (${quick} ms, then ${slow} ms)`);
  await evalIn('chores.html', `window.moves = 0; addEventListener('mousemove', () => window.moves++); 1`);
  page = await call('read_page', {});
  await call('click', { ref: refFor(page.text, /Publish list/) });
  await call('click', { ref: refFor(page.text, /Add item/) });
  check((await evalIn('chores.html', 'window.moves')) > 3, 'the pointer moves on its way, rather than jumping');
  check(/slowly by hand/.test((await call('read_page', { filter: 'all' })).text), 'and the input still lands');
  await call('settings', { human_input: false });
}

// #130: every tool as a command, in one window with the rest. Each command is its own process.
{
  console.log('Commands');
  const run = (...args) => new Promise((done) => execFile('node', [join(CLI, 'dist/index.js'), ...args, '--session', 'e2e-cli'], { env: process.env, timeout: 90_000 }, (e, out, err) => done({ code: e ? (e.code ?? 1) : 0, out, err })));
  const tools = (await run('tools')).out;
  const { tools: listed } = await client.listTools();
  check(listed.every((t) => new RegExp(`^${t.name}\\b`, 'm').test(tools)), `all ${listed.length} tools are listed`);
  let r = await run('navigate', `${SITE}/chores.html`);
  check(r.code === 0, `navigate works from a terminal: ${r.err.slice(0, 80)}`);
  r = await run('read-page');
  check(/Publish list/.test(r.out), 'and the next command, a new process, reads the same tab');
  const ref = refFor(r.out, /Publish list/);
  check((await run('click', '--ref', ref)).code === 0, 'a flag goes through');
  r = await run('screenshot');
  check(existsSync(r.out.trim().split('\n')[0]), 'an image goes to a file, and the command says where');
  r = await run('click', '--ref', 'nope');
  check(r.code === 1, 'a tool that fails exits 1');
  r = await run('frobnicate');
  check(r.code === 1 && /no command or tool/.test(r.err), 'an unknown command says so');
  r = await run('cdp_endpoint');
  const endpoint = /Endpoint: (http:\/\/127\.0\.0\.1:\S+)/.exec(r.out)?.[1];
  check(!!endpoint, 'the DevTools address is given');
  const stillThere = endpoint && (await fetch(endpoint.replace('/?', '/json/version?')).then((x) => x.ok, () => false));
  check(stillThere, 'and it outlives the command that printed it');
  check((await run('session_delete', 'e2e-cli')).code === 0, 'the session closes');
}

await client.close();
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
