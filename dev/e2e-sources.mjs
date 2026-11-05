// Functional check of installing from Git sources: the real built CLI (setup commands, MCP server and
// native host) against a stand-in for GitHub and for the block list. No browser: the browser's side of
// the native line is played by this script. Run `pnpm --filter agentic-routines build` first.
//   node dev/e2e-sources.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createServer as http } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages/cli');
const GH_PORT = 8791;
const API_PORT = 8792;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

// ---------- a routine as its author has it ----------
const author = mkdtempSync(join(tmpdir(), 'br-author-'));
const step = (n, o) => ({ n, label: `Step ${n}`, ...o });
function putRoutine(home, name, { site = 'staging.acme.com', extra = [], navigate = `https://${site}/deploys` } = {}) {
  const dir = join(home, 'routines/local', name);
  mkdirSync(dir, { recursive: true });
  const steps = [step(1, { action: 'navigate', url: navigate }), step(2, { action: 'click', label: 'New deploy' }), step(3, { action: 'type', value: '{{version}}', label: 'Version' }), step(4, { action: 'click', label: 'Start' }), ...extra];
  writeFileSync(join(dir, 'steps.json'), JSON.stringify(steps));
  writeFileSync(
    join(dir, 'ROUTINE.md'),
    `---\nname: ${name}\nversion: 1\nsite: ${site}\ndescription: Deploy the latest build to staging. Use when asked to push to staging.\nparams:\n  version:\n    type: string\nsecrets: []\npauses:\n  - 4\n---\n\nDeploys and waits.\n`,
  );
}
const run = (args, env) => spawnSync(process.execPath, [`${CLI}/dist/index.js`, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

putRoutine(author, 'deploy-staging');
putRoutine(author, 'bad-site', { navigate: 'https://evil.example/deploys' });
const exported = (name) => {
  const r = run(['export', name], { AGENTIC_ROUTINES_HOME: author });
  return r;
};
const good = exported('deploy-staging');
check(good.status === 0 && good.stdout.includes('```steps') && good.stdout.startsWith('---\n'), 'a routine can be exported as one file');
const refused = exported('bad-site');
check(refused.status !== 0 && /leaves staging\.acme\.com/.test(refused.stderr), 'export refuses one that would not install');
const badFile = (() => {
  // The author skipped the check and wrote the file by hand.
  const t = good.stdout.replace('name: deploy-staging', 'name: bad-site').replace('https://staging.acme.com/deploys', 'https://evil.example/deploys');
  return t;
})();
const secretFile = good.stdout.replace('name: deploy-staging', 'name: leaky').replace('{{version}}', 'ghp_abcdefghijklmnopqrstuvwxyz0123');
const changed = good.stdout.replace('"label":"Start"', '"label":"Start now"');

// ---------- the stand-in for GitHub and for the block list ----------
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
let head = SHA_A;
const files = { [SHA_A]: { 'routines/deploy-staging.md': good.stdout, 'routines/bad-site.md': badFile, 'routines/leaky.md': secretFile }, [SHA_B]: { 'routines/deploy-staging.md': changed, 'routines/bad-site.md': badFile, 'routines/leaky.md': secretFile } };
let blocks = { users: [], repos: [], routines: [] };
let blocklistFetches = 0;
let gh;
const github = http((req, res) => {
  const u = new URL(req.url, 'http://x');
  let m;
  if (u.pathname === '/repos/acme-corp/agentic-routines/commits/HEAD') return res.end(head);
  if ((m = /^\/repos\/acme-corp\/agentic-routines\/git\/trees\/([0-9a-f]{40})$/.exec(u.pathname))) {
    const tree = Object.keys(files[m[1]] ?? {}).map((path) => ({ path, type: 'blob', size: files[m[1]][path].length }));
    tree.push({ path: 'README.md', type: 'blob', size: 10 }, { path: 'routines/notes.txt', type: 'blob', size: 10 });
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ tree }));
  }
  if ((m = /^\/raw\/acme-corp\/agentic-routines\/([0-9a-f]{40})\/(.+)$/.exec(u.pathname))) {
    const f = files[m[1]]?.[m[2]];
    if (f === undefined) return void ((res.statusCode = 404), res.end());
    return res.end(f);
  }
  res.statusCode = 404;
  res.end();
});
const api = http((req, res) => {
  if (req.url === '/api/v1/blocklist') {
    blocklistFetches++;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(blocks));
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => github.listen(GH_PORT, '127.0.0.1', r));
await new Promise((r) => api.listen(API_PORT, '127.0.0.1', r));

// ---------- the person's machine ----------
const home = mkdtempSync(join(tmpdir(), 'br-user-'));
const env = { HOME: home, AGENTIC_ROUTINES_HOME: home, AGENTIC_ROUTINES_API: `http://127.0.0.1:${API_PORT}`, AGENTIC_ROUTINES_GITHUB_API: `http://127.0.0.1:${GH_PORT}`, AGENTIC_ROUTINES_GITHUB_RAW: `http://127.0.0.1:${GH_PORT}/raw` };
// Not spawnSync: the stand-ins for GitHub and the block list answer from this same process.
const cli = (...args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [`${CLI}/dist/index.js`, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const REPO = 'https://github.com/acme-corp/agentic-routines';

let r = await cli('sources', 'add', 'github.com/Acme-Corp/Agentic-Routines.git');
if (r.status !== 0) console.log(r.stderr, r.stdout);
check(r.status === 0 && r.stdout.includes(REPO), 'a GitHub repository is added, in its normal form');
r = await cli('sources', 'add', 'github.com/acme-corp/agentic-routines');
check(r.status !== 0 && /already added/.test(r.stderr), 'the same one twice is refused');
r = await cli('sources', 'add', 'https://gitlab.com/acme/x');
check(r.status !== 0 && /GitHub/.test(r.stderr), 'other hosts say they are not supported yet');
r = await cli('sources', 'add', 'github.com/acme-corp/missing');
check(r.status !== 0, 'a repository that is not there is refused');
const theirFolder = mkdtempSync(join(tmpdir(), 'br-folder-'));
mkdirSync(join(theirFolder, 'routines'));
writeFileSync(join(theirFolder, 'routines/deploy-staging.md'), good.stdout);
r = await cli('sources', 'add', theirFolder);
check(r.status === 0, 'a local folder is added');
r = await cli('sources');
check(r.stdout.includes('Directory') && r.stdout.includes(`${REPO} · GitHub · not reviewed · 3 routines`) && r.stdout.includes('local folder'), 'the list says what is reviewed and what is not');
check(!r.stdout.includes('README') && !r.stdout.includes('notes.txt'), 'only .md files in routines/ count');

// ---------- the host, with this script as the browser ----------
function startHost() {
  const p = spawn(process.execPath, [`${CLI}/dist/index.js`, 'host'], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const m = JSON.parse(buf.subarray(4, 4 + len).toString());
      buf = buf.subarray(4 + len);
      if ('id' in m) waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const ask = (method, params) =>
    new Promise((res) => {
      const n = ++id;
      waiting.set(n, res);
      const body = Buffer.from(JSON.stringify({ id: n, method, params }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      p.stdin.write(Buffer.concat([head, body]));
    });
  return { p, ask };
}
const socketOf = async () => {
  for (let i = 0; i < 50; i++) {
    const dir = join(home, 'hosts');
    const f = existsSync(dir) && readdirSync(dir).find((n) => n.endsWith('.json'));
    if (f) return JSON.parse(readFileSync(join(dir, f), 'utf8')).socket;
    await sleep(100);
  }
  throw new Error('no host socket');
};
let host = startHost();
const sock = await socketOf();
// What an agent can do over the socket.
const agentCall = (method, params) =>
  new Promise((resolve) => {
    const c = connect(sock);
    c.on('data', (d) => {
      resolve(JSON.parse(d.toString().split('\n')[0]));
      c.end();
    });
    c.write(JSON.stringify({ id: 1, method, params }) + '\n');
  });

const entry = 'routines/deploy-staging.md';
let p = await host.ask('sources.preview', { id: REPO, path: entry });
check(!p.error && p.result.problems.length === 0 && p.result.ref === SHA_A && p.result.routine.steps.length === 4, 'the browser can read a routine from a source, pinned to a commit');
p = await host.ask('sources.preview', { id: REPO, path: 'routines/bad-site.md' });
check(p.result?.problems.some((x) => /leaves staging\.acme\.com/.test(x)), 'a routine whose step leaves its site is flagged');
p = await host.ask('sources.preview', { id: REPO, path: 'routines/leaky.md' });
check(p.result?.problems.some((x) => /secret/.test(x)), 'so is one with a secret in a typed value');
p = await host.ask('sources.install', { id: REPO, path: 'routines/bad-site.md' });
check(p.error && /Not installed/.test(p.error) && !existsSync(join(home, 'routines/gh_acme-corp/bad-site')), 'and neither is installed');
p = await host.ask('sources.preview', { id: REPO, path: '../../etc/passwd' });
check(p.error, 'a path outside routines/ is refused');
p = await host.ask('sources.preview', { id: 'https://github.com/someone/else', path: entry });
check(p.error && /not in your list/.test(p.error), 'a source the person did not add is refused');

// An agent cannot install, add or change a source, whatever it sends.
for (const [m, params] of [['sources.install', { id: REPO, path: entry }], ['sources.add', { address: 'github.com/acme-corp/agentic-routines' }], ['sources.remove', { id: REPO }], ['sources.setEnabled', { id: REPO, enabled: false }]]) {
  const a = await agentCall(m, params);
  check(a.error === 'Only the browser can do that.', `an agent cannot call ${m}`);
}
check(!existsSync(join(home, 'routines/gh_acme-corp')), 'and nothing was installed by trying');
check(!(await agentCall('sources.list', {})).error && !(await agentCall('sources.preview', { id: REPO, path: entry })).error, 'it can read what the sources hold');

// The agent's own tools.
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const agent = new Client({ name: 'claude-code', version: '2.0.0' });
await agent.connect(new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { PATH: process.env.PATH, ...env }, stderr: 'inherit' }));
const tool = async (name, args = {}) => {
  const res = await agent.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  return { text: res.content.map((c) => c.text ?? '').join('\n'), error: !!res.isError };
};
let t = await tool('routines_search', { query: 'staging' });
check(!t.error && t.text.includes(REPO) && t.text.includes('[not reviewed]') && t.text.includes('routine_install_from_git'), 'an agent finds it in search, marked not reviewed');
t = await tool('routines_search', { site: 'https://staging.acme.com/x', query: 'push' });
check(t.text.includes('deploy-staging'), 'by the site it is on');
// The browser's side of the install request: this script is the browser, so it can see the ask.
const asked = new Promise((res) => host.p.stdout.on('data', function f(c) { const s = c.toString('latin1'); if (s.includes('git.install')) { host.p.stdout.off('data', f); res(true); } }));
const pending = tool('routine_install_from_git', { source: REPO, path: entry }).catch(() => {});
check((await Promise.race([asked, sleep(5000).then(() => false)])), 'asking to install reaches the browser as a request for the person');
void pending;
check(!existsSync(join(home, 'routines/gh_acme-corp')), 'and nothing is installed while it waits');

// The person clicks Install.
p = await host.ask('sources.install', { id: REPO, path: entry, ref: SHA_A });
check(!p.error && p.result.meta.name === 'deploy-staging', 'Install saves it');
const dir = join(home, 'routines/gh_acme-corp/deploy-staging');
const origin = JSON.parse(readFileSync(join(dir, '.origin.json'), 'utf8'));
check(origin.kind === 'github' && origin.source === REPO && origin.ref === SHA_A && origin.path === entry, 'under an owner no one can claim as a handle, with where it came from and the commit');
check(readFileSync(join(dir, 'ROUTINE.md'), 'utf8').includes('Deploys and waits.') && JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')).length === 4, 'with its notes and steps');

// A later commit is never applied on its own.
head = SHA_B;
p = await host.ask('sources.preview', { id: REPO, path: entry, ref: SHA_A });
check(p.result.ref === SHA_A && p.result.routine.steps[3].label === 'Start', 'a pinned commit still gives what was read');
p = await host.ask('sources.preview', { id: REPO, path: entry });
check(p.result.ref === SHA_B && p.result.routine.steps[3].label === 'Start now' && p.result.installed, 'the newer commit is shown as a change to an installed routine');
check(JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8'))[3].label === 'Start', 'and the installed one has not moved');

// A source that is off disappears from search and cannot install.
check((await cli('sources', 'off', REPO)).status === 0, 'a source can be turned off');
t = await tool('routines_search', { query: 'staging' });
check(!t.text.includes('github.com/acme-corp'), 'it leaves search');
p = await host.ask('sources.preview', { id: REPO, path: entry });
check(p.error && /turned off/.test(p.error), 'and cannot install');
check(existsSync(dir), 'what was installed stays');
await cli('sources', 'on', REPO);

// The block list.
host.p.kill();
await sleep(300);
rmSync(join(home, 'hosts'), { recursive: true, force: true });
blocks = { users: [], repos: [REPO], routines: [] };
rmSync(join(home, 'blocklist.json'), { force: true });
const before = blocklistFetches;
// A directory routine, as an install would leave it, from a publisher on the list.
const dirRoutine = join(home, 'routines/pone/play-release');
mkdirSync(dirRoutine, { recursive: true });
writeFileSync(join(dirRoutine, 'ROUTINE.md'), readFileSync(join(dir, 'ROUTINE.md'), 'utf8').replace('deploy-staging', 'play-release'));
writeFileSync(join(dirRoutine, 'steps.json'), readFileSync(join(dir, 'steps.json'), 'utf8'));
writeFileSync(join(dirRoutine, '.origin.json'), JSON.stringify({ kind: 'directory', source: 'pone' }));
blocks.users = ['pone'];
host = startHost();
await socketOf();
for (let i = 0; i < 50 && !existsSync(join(dir, '.blocked.json')); i++) await sleep(100);
check(existsSync(join(dir, '.disabled')) && /blocked/.test(readFileSync(join(dir, '.blocked.json'), 'utf8')), 'at start the host turns off a routine from a blocked repository, with a note');
check(existsSync(join(dirRoutine, '.disabled')), 'and one from a blocked publisher');
check(blocklistFetches === before + 1, 'having fetched the list once');
let list = await host.ask('store.list', {});
const row = list.result.find((x) => x.name === 'deploy-staging');
check(row && !row.enabled && /repository/.test(row.blocked), 'the panel is told it is off and why');
p = await host.ask('store.setEnabled', { id: 'gh_acme-corp/deploy-staging', enabled: true });
check(p.error && /stays off/.test(p.error), 'turning it back on is refused while the block stands');
p = await host.ask('sources.preview', { id: REPO, path: entry });
check(p.result.problems.some((x) => /blocked/.test(x)), 'it cannot be installed again');
p = await host.ask('sources.install', { id: REPO, path: entry });
check(p.error && /Not installed/.test(p.error), 'not even by a click');
r = await cli('sources', 'remove', REPO);
r = await cli('sources', 'add', REPO);
check(r.status !== 0 && /blocked/.test(r.stderr), 'a blocked repository cannot be added');
// Lifted.
blocks = { users: [], repos: [], routines: [] };
rmSync(join(home, 'blocklist.json'), { force: true });
p = await host.ask('store.setEnabled', { id: 'gh_acme-corp/deploy-staging', enabled: true });
check(!p.error && !existsSync(join(dir, '.disabled')) && !existsSync(join(dir, '.blocked.json')), 'when the block is lifted the person can turn it on');

// The local folder installs the same way.
await cli('sources', 'remove', theirFolder);
r = await cli('sources', 'add', theirFolder);
p = await host.ask('sources.install', { id: theirFolder, path: entry });
const folderOwner = readdirSync(join(home, 'routines')).find((n) => n.startsWith('folder_'));
check(!p.error && folderOwner && existsSync(join(home, 'routines', folderOwner, 'deploy-staging/ROUTINE.md')), 'a routine in a local folder installs under its own owner');

await agent.close();
host.p.kill();
github.close();
api.close();
rmSync(home, { recursive: true, force: true });
rmSync(author, { recursive: true, force: true });
rmSync(theirFolder, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
