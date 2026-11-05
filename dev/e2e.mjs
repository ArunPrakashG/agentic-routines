// Real-browser check: MCP client (as Claude Code) -> MCP server -> native host -> extension in Chromium.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = `http://127.0.0.1:${process.env.AR_CDP_PORT ?? 9333}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.DEV_DIR;
const HOME = DEV;
const FIXTURES = join(HERE, 'fixtures');
const CLI = join(HERE, '../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const { ToolListChangedNotificationSchema } = await import(`${SDK}/types.js`);
const EXT = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo';
const SITE = `http://127.0.0.1:${process.env.AR_SITE_PORT ?? 8765}`;
const shots = process.argv.includes('--shots');
const STORE = process.env.AGENTIC_ROUTINES_HOME;
const SHOTS = join(DEV, 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

// ---------- CDP ----------
async function cdpTarget(match) {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return list.find((t) => t.type === 'page' && match(t.url));
}
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const wait = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) {
      wait.get(m.id)(m);
      wait.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      wait.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}
async function evalIn(match, expr) {
  const t = await cdpTarget(match);
  if (!t) throw new Error('no target');
  const c = await cdp(t.webSocketDebuggerUrl);
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  c.close();
  return r.result.value;
}

// The side panel, opened as a tab at panel size.
let panel;
async function openPanel(scheme = 'light') {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const b = await cdp(v.webSocketDebuggerUrl);
  const { targetId } = await b.send('Target.createTarget', { url: `${EXT}/sidepanel.html`, newWindow: true });
  b.close();
  await sleep(800);
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === targetId);
  panel = await cdp(t.webSocketDebuggerUrl);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 844, deviceScaleFactor: 1, mobile: false });
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Google's own screen needs a person, so this starts signed in.
  if (shots) mkdirSync(SHOTS, { recursive: true });
  await shot('signin');
  await panel.send('Runtime.evaluate', { expression: `chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' } })`, awaitPromise: true });
  await sleep(300);
}
async function shot(name) {
  await sleep(700);
  if (!shots || !panel) return;
  // A replay fronts the site's window, and a page behind it may never answer a capture.
  await panel.send('Page.bringToFront');
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  log('shot', name);
}
const panelEval = async (expr) => (await panel.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const panelText = () => panelEval('document.body.innerText');
// Waits on what the panel shows, not on the clock: it renders after a push from the background script.
const panelWait = async (re, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (re.test(await panelText())) return true;
    await sleep(100);
  }
  return false;
};
const panelClick = (label) =>
  panelEval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

// ---------- MCP ----------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${CLI}/dist/index.js`, 'mcp'],
  env: { HOME, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: STORE },
  stderr: 'inherit',
});
const client = new Client({ name: 'claude-code', version: '2.0.0' });
let toolsChanged = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => toolsChanged++);
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  const t = r.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
  if (r.isError) log(`${name} error:`, t);
  return t;
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/ref_\d+/)?.[0];

await openPanel(process.argv.includes('--dark') ? 'dark' : 'light');
await sleep(500);
await shot('01-onboarding-or-empty');

// ---------- 1. agent does the task by hand ----------
let t = await call('navigate', { url: `${SITE}/index.html` });
log(t.split('\n')[0]);
let page = await call('read_page');
await call('click', { ref: refFor(page, /“Apps”/) });
page = await call('read_page');
await call('click', { ref: refFor(page, /“Kavyam”/) });
page = await call('read_page');
check(/Create internal testing release/.test(page), 'reached the release page');
const overlayUp = async () => {
  const r = await evalIn((u) => u.startsWith(SITE), "!!document.getElementById('agentic-routines-overlay')");
  return r;
};
check(await overlayUp(), 'the page shows it is being driven while the agent works');
t = await call('upload', { ref: refFor(page, /\(file\)/), path: join(FIXTURES, 'kavyam-2.14.0.aab') });
log('upload:', t);
await call('type', { ref: refFor(page, /“Release name”/), text: '2.14.0 (214)' });
await call('type', { ref: refFor(page, /“Release notes”/), text: 'Faster search.' });
await call('click', { ref: refFor(page, /“Next”/) });
page = await call('read_page');
await call('click', { ref: refFor(page, /“Start rollout/) });
page = await call('read_page', { filter: 'all' });
const status1 = page.split('\n').find((l) => /Rollout started/.test(l)) ?? '';
log(status1.trim());
check(/2\.14\.0 \(214\) · kavyam-2\.14\.0\.aab 21 bytes/.test(status1), 'manual run uploaded the real file and submitted');
await shot('02-library-unsaved-run');

