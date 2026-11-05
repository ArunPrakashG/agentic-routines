// Real-browser check of what a person does: the toolbar icon opens the real side panel,
// and every click and key reaches the page as an input event, not through page script.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CDP = `http://127.0.0.1:${process.env.AR_CDP_PORT ?? 9333}`;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');
const EXT_ID = 'fafmcnlaedchfncjiimcndjlfphdfkdo';
const SITE = `http://127.0.0.1:${process.env.AR_SITE_PORT ?? 8765}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('·', ...a);
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

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

const { webSocketDebuggerUrl } = await (await fetch(`${CDP}/json/version`)).json();
const browser = await cdp(webSocketDebuggerUrl);
const targets = async () => (await browser.send('Target.getTargets', { filter: [{}] })).targetInfos;
const pageWs = (id) => webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*/, `/devtools/page/${id}`);

// One page, driven the way a person would.
function driver(c) {
  const evaluate = async (expr) => (await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
  const text = () => evaluate('document.body.innerText');
  const until = async (test, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      if (test(await text().catch(() => ''))) return true;
      await sleep(100);
    }
    return false;
  };
  const click = async (js) => {
    const r = await evaluate(`(() => { const e = ${js}; if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error(`Nothing to click: ${js}`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  const type = async (s) => {
    for (const ch of s) {
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
  };
  const button = (label) => `[...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) || x.getAttribute('aria-label') === ${JSON.stringify(label)})`;
  return { c, evaluate, text, until, click, type, button };
}

// ---------- the toolbar icon opens the real side panel ----------
const { targetId } = await browser.send('Target.createTarget', { url: `${SITE}/` });
const site = driver(await cdp(pageWs(targetId)));
await site.c.send('Runtime.enable');
await browser.send('Target.activateTarget', { targetId });
await sleep(500);

const tabTarget = (await targets()).find((t) => t.type === 'tab' && t.url === `${SITE}/`);
await browser.send('Extensions.triggerAction', { id: EXT_ID, targetId: tabTarget.targetId });
let panelTarget;
for (let i = 0; i < 40 && !panelTarget; i++) {
  await sleep(100);
  panelTarget = (await targets()).find((t) => t.type === 'page' && t.url.includes(`${EXT_ID}/sidepanel.html`));
}
check(!!panelTarget, 'the toolbar icon opens the side panel');
if (!panelTarget) process.exit(1);
const panel = driver(await cdp(pageWs(panelTarget.targetId)));
check(await panel.until((t) => /Continue with Google/.test(t)), 'signed out, the panel asks to sign in');
// Google's own screen needs a person. dev/e2e/e2e-api.mjs covers the API behind it.
const worker = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
const bg = driver(await cdp(pageWs(worker.targetId)));
await bg.evaluate(`chrome.storage.local.set({ session: { account: { email: 'test@example.com', name: 'Test' }, access: 'x', accessExp: Date.now() + 3600000, refresh: 'x' } })`);
await panel.until((t) => /Routines|No routines/.test(t) && !/Continue with Google/.test(t));
const size = await panel.evaluate('({ w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth })');
log('panel size', JSON.stringify(size));
check(size.scroll <= size.w, 'nothing overflows the real panel');
if (/Connect your agent/.test(await panel.text())) await panel.click(panel.button('Done'));

// ---------- record by hand ----------
await panel.click(panel.button('Record'));
check(await panel.until((t) => /Stop recording/.test(t)), 'Record starts recording');

await site.click(`document.querySelector('a[href="/apps.html"]')`);
await site.until((t) => /Swap order/.test(t));
await site.click(`[...document.querySelectorAll('a')].find((a) => a.textContent === 'Kavyam')`);
await site.until((t) => /Create internal testing release/.test(t));
const { root } = await site.c.send('DOM.getDocument');
const { nodeId } = await site.c.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#bundle' });
await site.c.send('DOM.setFileInputFiles', { nodeId, files: [join(FIXTURES, 'kavyam-2.15.0.aab')] });
await site.click(`document.querySelector('#rname')`);
await site.type('2.15.0');
await site.click(`document.querySelector('#notes')`);
await site.type('Crash fixes');
await site.click(site.button('Next'));
await site.click(site.button('Start rollout'));
check(/Rollout started: 2\.15\.0/.test(await site.text()), 'the demo itself went through');
await sleep(300);

const during = await panel.text();
log(JSON.stringify(during.slice(0, 200)));
const steps = /· (\d+) steps?/.exec(during)?.[1];
check(steps === '7', `every action was recorded, across two page loads (${steps} steps)`);
await panel.click(panel.button('Stop recording'));
check(await panel.until((t) => !/Stop recording/.test(t)), 'Stop recording stops');

// Nothing more is recorded once stopped.
await site.click(site.button('Next'));
await sleep(300);
check(/· 7 steps/.test(await panel.text()), 'a click after stopping is not recorded');

// ---------- save it ----------
await panel.click(panel.button('Save'));
await panel.until((t) => /Save routine/.test(t));
const saving = await panel.text();
log(JSON.stringify(saving));
check(/\{\{/.test(saving), 'the typed values are offered as params');
await panel.click(`document.querySelector('textarea')`);
await panel.type('Create a test release. Use when the user asks to release to internal testing.');
await panel.click(`[...document.querySelectorAll('input[type=text]')][0]`);
const footer = `[...document.querySelectorAll('footer button')].find((b) => b.textContent.includes('Save routine'))`;
check(!(await panel.evaluate(`${footer}.disabled`)), 'Save routine is enabled');
await panel.click(footer);
check(await panel.until((t) => /Saved|Routines/.test(t) && !/Save routine/.test(t)), 'the routine saves');
log(JSON.stringify((await panel.text()).slice(0, 300)));

// ---------- replay it from the panel ----------
await panel.click(panel.button('Run 127-0-0'));
await panel.until((t) => /app_bundle/.test(t));
const fields = `[...document.querySelectorAll('main input')]`;
for (const [i, v] of [join(FIXTURES, 'kavyam-2.15.0.aab'), '3.0.0', 'From the panel'].entries()) {
  await panel.click(`${fields}[${i}]`);
  await panel.type(v);
}
await panel.click(panel.button('Run'));
check(await panel.until((t) => /Paused before step/.test(t), 20000), 'the replay pauses before the rollout');
log(JSON.stringify(await panel.text()));
await panel.click(panel.button('Start rollout'));
check(await panel.until((t) => /Done/.test(t), 15000), 'the replay finishes');
log(JSON.stringify(await panel.text()));
const replayed = driver(await cdp(pageWs((await targets()).find((t) => t.type === 'page' && t.url.startsWith(`${SITE}/release.html`)).targetId)));
const status = await replayed.text();
log(JSON.stringify(status));
check(/Rollout started: 3\.0\.0 · kavyam-2\.15\.0\.aab .* notes: From the panel/.test(status), 'the page got the new values');
await panel.click(panel.button('Back to routines'));
await panel.until((t) => /Routines/.test(t));
check(/ran just now/.test(await panel.text()), 'the library shows when it last ran');

// ---------- the keyboard ----------
const press = async (key) => {
  await panel.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key });
  await panel.c.send('Input.dispatchKeyEvent', { type: 'keyUp', key });
};
await press('r');
check(await panel.until((t) => /Stop recording/.test(t), 2000), 'R starts recording');
await press('r');
check(await panel.until((t) => !/Stop recording/.test(t), 2000), 'R stops it');
await sleep(300);
log(JSON.stringify(await panel.text()));
check(!/· 0 steps/.test(await panel.text()), 'an empty recording leaves nothing behind');

// ---------- account ----------
await panel.click(panel.button('Account, Test'));
check(await panel.until((t) => /test@example\.com/.test(t), 2000), 'the account button shows the email');
const shot = await panel.c.send('Page.captureScreenshot', { format: 'png' });
mkdirSync(join(FIXTURES, '../../.dev'), { recursive: true });
writeFileSync(join(FIXTURES, '../../.dev/panel-account.png'), Buffer.from(shot.data, 'base64'));
await panel.c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
check(await panel.until((t) => !/test@example\.com/.test(t), 2000), 'Escape closes the menu');
await panel.click(panel.button('Account, Test'));
await panel.click(panel.button('Sign out'));
check(await panel.until((t) => /Continue with Google/.test(t)), 'signing out returns to the sign-in screen');

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
browser.close();
process.exit(failures ? 1 : 0);
