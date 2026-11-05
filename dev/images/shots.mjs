// Captures the raw frames the README images are built from: the real side panel and the test site, driven by a
// plain MCP client through the real extension. No model calls. Needs a running dev/env/up.sh environment.
//   DEV_DIR=<state folder> AGENTIC_ROUTINES_HOME=<state folder>/store AR_CDP_PORT=<port> node dev/images/shots.mjs <out-dir> [light|dark]
// dev/images/readme-images.sh runs it end to end. The site is dev/site with a stylesheet added on the way, so the
// fixtures stay as the tests expect them.
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2];
const SCHEME = process.argv[3] === 'dark' ? 'dark' : 'light';
if (!OUT) throw new Error('usage: node dev/images/shots.mjs <out-dir> [light|dark]');
mkdirSync(OUT, { recursive: true });

const CDP = `http://127.0.0.1:${process.env.AR_CDP_PORT ?? 9333}`;
const STORE = process.env.AGENTIC_ROUTINES_HOME;
// The bundles live in a short, neutral folder, so no path of this machine shows in a screenshot.
const FIXTURES = '/tmp/builds';
mkdirSync(FIXTURES, { recursive: true });
for (const f of ['kavyam-2.14.0.aab', 'kavyam-2.15.0.aab']) copyFileSync(join(HERE, '../fixtures', f), join(FIXTURES, f));
const CLI = join(HERE, '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const EXT = 'chrome-extension://fafmcnlaedchfncjiimcndjlfphdfkdo';
const PORT = Number(process.env.AR_STYLED_PORT ?? 8772);
const SITE = `http://127.0.0.1:${PORT}`;
const PAGE = { width: 760, height: 640 };
const PANEL = { width: 400, height: 640 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);

// ---------- the test site, styled ----------
const CSS = `
:root{color-scheme:light dark;--bg:#F6F6FA;--card:#fff;--ink:#14131F;--mute:#6A6880;--line:#E3E2EE;--accent:#3530E0;--accent-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0F0E17;--card:#191825;--ink:#ECECF5;--mute:#9A98B2;--line:#2A2940;--accent:#9D99FF;--accent-ink:#14131F}}
*{box-sizing:border-box}
html{overflow:hidden}
body{margin:0!important;max-width:none!important;min-height:100vh;background:var(--bg);color:var(--ink);font:15px/1.5 'Schibsted Grotesk',system-ui,sans-serif}
body::before{content:'Acme Console';display:block;padding:14px 32px;background:var(--card);border-bottom:1px solid var(--line);font-weight:600;letter-spacing:.01em}
body>*:not(script):not(style){margin-left:32px;margin-right:32px}
h1{font-size:22px;margin:32px 32px 6px}
nav,ul{margin-top:12px}
a{color:var(--accent);text-decoration:none;font-weight:500}
ul{list-style:none;padding:0;max-width:520px}
li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:10px}
form{max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 20px 20px;margin-top:20px}
label{display:block;margin:14px 0 0;color:var(--mute);font-size:13px}
input,textarea{display:block;width:100%;margin-top:6px;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);font:inherit}
textarea{min-height:76px}
button{margin-top:18px;padding:9px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:600;cursor:pointer}
#swap{background:transparent;color:var(--mute);border:1px solid var(--line);margin-left:32px}
#review{max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 20px 20px;margin-top:16px}
#status{max-width:520px;color:var(--mute)}
`;
const site = createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname;
  if (path === '/__shots.css') return void res.writeHead(200, { 'content-type': 'text/css' }).end(CSS);
  try {
    const html = readFileSync(join(HERE, '../site', path === '/' ? 'index.html' : path.slice(1)), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><link rel="stylesheet" href="/__shots.css">'));
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => site.listen(PORT, '127.0.0.1', r));

// ---------- CDP ----------
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
const targets = async () => (await (await fetch(`${CDP}/json/list`)).json()).filter((t) => t.type === 'page');

// The site tab: sized and themed once, then captured at 2x without touching the layout.
let pageC;
let pageTargetId;
async function sitePage() {
  const t = (await targets()).find((x) => x.url.startsWith(SITE));
  if (!t) return pageC;
  if (t.id !== pageTargetId) {
    pageC?.close();
    pageC = await cdp(t.webSocketDebuggerUrl);
    pageTargetId = t.id;
    await pageC.send('Emulation.setDeviceMetricsOverride', { ...PAGE, deviceScaleFactor: 1, mobile: false });
    await pageC.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }] });
  }
  return pageC;
}
const pageEval = async (expr) => (await (await sitePage()).send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

let panel;
async function openPanel() {
  const v = await (await fetch(`${CDP}/json/version`)).json();
  const b = await cdp(v.webSocketDebuggerUrl);
  const { targetId } = await b.send('Target.createTarget', { url: `${EXT}/sidepanel.html`, newWindow: true });
  b.close();
  await sleep(800);
  const t = (await targets()).find((x) => x.id === targetId);
  panel = await cdp(t.webSocketDebuggerUrl);
  await panel.send('Emulation.setDeviceMetricsOverride', { ...PANEL, deviceScaleFactor: 1, mobile: false });
  await panel.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  await panel.send('Runtime.evaluate', { expression: `chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' } })`, awaitPromise: true });
  await sleep(400);
}
const panelEval = async (expr) => (await panel.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
// The panel does not ask for the routine list again after an agent saves a routine, so the capture asks for it
// with the panel's own refresh command.
const refreshList = () => panelEval(`new Promise((res) => { const p = chrome.runtime.connect({ name: 'panel' }); p.postMessage({ t: 'refresh', reqId: 1 }); p.onMessage.addListener((m) => { if (m.reqId === 1) { res(true); p.disconnect(); } }); setTimeout(() => res(false), 3000); })`);
const panelText = () => panelEval('document.body.innerText');
const panelClick = (label) =>
  panelEval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);

// A capture only answers from the page in front, so each one fronts its own first.
async function grab(c, size, name) {
  await c.send('Page.bringToFront');
  const { data } = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, ...size, scale: 2 } });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  // The agent works in the site's window, which has to be the one in front.
  if (c !== pageC) await pageC?.send('Page.bringToFront');
}
const shotPanel = async (name) => (await sleep(500), grab(panel, PANEL, `panel-${name}`));
const shotPage = async (name) => grab(await sitePage(), PAGE, `page-${name}`);

