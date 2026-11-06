// The agent's tab is behind another tab: every action must still go through, quickly. Started by e2e-background.sh.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const CDP = 'http://127.0.0.1:9335';
const SITE = 'http://127.0.0.1:8767';
const LIMIT = 8000;

let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME }, stderr: 'inherit' });
const client = new Client({ name: 'claude-code', version: '2.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: !!r.isError, ms: Date.now() - t0 };
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/ref_\d+/)?.[0];

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
  const send = (method, params = {}) => new Promise((res) => ((wait.set(++id, res), ws.send(JSON.stringify({ id, method, params })))));
  return { send, close: () => ws.close() };
}
const visibility = async () => {
  const t = (await (await fetch(`${CDP}/json/list`)).json()).find((x) => x.type === 'page' && x.url.startsWith(SITE));
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const out = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.visibilityState', returnByValue: true } }));
  });
  ws.close();
  return out.result.result.value;
};

let r = await call('navigate', { url: `${SITE}/index.html` });
const tab = r.text.match(/\(tab (\d+)\)/)?.[1];
let page = (await call('read_page')).text;

// Put another tab in front of the agent's.
const b = await browserCdp();
await b.send('Target.createTarget', { url: 'about:blank' });
await new Promise((r) => setTimeout(r, 800));
b.close();
const vis = await visibility();
console.log('· the agent tab is', vis);
check(vis === 'hidden', 'the agent tab is behind another tab');

r = await call('click', { ref: refFor(page, /“Apps”/), tab_id: Number(tab) });
check(!r.error && r.ms < LIMIT, `click in the background tab goes through (${r.ms} ms)`);
page = (await call('read_page', { tab_id: Number(tab) })).text;
r = await call('click', { ref: refFor(page, /“Kavyam”/), tab_id: Number(tab) });
check(!r.error && r.ms < LIMIT, `a second click, which follows a page change (${r.ms} ms)`);
page = (await call('read_page', { tab_id: Number(tab) })).text;
check(/Create internal testing release/.test(page), 'and the page it led to was read');
r = await call('type', { ref: refFor(page, /“Release name”/), text: '1.0.0', tab_id: Number(tab) });
check(!r.error && r.ms < LIMIT, `typing goes through (${r.ms} ms)`);
r = await call('screenshot', { full: true, tab_id: Number(tab) });
check(!r.error && r.ms < LIMIT, `a picture of the tab is taken (${r.ms} ms)`);

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