// ---------- 2. save ----------
t = await call('routine_save', {
  name: 'acme-release',
  description: 'Upload an app bundle to Acme internal testing and start the rollout. Use when the user asks to release a build to internal testing.',
  params: { app_bundle: join(FIXTURES, 'kavyam-2.14.0.aab'), version_name: '2.14.0 (214)', release_notes: 'Faster search.' },
});
log(t);
check(/Saved acme-release v1/.test(t), 'routine saved');
check(/pauses before step/.test(t), 'rollout step pauses');
check(/Starts at .*release\.html/.test(t), 'save result names the start address');
for (let i = 0; i < 20 && !toolsChanged; i++) await sleep(150);
const tools = (await client.listTools()).tools;
const rt = tools.find((x) => x.name === 'rt_acme_release');
check(!!rt, 'rt_acme_release tool appeared');
log('rt params:', Object.keys(rt?.inputSchema?.properties ?? {}).join(', '));
await sleep(400);
await shot('03-library-saved');

// ---------- 3. replay, approve the pause in the side panel ----------
const args2 = { app_bundle: join(FIXTURES, 'kavyam-2.15.0.aab'), version_name: '2.15.0 (215)', release_notes: 'Dark mode for the reader.' };
const run1 = call('rt_acme_release', args2);
if (panel) {
  for (let i = 0; i < 60 && !/Paused before step/.test(await panelText()); i++) await sleep(250);
  check(/Paused before step/.test(await panelText()), 'panel shows the pause card');
  await shot('04-replay-paused');
  check(await panelClick('Start rollout'), 'approved in the panel');
}
t = await run1;
log(t);
check(/^Done/.test(t), 'replay finished');
await sleep(900);
check(!(await overlayUp()), 'the glow is gone when the replay ends');
check(/user approved step 6 .* in the side panel/.test(t), 'agent is told the pause was approved in the panel');
page = await call('read_page', { filter: 'all' });
const status2 = page.split('\n').find((l) => /Rollout started/.test(l)) ?? '';
log(status2.trim());
check(/2\.15\.0 \(215\) · kavyam-2\.15\.0\.aab 28 bytes · notes: Dark mode for the reader\./.test(status2), 'replay used the new values and file');
await shot('05-replay-done');
if (panel) await panelClick('Back to routines');

// ---------- 4. the page changes: Next becomes "Review release" ----------
await evalIn((u) => u.startsWith(SITE), "localStorage.variant = 'b'");
const run2 = call('rt_acme_release', args2);
t = await run2;
log(t);
check(/changed/.test(t), 'changed step reported to the agent');
await shot('06-replay-needs-choice');
const choice = refFor(t, /Review release/);
check(!!choice, 'renamed button offered as a candidate');
const runId = t.match(/run_id "([^"]+)"/)?.[1];
const run3 = call('routine_resume', { run_id: runId, choice });
if (panel) {
  for (let i = 0; i < 60 && !/Paused before step/.test(await panelText()); i++) await sleep(250);
  await shot('07-replay-changed-then-paused');
  await panelClick('Start rollout');
}
t = await run3;
log(t);
check(/routine updated to v2/.test(t), 'fix saved as v2');
if (panel) {
  await panelClick('Back to routines');
  await panelWait(/Step \d+ changed on the last run/);
  t = await panelText();
  check(/ran just now/.test(t) && /Step \d+ changed on the last run/.test(t), 'the library shows the last run and the step that changed');
  await shot('07b-library-changed');
}
t = await call('routines_list');
log(t.split('\n').slice(0, 3).join(' | '));

// ---------- 5. v2 replays clean on the changed page ----------
const run4 = call('rt_acme_release', args2);
if (panel) {
  for (let i = 0; i < 60 && !/Paused before step/.test(await panelText()); i++) await sleep(250);
  await panelClick('Start rollout');
}
t = await run4;
log(t);
check(/^Done.*0 model calls/.test(t), 'v2 replays with no model calls');
await evalIn((u) => u.startsWith(SITE), 'delete localStorage.variant');
if (panel) {
  await panelClick('Back to routines');
  await panelWait(/ran just now/);
  check(!/changed on the last run/.test(await panelText()), 'a clean run clears the changed note');
}
await shot('08-library-v2');
if (panel) {
  await panelClick('Run acme-release');
  const asks = await panelWait(/app_bundle[\s\S]*version_name[\s\S]*release_notes/);
  await shot('09-run-inputs');
  check(asks, 'panel asks for the values before running');
}

