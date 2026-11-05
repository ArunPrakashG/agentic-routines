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
// The tab list is page titles and addresses, so it arrives in the untrusted envelope.
const listTabs = async () => {
  const lines = (await call('tabs')).split('\n').slice(1, -1).filter((l, i) => !(i === 0 || /^Cleaning: /.test(l)));
  return JSON.parse(lines.join('\n'));
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
  const tabs = await listTabs();
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


// ---------- 10. text from a website is data, not orders ----------
{
  const fsp = await import('node:fs/promises');
  if (panel && /Back to routines/.test(await panelText())) await panelClick('Back to routines');
  const ids = (s) => [...s.matchAll(/BEGIN UNTRUSTED DATA ([0-9a-f]{20})/g)].map((m) => m[1]);
  const instructions = client.getInstructions() ?? '';
  check(/untrusted data/i.test(instructions) && /BEGIN UNTRUSTED DATA/.test(instructions), 'the server tells every agent that page text is untrusted data');
  const listed = (await client.listTools()).tools;
  check(['read_page', 'page_llm_content', 'click', 'screenshot'].every((n) => /untrusted/i.test(listed.find((x) => x.name === n)?.description ?? '')), 'the tools that return page text say so in their descriptions');
  const upDesc = listed.find((x) => x.name === 'upload')?.description ?? '';
  check(/ref/.test(upDesc) && /absolute path/i.test(upDesc) && /do not click/i.test(upDesc), 'the upload description says to pass the ref of the button or input and an absolute path');

  t = await call('navigate', { url: `${SITE}/injection.html` });
  check(/⟨untrusted [0-9a-f]{20}⟩Order 4521/.test(t), 'a page title is quoted as data in the navigate result');
  const inj1 = await call('read_page');
  const inj2 = await call('read_page');
  const [id1] = ids(inj1);
  check(ids(inj1).length === 1 && !!id1 && inj1.includes(`END UNTRUSTED DATA ${id1}`), 'read_page output sits between matching BEGIN and END lines');
  check(!!ids(inj2)[0] && ids(inj2)[0] !== id1, 'the boundary is different for every call');
  check(/not from the user/.test(inj1), 'with a one-line reminder inside it');
  check(!/HIDDEN-/.test(inj1), 'none of the text a person cannot see is in the output');
  check(/Cleaning:.*left out/.test(inj1), 'and it says that hidden text was left out');
  check(/VISIBLE-1/.test(inj1) && /⟦possible injection \(override\)/.test(inj1) && /possible injection \(exfiltration\)/.test(inj1), 'the visible attempt is shown, with its orders marked');
  check(/⟦possible injection \(hidden-text\)/.test(inj1), 'text spelled in invisible characters is called out');
  check(/Status: shipped/.test(inj1) && /Track parcel/.test(inj1), 'zero-width characters are removed and the real page is still readable');
  check(/Warning: this contains text that reads like instructions/.test(inj1), 'a warning follows when anything was marked');
  check(/very long attribute/.test(inj1), 'and a very long attribute value is cut and said so');
  const track = refFor(inj1, /“Track parcel”/);
  t = await call('click', { ref: track });
  check(/⟨untrusted [0-9a-f]{20}⟩/.test(t), 'the click result quotes the element as data');
  // A page that sets up its own end marker cannot close the envelope.
  check(!inj1.split('\n').some((l) => /END UNTRUSTED DATA/.test(l) && !l.includes(id1)), 'nothing in the page can look like the real end line');
  if (panel) await panelClick('Back to routines');
}

// ---------- 11. text a site publishes for models ----------
{
  const { createServer } = await import('node:http');
  const big = 'A line of text that goes on and on.\n'.repeat(60_000);
  const hostOf = (port) => `http://127.0.0.1:${port}`;
  const PORT_A = Number(process.env.AR_SITE_PORT ?? 8765) + 11;
  const PORT_B = PORT_A + 1;
  const other = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/llms.txt' && req.socket.localPort === PORT_A) {
      res.setHeader('content-type', 'text/plain');
      return void res.end(big);
    }
    if (path === '/bare.html') {
      res.setHeader('content-type', 'text/html');
      // Points at the other site: it must not be read, whatever the page says.
      return void res.end(`<!doctype html><title>Bare</title><link rel="alternate" type="text/markdown" href="${hostOf(Number(process.env.AR_SITE_PORT ?? 8765))}/docs-for-models.md"><h1>Bare</h1>`);
    }
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => other.listen(PORT_A, '127.0.0.1', r));
  const other2 = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url.startsWith('/bare.html')) return void res.end(`<!doctype html><title>Bare</title><link rel="alternate" type="text/markdown" href="${hostOf(Number(process.env.AR_SITE_PORT ?? 8765))}/docs-for-models.md"><h1>Bare</h1>`);
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise((r) => other2.listen(PORT_B, '127.0.0.1', r));

  await call('navigate', { url: `${SITE}/docs.html` });
  t = await call('page_llm_content');
  log(t.split('\n').slice(0, 3).join(' | '));
  check(/Found a version of this page \(link-alternate\)/.test(t) && /LINK-ALTERNATE-MARKER/.test(t), 'a <link rel="alternate" type="text/markdown"> is followed and named as the source');
  check(/docs-for-models\.md/.test(t) && /BEGIN UNTRUSTED DATA/.test(t), 'with the address it came from, inside the untrusted envelope');
  check(!/HIDDEN-MDCOMMENT/.test(t) && /HTML comment removed/.test(t), 'comments in the Markdown are removed, and that is said');
  check(/possible injection/.test(t) && /Warning/.test(t), 'orders in the Markdown are marked');

  await call('navigate', { url: `${SITE}/twin.html` });
  t = await call('page_llm_content');
  check(/\(md-twin\)/.test(t) && /MD-TWIN-MARKER/.test(t), 'a .md next to the page is found');

  await call('navigate', { url: `${SITE}/index.html` });
  t = await call('page_llm_content');
  check(/\(llms\.txt\)/.test(t) && /not this page in particular/.test(t) && /Acme Console/.test(t), 'the site’s llms.txt is used, and said to be about the site and not this page');
  t = await call('page_llm_content', { full: true });
  check(/\(llms-full\.txt\)/.test(t) && /FULL-TEXT-MARKER/.test(t), 'full: true prefers llms-full.txt');
  t = await call('page_llm_content', { scope: 'page' });
  check(/publishes no text made for models/.test(t) && /Use read_page instead/.test(t), 'when there is none for this page it says so');

  await call('navigate', { url: `${hostOf(PORT_B)}/bare.html` });
  t = await call('page_llm_content');
  check(/publishes no text made for models/.test(t) && /llms\.txt/.test(t), 'a site with nothing says none exists and lists what was tried');
  check(/a different site than the tab/.test(t) && !/LINK-ALTERNATE-MARKER/.test(t), 'a link to another site is never fetched');

  await call('navigate', { url: `${hostOf(PORT_A)}/bare.html` });
  t = await call('page_llm_content', { max_chars: 1000 });
  check(/cut by the size cap/.test(t) && t.length < 6000, 'a huge file is cut by the size cap');
  other.close();
  other2.close();
}