// ---------- the agent ----------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${CLI}/dist/index.js`, 'mcp'],
  env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: STORE },
  stderr: 'inherit',
});
const client = new Client({ name: 'claude-code', version: '2.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  log(name);
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  const t = r.content.map((c) => c.text ?? `[${c.type}]`).join('\n');
  if (r.isError) log(`${name} error:`, t);
  return t;
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/ref_\d+/)?.[0];
const draftId = (text) => text.match(/Draft (d-[a-z0-9]+)/)?.[1];
const hintEdits = (text) => [...text.matchAll(/apply: (\{.*\})/g)].map((m) => JSON.parse(m[1]));

await openPanel();
await shotPanel('empty');

// 1. The agent does the task by hand.
await call('navigate', { url: `${SITE}/index.html` });
await sitePage();
let page = await call('read_page');
await call('click', { ref: refFor(page, /“Apps”/) });
page = await call('read_page');
await call('click', { ref: refFor(page, /“Kavyam”/) });
page = await call('read_page');
await call('upload', { ref: refFor(page, /\(file\)/), path: join(FIXTURES, 'kavyam-2.14.0.aab') });
await call('type', { ref: refFor(page, /“Release name”/), text: '2.14.0 (214)' });
await call('type', { ref: refFor(page, /“Release notes”/), text: 'Faster search.' });
await shotPage('recording');
await call('click', { ref: refFor(page, /“Next”/) });
page = await call('read_page');
await call('click', { ref: refFor(page, /“Start rollout/) });
await sleep(300);
await shotPanel('recorded');

// The same run, saved by hand: what Save shows before the agent refines it.
await panelClick('Save');
await sleep(500);
const setVal = (sel, v) =>
  panelEval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await setVal('input.input', 'acme-release');
await setVal('textarea', 'Upload an app bundle to Acme internal testing and start the rollout. Use when the user asks to release a build to internal testing.');
await shotPanel('save');
await panelClick('Back to routines');

// 2. Refine and save.
const DESC = 'Upload an app bundle to Acme internal testing and start the rollout. Use when the user asks to release a build to internal testing.';
let t = await call('routine_propose', { name: 'acme-release', description: DESC });
writeFileSync(join(OUT, 'propose.txt'), t);
const id = draftId(t);
const nav = hintEdits(t).find((e) => e.op === 'navigate' && e.from === 1);
t = await call('routine_edit', { draft_id: id, ops: [nav, { op: 'param', name: 'app_bundle', value: join(FIXTURES, 'kavyam-2.14.0.aab') }, { op: 'param', name: 'version_name', value: '2.14.0 (214)' }, { op: 'param', name: 'release_notes', value: 'Faster search.' }] });
await call('routine_test', { draft_id: id });
t = await call('routine_save', { draft_id: id });
await sleep(500);
await panelClick('Back to routines');
await refreshList();
await sleep(400);
await shotPanel('saved');

// 3. Replay: one call, a pause before the rollout. Frames are taken the whole time.
const args = { app_bundle: join(FIXTURES, 'kavyam-2.15.0.aab'), version_name: '2.15.0 (215)', release_notes: 'Dark mode for the reader.' };
let done = false;
const run = call('rt_acme_release', args).finally(() => (done = true));
let n = 0;
let pausedShot = false;
while (!done && n < 200) {
  const paused = /Paused before step/.test(await panelText());
  const tag = String(n++).padStart(3, '0');
  await grab(panel, PANEL, `frame-${tag}-panel`);
  await grab(await sitePage(), PAGE, `frame-${tag}-page`);
  if (paused && !pausedShot) {
    pausedShot = true;
    await sleep(600);
    await shotPanel('paused');
    await shotPage('paused');
    await panelClick('Start rollout');
  }
}
log('replay frames:', n);
await run;
await sleep(900);
await shotPanel('done');
await shotPage('done');
await panelClick('Back to routines');
// A panel opened as a tab is not pushed the new list, so it asks again.
await refreshList();
for (let i = 0; i < 50 && !/ran just now/.test(await panelText().catch(() => '')); i++) await sleep(200);
await shotPanel('library');

// 4. The page changed: the replay stops at the step and hands it back.
await pageEval("localStorage.variant = 'b'");
t = await call('rt_acme_release', args);
await sleep(500);
await shotPanel('changed');
await shotPage('changed');
writeFileSync(join(OUT, 'changed.txt'), t);

await client.close();
site.close();
log('done', OUT);
process.exit(0);