// ---------- 6. save a run from the side panel ----------
if (panel) {
  await panelClick('Back to routines');
  await call('navigate', { url: `${SITE}/index.html` });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Apps”/) });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Kavyam”/) });
  page = await call('read_page');
  await call('type', { ref: refFor(page, /“Release name”/), text: '3.0.0 (300)' });
  await call('type', { ref: refFor(page, /“Release notes”/), text: 'Big one.' });
  await call('click', { ref: refFor(page, /“Next”/) });
  await sleep(600);
  check(await panelClick('Save'), 'opened Save from the unsaved run card');
  await sleep(400);
  const setVal = (sel, v) =>
    panelEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await setVal('input.input', 'acme-draft');
  await setVal('textarea', 'Fill in a release draft without submitting. Use when the user asks to prepare a release.');
  await panelClick('Keep release_notes fixed');
  await shot('10-save');
  const txt = await panelText();
  check(/release_name|version|release/.test(txt) && /direct URL/.test(txt), 'save view shows params and the direct-URL step');
  await panelClick('Save routine');
  await sleep(1200);
  t = await call('routines_list');
  check(/acme-draft v1/.test(t), 'routine saved from the panel is visible to the agent');
  const md = await (await import('node:fs/promises')).readFile(join(STORE, 'routines/local/acme-draft/steps.json'), 'utf8');
  check(md.includes('Big one.') && md.includes('{{release_name}}'), 'fixed value kept, other value is a param');
  await shot('11-library-two');
}

// ---------- 7. choosing what a routine keeps ----------
{
  await call('navigate', { url: `${SITE}/apps.html` });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Kavyam”/) });
  page = await call('read_page');
  await call('type', { ref: refFor(page, /“Release name”/), text: 'typo' });
  await call('type', { ref: refFor(page, /“Release name”/), text: '3.0.0' });
  await call('type', { ref: refFor(page, /“Release notes”/), text: 'Stays the same.' });
  const steps = await call('run_steps');
  log(steps.replace(/\n/g, ' / '));
  const num = (re) => Number(steps.split('\n').find((l) => re.test(l))?.match(/^\d+/)?.[0]);
  const bad = await client.callTool({ name: 'routine_save', arguments: { name: 'acme-bad', description: 'Never saved. Use when testing the check.', params: { nope: 'never typed' } } });
  check(bad.isError && /nope/.test(bad.content[0].text), 'a param that was never typed is refused');
  t = await call('routine_save', { name: 'acme-latest', description: 'Name a release of the first app. Use when the user asks for this.', params: { release_name: '3.0.0' }, leave_out: [num(/: typo/)], first_in_list: [num(/click .*Kavyam/)] });
  log(t.replace(/\n/g, ' '));
  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(join(STORE, 'routines/local/acme-latest/steps.json'), 'utf8'));
  const list = saved.steps ?? saved;
  check(JSON.stringify(list).includes('{{release_name}}') && JSON.stringify(list).includes('Stays the same.') && !JSON.stringify(list).includes('release_notes}}'), 'only the named value is a param');
  check(!JSON.stringify(list).includes('typo'), 'left out the retried step');
  check(/apps\.html/.test(list[0].url) && list.some((x) => x.pick === 'first'), 'starts at the list and picks the first row');

  await call('navigate', { url: `${SITE}/apps.html` });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Swap order”/) });
  t = await call('routine_run', { name: 'acme-latest', params: { release_name: '3.0.1' } });
  log(t.split('\n')[0]);
  const tabs = JSON.parse(await call('tabs'));
  check(/^Done/.test(t) && tabs.some((x) => x.active && /app=2/.test(x.url)), 'replay follows the row that is first now');
}

// ---------- 8. the agent goes away during a pause ----------
{
  await evalIn((u) => u.startsWith(SITE), "localStorage.variant = 'b'");
  const other = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: STORE }, stderr: 'inherit' });
  const c2 = new Client({ name: 'claude-code', version: '2.0.0' });
  await c2.connect(other);
  c2.callTool({ name: 'routine_run', arguments: { name: 'acme-release', params: { app_bundle: join(FIXTURES, 'kavyam-2.15.0.aab'), version_name: '9.9.9', release_notes: 'Nobody home.' } } }, undefined, { timeout: 60_000 }).catch(() => {});
  let paused = false;
  for (let i = 0; i < 40 && !paused; i++) {
    await sleep(500);
    paused = /Paused before step/.test(await panelText());
  }
  check(paused, 'a second agent paused in the panel');
  await c2.close();
  await sleep(1500);
  const after = await panelText();
  log(after.split('\n').slice(0, 6).join(' / '));
  check(!/Paused before step/.test(after), 'the pause ends when its agent disconnects');
  check(/disconnected/.test(after), 'the panel says the agent is gone');
  await evalIn((u) => u.startsWith(SITE), 'delete localStorage.variant');
}

