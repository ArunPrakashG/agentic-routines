// With "Ask where to save each file" on, the browser puts up a box of its own that nothing can answer. The agent still gets the file.
// Started by e2e-savebox.sh.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const SITE = 'http://127.0.0.1:8769';

let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: process.env.DEV_DIR, PATH: process.env.PATH, AGENTIC_ROUTINES_HOME: process.env.AGENTIC_ROUTINES_HOME } });
const client = new Client({ name: 'claude-code', version: '2.0.0' });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  return { text: r.content.map((c) => c.text ?? `[${c.type}]`).join('\n'), error: !!r.isError };
};
const refFor = (outline, re) => outline.split('\n').find((l) => re.test(l))?.match(/ref_\d+/)?.[0];

await call('navigate', { url: `${SITE}/downloads.html` });
let page = (await call('read_page')).text;
await call('click', { ref: refFor(page, /Download the report/) });
await sleep(2500);
let list = (await call('download')).text;
check(/waiting_at_save_box/.test(list) && /report\.txt/.test(list), `a download held at the save box says so: ${list.slice(0, 200)}`);
const id = Number(/^(\d+)\s/m.exec(list.replace(/^.*\n/, ''))?.[1] ?? /(\d+)\s+report\.txt/.exec(list)?.[1]);
let r = await call('download', { id });
const path = /(\S+) \(\d+ bytes\)/.exec(r.text)?.[1];
check(!r.error && path && readFileSync(path, 'utf8') === 'quarterly report\n', `and the file comes anyway: ${r.text.slice(0, 200)}`);
list = (await call('download')).text;
check(!/waiting_at_save_box/.test(list.split('\n').find((l) => l.startsWith(`${id} `)) ?? ''), 'the list no longer shows it as waiting');

page = (await call('read_page')).text;
await call('click', { ref: refFor(page, /Download a generated file/) });
await sleep(2500);
list = (await call('download')).text;
const waiting = list.split('\n').filter((l) => /waiting_at_save_box/.test(l) && /blob:/.test(l));
check(waiting.length === 1, `a file the page made is held too: ${list.slice(0, 300)}`);
r = await call('download', { id: Number(waiting[0]?.split(/\s+/)[0]) });
const bpath = /(\S+) \(\d+ bytes\)/.exec(r.text)?.[1];
check(!r.error && bpath && readFileSync(bpath, 'utf8') === 'made in the page\n', `and that comes too: ${r.text.slice(0, 200)}`);

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
