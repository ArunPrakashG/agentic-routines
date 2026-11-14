// Real-browser check of installing from the directory: the agent passes only an id, the extension fetches the
// routine from a stand-in directory, and the side panel shows its name, description, notes and steps before
// anything is saved. A routine the directory sends with a step off its site is shown as one that cannot install.
//   dev/e2e/e2e-directory.sh runs it against a fresh browser.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = `http://127.0.0.1:${process.env.AR_CDP_PORT ?? 9333}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.DEV_DIR;
const STORE = process.env.AGENTIC_ROUTINES_HOME;
const API_PORT = Number(process.env.AR_API_PORT ?? 8787);
const CLI = join(HERE, '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const EXT = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo';
const SITE = 'https://example.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

// ---------- CDP, as the other checks have it ----------
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
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && match(x.url));
  if (!t) throw new Error('no target');
  const c = await cdp(t.webSocketDebuggerUrl);
  const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  c.close();
  return r.result.value;
}
let panel;
async function openPanel() {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const b = await cdp(v.webSocketDebuggerUrl);
  const { targetId } = await b.send('Target.createTarget', { url: `${EXT}/sidepanel.html`, newWindow: true });
  b.close();
  await sleep(800);
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.id === targetId);
  panel = await cdp(t.webSocketDebuggerUrl);
  await panel.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 844, deviceScaleFactor: 1, mobile: false });
  await panel.send('Runtime.evaluate', { expression: `chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' }, onboarded: true })`, awaitPromise: true });
  await sleep(300);
}
const panelEval = async (expr) => (await panel.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
const panelText = () => panelEval('document.body.innerText');
const panelWait = async (re, ms = 10000) => {
  for (let i = 0; i < ms / 100; i++) {
    if (re.test(await panelText())) return true;
    await sleep(100);
  }
  return false;
};
const panelClick = (label) =>
  panelEval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) || (x.getAttribute('aria-label') || '').startsWith(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`);
// Nothing sideways, nothing cut off: the panel at its real width. --shots keeps a picture of each screen.
const shots = process.argv.includes('--shots');
const SHOTS = join(DEV, 'shots');
async function look(name) {
  await sleep(500);
  const over = await panelEval('(() => { const d = document.documentElement; const wide = [...document.querySelectorAll(".panel *")].filter((e) => e.getBoundingClientRect().right > d.clientWidth + 1).length; return d.scrollWidth > d.clientWidth ? "page " + d.scrollWidth : wide ? wide + " wider than the panel" : ""; })()');
  check(!over, `${name}: nothing overflows the panel${over ? ` (${over})` : ''}`);
  if (!shots) return;
  mkdirSync(SHOTS, { recursive: true });
  await panel.send('Page.bringToFront');
  const { data } = await panel.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  // A page behind another window may never answer a replay, so the site goes back in front.
}
// A finished replay stays on screen until the person goes back.
const back = async () => {
  if (await panelWait(/Back to routines/, 3000)) await panelClick('Back to routines');
  await sleep(300);
};
const panelSwitch = () => panelEval(`(() => { const s = document.querySelector('[role=switch]'); if (!s) return false; s.click(); return true; })()`);

// ---------- the stand-in directory ----------
const step = (n, o) => ({ n, action: 'click', label: `Step ${n}`, target: { role: 'button', name: `Step ${n}` }, ...o });
const good = {
  version: 3,
  meta: { name: 'weekly-report', site: 'example.com', description: 'Download the weekly report. Use when the user asks for this week\'s report.', instructions: 'Pick the newest week only.', params: { week: { type: 'string', description: 'Week' } }, secrets: [], pauses: [3] },
  body: 'Notes for the agent.',
  steps: [step(1, { action: 'navigate', url: `${SITE}/reports`, target: undefined }), step(2, { action: 'type', value: '{{week}}', label: 'Week' }), step(3, { label: 'Download', pause: 'auto' })],
};
const bad = structuredClone(good);
bad.meta.name = 'tampered';
bad.steps[0].url = 'https://evil.example/reports';
const rows = { 'pone/weekly-report': good, 'pone/tampered': bad };
let fetched = 0;
let installs = 0;
const api = createServer((req, res) => {
  const m = /^\/api\/v1\/routines\/([a-z0-9-]+\/[a-z0-9-]+)(\/installs)?$/.exec(req.url);
  if (m?.[2]) {
    installs++;
    res.statusCode = 204;
    return res.end();
  }
  const r = m && rows[m[1]];
  if (!r) {
    res.statusCode = 404;
    return res.end('{}');
  }
  fetched++;
  res.setHeader('content-type', 'application/json');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(r));
});
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// ---------- MCP ----------
const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: DEV, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: STORE, AGENTIC_ROUTINES_API: `http://127.0.0.1:${API_PORT}` }, stderr: 'inherit' });
const client = new Client({ name: 'claude-code', version: '2.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });
  return { text: r.content.map((c) => c.text ?? '').join('\n').replace(/⟨\/?untrusted [0-9a-f]+⟩/g, ''), error: !!r.isError };
};
const saved = (name) => existsSync(join(STORE, 'routines/pone', name, 'ROUTINE.md'));

await openPanel();

// ---------- 1. the person reads it, then installs ----------
let pending = call('routine_install', { id: 'pone/weekly-report' });
check(await panelWait(/Install routine/), 'the panel shows the install card');
let card = await panelText();
check(/Directory · by pone/.test(card) && /weekly-report/.test(card) && /Download the weekly report/.test(card), 'with where it is from, its name and its description');
check(/Pick the newest week only/.test(card) && /Notes the author wrote/.test(card) && /Notes for the agent\./.test(card), 'and the notes its agent will read');
check(card.includes(`${SITE}/reports`), 'and the address a navigate step opens');
check(/3\s*steps/.test(card) && /1\s*pause/.test(card) && /week/.test(card), 'and its steps, pause and input');
check(!saved('weekly-report'), 'nothing is saved before the person clicks');
await look('directory-install');
check(await panelClick('Install'), 'the person clicks Install');
let t = await pending;
log(t.text.split('\n').join(' | '));
check(!t.error && /Installed pone\/weekly-report v3/.test(t.text) && /asks for .*week/.test(t.text) && /pauses before step 3/.test(t.text), 'the agent is told it is installed, what it asks and where it pauses');
check(saved('weekly-report'), 'it is saved under its owner');
await sleep(300);
check(installs === 1, 'and the install is counted');

// ---------- 2. the person says no ----------
pending = call('routine_install', { id: 'pone/weekly-report' });
check(await panelWait(/You have v3/), 'installing it again says it replaces the one installed');
check(await panelClick('Cancel'), 'the person cancels');
t = await pending;
check(t.error && /chose not to install/.test(t.text), 'the agent is told the person said no');

// ---------- 3. what the directory sends is checked here ----------
pending = call('routine_install', { id: 'pone/tampered' });
check(await panelWait(/can’t be installed/), 'a routine with a step off its site is shown as one that cannot install');
const disabled = await panelEval(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Install')?.disabled`);
check(disabled === true, 'and Install is off');
await look('directory-blocked');
await panelClick('Cancel');
t = await pending;
check(t.error && !saved('tampered'), 'nothing is saved');

// ---------- 4. an id that is not there ----------
t = await call('routine_install', { id: 'pone/nope' });
check(t.error && /not in the directory/i.test(t.text), 'an unknown routine is reported');
check(fetched >= 3, 'the extension fetched each routine itself');

await client.close();
api.close();
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