// ---------- 12. uploads ----------
{
  const fsp = await import('node:fs/promises');
  const aab1 = join(FIXTURES, 'kavyam-2.14.0.aab');
  const aab2 = join(FIXTURES, 'kavyam-2.15.0.aab');
  const outText = () => evalIn((u) => u.startsWith(SITE), "document.getElementById('out').textContent");
  const raw = async (name, args) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
    return { error: !!r.isError, text: r.content.map((c) => c.text ?? '').join('\n') };
  };
  await call('navigate', { url: `${SITE}/upload.html` });
  page = await call('read_page');
  log(page.split('\n').filter((l) => /file|Choose|Drop|receipt/i.test(l)).join(' | '));
  check(/\(file, multiple\)/.test(page), 'a hidden file input behind a button is listed, with “multiple”');
  const pick = refFor(page, /“Choose files”/);
  t = await call('upload', { ref: pick, paths: [aab1, aab2] });
  log(t);
  check(/Attached 2 files/.test(t), 'several files are attached through the button’s ref, without opening the picker');
  check((await outText()) === 'input: kavyam-2.14.0.aab 21, kavyam-2.15.0.aab 28', 'the page received both files with their sizes');
  t = await call('routine_save', { name: 'acme-attach', description: 'Attach files on the Acme console upload page. Use when the user asks to attach files there.', params: { attachments: `${aab1}\n${aab2}` } });
  check(/Saved acme-attach/.test(t) && /asks for attachments/.test(t), 'a multi-file upload step becomes a parameter');
  t = await call('routine_run', { name: 'acme-attach', params: { attachments: `${aab2}\n${aab1}` } });
  log(t.split('\n')[0]);
  check(/^Done/.test(t) && (await outText()) === 'input: kavyam-2.15.0.aab 28, kavyam-2.14.0.aab 21', 'the routine uploads whatever files it is given next time');
  t = await call('routine_run', { name: 'acme-attach', params: { attachments: join(DEV, 'nope', 'missing.aab') } });
  check(/was not started/.test(t) && /No file at/.test(t), 'a routine run with a missing file fails before anything opens, naming the file');

  page = await call('read_page');
  const zone = refFor(page, /“Drop a file here”/);
  t = await call('upload', { ref: zone, path: aab1 });
  log(t);
  check((await outText()) === 'drop: kavyam-2.14.0.aab 21', 'a drop zone with no input receives the file as a drop');

  const single = refFor(page, /Upload receipt/);
  check(!!single, 'an input hidden behind a label is listed under the label’s text');
  t = await call('upload', { ref: single, path: aab2 });
  check((await outText()) === 'single: kavyam-2.15.0.aab 28', 'and takes a file');
  let r = await raw('upload', { ref: single, paths: [aab1, aab2] });
  check(r.error && /one file|single|more than one/i.test(r.text), 'two files for a one-file input is an error that says why');
  const fileRef = refFor(page, /\(file, multiple\)/);
  r = await raw('click', { ref: fileRef });
  check(r.error && /upload/.test(r.text), 'clicking the input itself is refused, with a pointer to upload');

  r = await raw('upload', { ref: pick, path: join(DEV, 'nope', 'missing.aab') });
  check(r.error && /No file at/.test(r.text), 'a path that does not exist is a clear error');
  r = await raw('upload', { ref: pick, path: join(DEV, 'workspace') });
  check(r.error && /is a folder/.test(r.text), 'a folder is a clear error');
  const secret = join(DEV, '.ssh', 'id_rsa');
  await fsp.mkdir(join(DEV, '.ssh'), { recursive: true });
  await fsp.writeFile(secret, 'not a real key\n');
  r = await raw('upload', { ref: pick, path: secret });
  check(r.error && /Refused to upload/.test(r.text), 'a credentials file is refused');
  const env = join(DEV, 'workspace', '.env');
  await fsp.writeFile(env, 'TOKEN=1\n');
  r = await raw('upload', { ref: pick, path: env });
  check(r.error && /Refused to upload/.test(r.text), 'so is a .env file');
  const locked = join(DEV, 'locked.txt');
  await fsp.writeFile(locked, 'x');
  await fsp.chmod(locked, 0o000);
  r = await raw('upload', { ref: pick, path: locked });
  check(r.error && /permission denied/.test(r.text), 'a file that cannot be read says so');
  await fsp.chmod(locked, 0o600);
  const huge = join(DEV, 'huge.bin');
  await fsp.writeFile(huge, '');
  await fsp.truncate(huge, 3 * 1024 ** 3);
  r = await raw('upload', { ref: pick, path: huge });
  check(r.error && /limit for an upload/.test(r.text), 'a file over the size limit is refused before anything is read');
  await fsp.rm(huge);
  const sizable = join(DEV, 'sizable.bin');
  await fsp.writeFile(sizable, Buffer.alloc(30 * 1024 * 1024, 1));
  r = await raw('upload', { ref: pick, path: sizable });
  check(!r.error && (await outText()) === 'input: sizable.bin 31457280', 'a 30 MB file goes in through the debugger path');
  await fsp.rm(sizable);
  if (panel && /Back to routines/.test(await panelText())) await panelClick('Back to routines');
}