// ---------- 9. publishing to the directory ----------
if (panel) {
  const { createServer } = await import('node:http');
  // A stand-in for the directory: the real service is checked by e2e-api.mjs, this checks what the extension sends and shows.
  const seen = [];
  let handleTries = 0;
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url === '/api/v1/me/handle') {
        if (++handleTries === 1) return void ((res.statusCode = 409), res.end('{"error":"handle_taken"}'));
        return void res.end(JSON.stringify({ handle: body.handle }));
      }
      const m = req.url.match(/^\/api\/v1\/routines\/([a-z0-9-]+)$/);
      if (req.method === 'PUT' && m) return void res.end(JSON.stringify({ owner: 'tester', name: m[1], version: 1 }));
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((r) => api.listen(8787, '127.0.0.1', r));

  const waitText = async (re, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (re.test(await panelText())) return true;
      await sleep(100);
    }
    return false;
  };
  const setVal = (sel, v) =>
    panelEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const ask = (name) =>
    client
      .callTool({ name: 'routine_publish', arguments: { name } }, undefined, { timeout: 60_000 })
      .then((r) => ({ text: r.content.map((c) => c.text ?? '').join('\n'), error: !!r.isError }), (e) => ({ text: e.message, error: true }));
  if (/Back to routines/.test(await panelText())) await panelClick('Back to routines');

  // An agent asks. Nothing is public until the person says yes in the panel.
  const asked = ask('acme-draft');
  check(await waitText(/Claude Code wants to submit/), 'the panel shows that the agent wants to publish');
  let txt = await panelText();
  check(/acme-draft/.test(txt) && /These values become public/.test(txt) && /Big one\./.test(txt), 'it lists the typed values that become public');
  check(!seen.some((x) => x.method === 'PUT'), 'nothing was sent yet');
  await shot('12-publish-ask');
  await setVal('.pubcard input.input', 'taken');
  await panelClick('Submit for review');
  check(await waitText(/That name is taken/), 'a name that is taken says so');
  await setVal('.pubcard input.input', 'tester');
  await panelClick('Submit for review');
  check(await waitText(/Sent for review/), 'the card says it is sent for review');
  const done = await asked;
  check(!done.error && /Sent tester\/acme-draft v1 for review/.test(done.text), 'and the agent that asked is told');
  await shot('13-publish-done');

  const put = seen.find((x) => x.method === 'PUT' && x.url === '/api/v1/routines/acme-draft');
  check(put?.auth === 'Bearer x' && seen.filter((x) => x.url === '/api/v1/me/handle').length === 2, 'the name was claimed after the retry, then the routine was sent as the person');
  check(put?.body.meta.name === 'acme-draft' && put.body.steps.length > 1 && put.body.meta.params.release_name?.type === 'string' && put.body.meta.site, 'with its meta, params and every step');
  check(!JSON.stringify(put?.body).includes('"example"') && !('owner' in put.body.meta), 'and no example values or owner');
  if (process.env.AR_CAPTURE) writeFileSync(join(FIXTURES, 'published-routine.json'), JSON.stringify(put.body, null, 2) + '\n');
  await panelClick('Done');
  txt = await panelText();
  check(/sent for review v1/.test(txt), 'the library marks it sent for review');
  await shot('14-library-published');

  // Saying no.
  const refused = ask('acme-release');
  check(await waitText(/Claude Code wants to submit/), 'a second ask shows its card');
  await panelClick('Not now');
  const no = await refused;
  check(no.error && /chose not to publish/.test(no.text), 'saying no tells the agent');
  await sleep(500);
  check(!/wants to submit/.test(await panelText()) && !seen.some((x) => x.url.endsWith('/acme-release')), 'and nothing was sent');

  // From the library, with no agent asking.
  await panelClick('Submit acme-release for review');
  check((await waitText(/We read every submission/)) && /acme-release/.test(await panelText()), 'the Submit button in the library opens the card');
  await panelClick('Not now');

  // From the Save view.
  await call('navigate', { url: `${SITE}/index.html` });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Apps”/) });
  await sleep(600);
  check(await panelEval(`(() => { const b = [...document.querySelectorAll('.unsaved button')].pop(); if (!b) return false; b.click(); return true; })()`), 'opened Save for the new run');
  await sleep(400);
  await setVal('input.input', 'acme-tiny');
  await setVal('textarea', 'Open the apps list on the test console. Use when the user asks to look at the apps.');
  check(/Submit to the directory for review/.test(await panelText()), 'the Save view offers to submit');
  await panelEval(`document.querySelector('footer input[type=checkbox]').click()`);
  await panelClick('Save routine');
  // Not the Save view's own checkbox label: the card says who can see it.
  const opened = (await waitText(/We read every submission/)) && /acme-tiny/.test(await panelText());
  check(opened, 'saving with the box ticked opens the card for it');
  await panelClick('Not now');
  api.close();
}

const wrapper = await (await import('node:fs/promises')).readFile(join(STORE, 'bin/host'), 'utf8');
check(wrapper.includes(join(STORE, 'bin/host.cjs')) && !wrapper.includes('dist/'), 'the host runs from its own copy');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await client.close();
panel?.close();
process.exit(failures ? 1 : 0);