// ---------- 13. what the extension holds to, whatever the routine says ----------
{
  const fsp = await import('node:fs/promises');
  const aab1 = join(FIXTURES, 'kavyam-2.14.0.aab');
  const dirOf = (n) => join(STORE, 'routines/local', n);
  const inSite = (u) => u.startsWith(SITE);
  const editSteps = async (n, fn) => {
    const f = join(dirOf(n), 'steps.json');
    const v = JSON.parse(await fsp.readFile(f, 'utf8'));
    const list = Array.isArray(v) ? v : v.steps;
    fn(list);
    await fsp.writeFile(f, JSON.stringify(v, null, 2) + '\n');
  };
  const makeForeign = (n) => fsp.writeFile(join(dirOf(n), '.origin.json'), JSON.stringify({ kind: 'folder', source: '/tmp/someone-elses-routines' }) + '\n');

  // A routine from someone else, with a step that goes to another site.
  await call('navigate', { url: `${SITE}/index.html` });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Apps”/) });
  t = await call('routine_save', { name: 'acme-foreign-nav', description: 'Open the apps list on the test console. Use when the user asks to look at the apps.' });
  check(/Saved acme-foreign-nav/.test(t), 'a routine to turn into one from someone else is saved');
  await editSteps('acme-foreign-nav', (list) => list.push({ n: list.length + 1, action: 'navigate', label: 'Open the docs', url: `http://localhost:${new URL(SITE).port}/docs.html` }));
  await makeForeign('acme-foreign-nav');
  t = await call('routine_run', { name: 'acme-foreign-nav' });
  log(t);
  check(/Stopped at step/.test(t) && /localhost/.test(t) && /only works on the site it was recorded for/.test(t), 'a step that leaves the routine’s site is refused during replay');
  const tabsNow = await listTabs();
  check(!tabsNow.some((x) => /^http:\/\/localhost:/.test(x.url)), 'and the tab never went there');

  // Its irreversible step waits for the person, and the agent cannot approve it.
  await call('navigate', { url: `${SITE}/release.html` });
  page = await call('read_page');
  await call('upload', { ref: refFor(page, /\(file\)/), path: aab1 });
  await call('type', { ref: refFor(page, /“Release name”/), text: '7.7.7' });
  await call('click', { ref: refFor(page, /“Next”/) });
  page = await call('read_page');
  await call('click', { ref: refFor(page, /“Start rollout/) });
  t = await call('routine_save', { name: 'acme-ship', description: 'Roll out a build to internal testing. Use when the user asks to ship a build.', params: { app_bundle: aab1, version_name: '7.7.7' } });
  check(/Saved acme-ship/.test(t), 'a routine with an irreversible step is saved');
  // As if the author had left out the pause.
  await editSteps('acme-ship', (list) => list.forEach((s) => delete s.pause));
  const md = join(dirOf('acme-ship'), 'ROUTINE.md');
  await fsp.writeFile(md, (await fsp.readFile(md, 'utf8')).replace(/^pauses:(?:\s*\[\]|(?:\n\s+- \d+)+)/m, 'pauses: []'));
  await makeForeign('acme-ship');
  if (panel) {
    const shipping = call('routine_run', { name: 'acme-ship', params: { app_bundle: aab1, version_name: '8.8.8' } });
    check(await panelWait(/only you can approve it/, 20_000), 'the panel pauses a routine from someone else before its irreversible step');
    await shot('15-forced-pause');
    check(await panelClick('Start rollout'), 'and the person approves it there');
    t = await shipping;
    log(t.split('\n').join(' / '));
    check(/^Done/.test(t) && /looked irreversible, so it waited for the user/.test(t), 'the agent is told it was held for the person');
    page = await call('read_page', { filter: 'all' });
    check(/Rollout started: 8\.8\.8/.test(page), 'after which the rollout went through');
    await panelClick('Back to routines');
  }

  // The window is a different size than when the routine was recorded.
  const windowOf = async (set) => {
    const v = await (await fetch(`${CDP}/json/version`)).json();
    const b = await cdp(v.webSocketDebuggerUrl);
    const target = await cdpTarget(inSite);
    const { windowId, bounds } = await b.send('Browser.getWindowForTarget', { targetId: target.id });
    if (set) await b.send('Browser.setWindowBounds', { windowId, bounds: set });
    const after = set ? (await b.send('Browser.getWindowForTarget', { targetId: target.id })).bounds : bounds;
    b.close();
    return after;
  };
  const wide = await windowOf();
  const widthOf = () => evalIn(inSite, 'innerWidth');
  const recorded = await widthOf();
  log('recorded width', recorded, 'window', wide.width);
  await windowOf({ windowState: 'normal', width: 520, height: 800 });
  await sleep(400);
  const narrow = await widthOf();
  log('narrow width', narrow);
  t = await call('routine_run', { name: 'acme-latest', params: { release_name: '3.0.3' } });
  log(t.split('\n').slice(0, 3).join(' / '));
  if (narrow < 700) {
    check(/Note: The page is \d+px wide and the routine was recorded at \d+px/.test(t), 'a very different window size is reported in the result');
    check(/^Done|Note:/.test(t), 'and the run still goes on, with the picture check relaxed');
  } else {
    log('window could not be made narrow here; skipped the size checks');
  }
  t = await call('routine_run', { name: 'acme-latest', params: { release_name: '3.0.4' }, match_viewport: true });
  log(t.split('\n').slice(0, 3).join(' / '));
  await sleep(600);
  const back = await windowOf();
  check(Math.abs(back.width - 520) < 20 || narrow >= 700, 'match_viewport puts the window back to the size it was');
  await windowOf({ windowState: 'normal', width: wide.width, height: wide.height });
  await sleep(300);
}

const wrapper = await (await import('node:fs/promises')).readFile(join(STORE, 'bin/host'), 'utf8');
check(wrapper.includes(join(STORE, 'bin/host.cjs')) && !wrapper.includes('dist/'), 'the host runs from its own copy');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
await client.close();
panel?.close();
process.exit(failures ? 1 : 0);
