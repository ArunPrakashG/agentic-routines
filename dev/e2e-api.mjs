// Functional check of the API: the real Go binary with a throwaway Postgres and Redis, and a
// stand-in for Google's token endpoint and keys. It uses throwaway secrets and never touches .keys.
//   node dev/e2e-api.mjs
import { spawnSync } from 'node:child_process';
import { createHash, createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'apps/api');
const PORT = 8799;
const GOOGLE_PORT = 8798;
const PG_PORT = 55432;
const REDIS_PORT = 56379;
const API = `http://127.0.0.1:${PORT}/api/v1`;
const ISSUER = 'http://fake-google';
const CLIENT_ID = '883265328584-285ao8n0u1nkv8b9ftr2q2bov23lieeo.apps.googleusercontent.com';
const TMUX = 'br-api-test';
const PG = 'br-test-pg';
const REDIS = 'br-test-redis';
const STATE = mkdtempSync(join(tmpdir(), 'br-api-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

// ---------- the stand-in for Google ----------
const b64 = (x) => Buffer.from(x).toString('base64url');
const mainKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
function idToken(claims, key = mainKey.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, email_verified: true, ...claims }));
  return `${head}.${body}.${createSign('RSA-SHA256').update(`${head}.${body}`).sign(key).toString('base64url')}`;
}

// One code per sign-in, as Google would. A code knows its verifier and what to answer.
const codes = new Map();
let certFetches = 0;
const google = createServer((req, res) => {
  if (req.url === '/certs') {
    certFetches++;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, max-age=3600');
    return res.end(JSON.stringify({ keys: [{ ...mainKey.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] }));
  }
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const q = new URLSearchParams(raw);
    const c = codes.get(q.get('code'));
    codes.delete(q.get('code'));
    const ok = c && q.get('client_secret') === 'test-client-secret' && q.get('client_id') === CLIENT_ID && q.get('code_verifier') === c.verifier && q.get('grant_type') === 'authorization_code';
    res.statusCode = ok ? 200 : 400;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(ok ? { id_token: c.token } : { error: 'invalid_grant' }));
  });
});
await new Promise((r) => google.listen(GOOGLE_PORT, '127.0.0.1', r));

// ---------- Postgres, Redis and the binary, each on a port of its own ----------
const sh = (cmd, opts = {}) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8', ...opts });
function cleanup() {
  spawnSync('tmux', ['kill-session', '-t', `=${TMUX}`]);
  sh(`docker stop ${PG} ${REDIS} >/dev/null 2>&1`);
}
function finish() {
  cleanup();
  google.close();
  console.log(failures ? `\n${failures} failed (API log: ${log})` : '\nAll passed');
  process.exit(failures ? 1 : 0);
}
const log = join(STATE, 'api.log');
cleanup();
sh(`docker run -d --rm --name ${PG} -e POSTGRES_PASSWORD=test -p 127.0.0.1:${PG_PORT}:5432 postgres:16-alpine >/dev/null`);
sh(`docker run -d --rm --name ${REDIS} -p 127.0.0.1:${REDIS_PORT}:6379 redis:7-alpine >/dev/null`);
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await sleep(500);
  ready = sh(`docker exec ${PG} pg_isready -U postgres -h 127.0.0.1`).status === 0 && sh(`docker exec ${REDIS} redis-cli ping`).stdout.trim() === 'PONG';
}
check(ready, 'Postgres and Redis start');
if (!ready) finish();

const build = sh(`go build -o ${STATE}/api .`, { cwd: API_DIR });
check(build.status === 0, 'the API builds');
if (build.status) console.log(build.stderr);

const vars = {
  PORT, DATABASE_URL: `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`, REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}/0`,
  GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'test-client-secret', SESSION_SECRET: 'test-session-secret-0123456789abcdef',
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${GOOGLE_PORT}/token`, GOOGLE_JWKS_URL: `http://127.0.0.1:${GOOGLE_PORT}/certs`, GOOGLE_ISSUER: ISSUER,
};
const envs = Object.entries(vars).map(([k, v]) => `${k}='${v}'`).join(' ');
const start = () => spawnSync('tmux', ['new-session', '-d', '-s', TMUX, '-c', STATE, `env ${envs} ${STATE}/api >> ${log} 2>&1`]);
start();

const alive = async () => {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok, () => false)) return true;
    await sleep(250);
  }
  return false;
};
const up = await alive();
check(up, 'the API starts, migrating an empty database');
if (!up) finish();

const psql = (sql) => sh(`docker exec ${PG} psql -U postgres -At -c "${sql}"`).stdout.trim();

// ---------- a client ----------
// Each call looks like a new visitor, so only the rate limit check hits the limit. The proxy in front sets x-client-ip.
let visitor = 0;
const post = (path, body, ip = `10.0.${visitor >> 8}.${visitor++ & 255}`) =>
  fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-ip': ip }, body: JSON.stringify(body) });
const me = (token, install) => fetch(`${API}/me`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(install ? { 'x-install-id': install } : {}) } });
const verifierFor = () => randomUUID() + randomUUID();

function signIn(claims = {}, { key, install = randomUUID(), nonce = randomUUID(), tokenNonce, badVerifier } = {}) {
  const code = randomUUID();
  const verifier = verifierFor();
  codes.set(code, { verifier, token: idToken({ sub: 'google-1', email: 'a@example.com', name: 'A', nonce: tokenNonce ?? nonce, ...claims }, key) });
  return post('/auth/google', { code, code_verifier: badVerifier ?? verifier, redirect_uri: 'https://x.chromiumapp.org/', nonce, install_id: install });
}

// ---------- signing in ----------
check((await post('/auth/google', { code: 'x' })).status === 400, 'a sign-in with fields missing is refused');
check((await (await post('/auth/google', { code: 'nope', code_verifier: 'x', redirect_uri: 'x', nonce: 'x', install_id: 'x' })).json()).error === 'google_rejected', 'a code Google rejects is refused');
check((await signIn({}, { badVerifier: 'wrong' })).status === 401, 'the wrong PKCE verifier is refused');

const refused = async (what, ...a) => check((await (await signIn(...a)).json()).error === 'bad_id_token', what);
await refused('an ID token signed by another key is refused', {}, { key: otherKey.privateKey });
await refused('an ID token for another app is refused', { aud: 'someone-else' });
await refused('an ID token from another issuer is refused', { iss: 'http://evil' });
await refused('an expired ID token is refused', { exp: 1000 });
await refused('an ID token with another nonce is refused', {}, { tokenNonce: 'other' });
await refused('an unverified email is refused', { email_verified: false });

const install = randomUUID();
let res = await signIn({}, { install });
let a = await res.json();
check(res.ok && a.user.email === 'a@example.com' && a.user.handle === null && a.access_token && a.refresh_token && a.expires_in === 900, 'sign-in returns the user and a 15 minute session');
check(!('google_sub' in a.user), 'the Google id stays on the server');

// ---------- using the session ----------
res = await me(a.access_token, install);
check(res.ok && (await res.json()).email === 'a@example.com', '/me returns the signed-in user');
check((await me(null, install)).status === 401, '/me with no token is refused');
const headers = (await me(a.access_token, install)).headers;
check(headers.get('cache-control') === 'no-store', 'answers carry no-store, so nothing caches them');
check((await post('/auth/refresh', { refresh_token: 'x'.repeat(40000), install_id: 'x' })).status === 400, 'an oversized request body is refused');
check([404, 405].includes((await fetch(`${API}/auth/google`)).status) && (await fetch(`http://127.0.0.1:${PORT}/nothing`)).status === 404, 'wrong methods and unknown paths are refused');
check((await me(a.access_token, 'another-install')).status === 401, 'an access token from another install is refused');
const parts = a.access_token.split('.');
const forged = b64(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), sub: 'someone-else' }));
check((await me(`${parts[0]}.${forged}.${parts[2]}`, install)).status === 401, 'an altered access token is refused');
check((await me(`${b64('{"alg":"none"}')}.${parts[1]}.`, install)).status === 401, 'an unsigned access token is refused');

const stored = psql('SELECT encode(refresh_hash, \'hex\') FROM sessions');
check(!stored.includes(a.refresh_token), 'refresh tokens are not stored in the clear');
check(stored.includes(createHash('sha256').update(a.refresh_token).digest('hex')), 'their hash is');
check(psql('SELECT count(*) FROM users') === '1', 'one user row so far');
check(certFetches === 1, "Google's keys were fetched once and kept");

// ---------- one user per Google account ----------
const secondInstall = randomUUID();
const again = await (await signIn({ name: 'A Renamed' }, { install: secondInstall })).json();
check(again.user.id === a.user.id && again.user.name === 'A Renamed', 'signing in again finds the same user');
check((await me(a.access_token, install)).ok, 'a second browser leaves the first signed in');
const other = await (await signIn({ sub: 'google-2', email: 'b@example.com' })).json();
check(other.user.id !== a.user.id, 'another Google account is another user');

// ---------- refresh ----------
check((await post('/auth/refresh', { refresh_token: 'nope', install_id: install })).status === 401, 'an unknown refresh token is refused');
res = await post('/auth/refresh', { refresh_token: a.refresh_token, install_id: install });
const b = await res.json();
check(res.ok && b.refresh_token !== a.refresh_token, 'refresh gives a new refresh token');
check((await me(b.access_token, install)).ok, 'and a working access token');
check((await post('/auth/refresh', { refresh_token: a.refresh_token, install_id: install })).status === 401, 'a used refresh token is refused');
check((await post('/auth/refresh', { refresh_token: b.refresh_token, install_id: install })).status === 401, 'and using one ends the session, so the newer token dies too');
check((await me(b.access_token, install)).status === 401, 'its access token stops at once');
check((await post('/auth/refresh', { refresh_token: again.refresh_token, install_id: 'another-install' })).status === 401, 'a refresh from another install is refused');
check((await post('/auth/refresh', { refresh_token: again.refresh_token, install_id: secondInstall })).status === 401, 'and ends that session');

// ---------- two refreshes at once ----------
const d = await (await signIn()).json();
const dInstall = JSON.parse(Buffer.from(d.access_token.split('.')[1], 'base64url')).ins;
const both = await Promise.all([1, 2].map(() => post('/auth/refresh', { refresh_token: d.refresh_token, install_id: dInstall })));
check(both.map((r) => r.status).sort().join() === '200,401' || both.map((r) => r.status).join() === '401,401', 'the same refresh token never works twice, even at once');

// ---------- a restart ----------
const keep = await (await signIn()).json();
const keepInstall = JSON.parse(Buffer.from(keep.access_token.split('.')[1], 'base64url')).ins;
spawnSync('tmux', ['kill-session', '-t', `=${TMUX}`]);
await sleep(500);
start();
check(await alive(), 'the API starts again on a migrated database');
check(psql('SELECT count(*) FROM schema_migrations') === '2', 'each migration ran once');
check((await me(keep.access_token, keepInstall)).ok, 'a session survives a restart');
const kept = await post('/auth/refresh', { refresh_token: keep.refresh_token, install_id: keepInstall });
check(kept.ok, 'and so does its refresh token');

// ---------- sign out ----------
const c = await (await signIn()).json();
const cInstall = JSON.parse(Buffer.from(c.access_token.split('.')[1], 'base64url')).ins;
check((await me(c.access_token, cInstall)).ok, 'signed in before signing out');
check((await post('/auth/signout', { refresh_token: c.refresh_token })).status === 204, 'sign-out succeeds');
check((await me(c.access_token, cInstall)).status === 401, 'sign-out ends the access token at once');
check((await post('/auth/refresh', { refresh_token: c.refresh_token, install_id: cInstall })).status === 401, 'and the refresh token');

// ---------- the directory ----------
const person = async (claims) => {
  const t = await (await signIn(claims)).json();
  return { token: t.access_token, install: JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url')).ins, id: t.user.id };
};
const call = (who, method, path, body, ip = `10.1.${visitor >> 8}.${visitor++ & 255}`) =>
  fetch(`${API}${path}`, {
    method,
    headers: { 'x-client-ip': ip, ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { authorization: `Bearer ${who.token}`, 'x-install-id': who.install } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const errorOf = async (res) => (await res.json()).error;

const step = (n, over = {}) => ({ n, action: 'click', label: `Step ${n}`, target: { tag: 'button', name: 'Go', attrs: {}, css: 'button' }, page: { url: 'https://play.google.com/console/', landmarks: [] }, ...over });
const routine = (over = {}) => ({
  meta: { name: 'play-release', site: 'play.google.com', description: 'Upload a build and start the rollout. Use when the user asks to release to testing.', params: { version_name: { type: 'string', description: 'Version', example: '2.15.0 (private)' } }, secrets: [], pauses: [3] },
  body: '## Do not use for\nProduction releases.',
  steps: [step(1, { action: 'navigate', url: 'https://play.google.com/console/', target: undefined }), step(2), step(3, { pause: 'auto' })],
  ...over,
});

const p1 = await person({ sub: 'dir-1', email: 'p1@example.com', name: 'P One' });
const p2 = await person({ sub: 'dir-2', email: 'p2@example.com', name: 'P Two' });

check((await call(null, 'PUT', '/routines/play-release', routine())).status === 401, 'publishing needs a signed-in account');
check((await errorOf(await call(p1, 'PUT', '/routines/play-release', routine()))) === 'needs_handle', 'and a handle');
for (const h of ['ab', 'Has-Caps', 'admin', 'local', '-lead', 'a'.repeat(31)]) check((await call(p1, 'PUT', '/me/handle', { handle: h })).status === 400, `the handle "${h.slice(0, 12)}" is refused`);
res = await call(p1, 'PUT', '/me/handle', { handle: 'pone' });
check(res.ok && (await res.json()).handle === 'pone', 'a handle can be claimed');
check((await errorOf(await call(p1, 'PUT', '/me/handle', { handle: 'ptwo' }))) === 'handle_set', 'and only once');
check((await errorOf(await call(p2, 'PUT', '/me/handle', { handle: 'pone' }))) === 'handle_taken', 'two people cannot share one');
await call(p2, 'PUT', '/me/handle', { handle: 'ptwo' });

const refusedPublish = async (what, code, body, path = '/routines/play-release') => check((await errorOf(await call(p1, 'PUT', path, body))) === code, what);
await refusedPublish('a description without "Use when" is refused', 'bad_description', routine({ meta: { ...routine().meta, description: 'Uploads a build and starts the rollout.' } }));
await refusedPublish('a step that leaves the site is refused', 'step_off_site', routine({ meta: { ...routine().meta, pauses: [] }, steps: [step(1, { action: 'navigate', url: 'https://evil.example/' })] }));
await refusedPublish('a step on a look-alike host is refused', 'step_off_site', routine({ meta: { ...routine().meta, pauses: [] }, steps: [step(1, { action: 'navigate', url: 'https://notplay.google.com.evil.example/' })] }));
await refusedPublish('a recorded page on another site is refused', 'step_off_site', routine({ meta: { ...routine().meta, pauses: [] }, steps: [step(1, { page: { url: 'https://evil.example/', landmarks: [] } })] }));
await refusedPublish('a name that differs from the path is refused', 'bad_name', routine(), '/routines/other-name');
await refusedPublish('an unknown action is refused', 'bad_steps', routine({ meta: { ...routine().meta, pauses: [] }, steps: [step(1, { action: 'eval' })] }));
await refusedPublish('steps out of order are refused', 'bad_steps', routine({ meta: { ...routine().meta, pauses: [] }, steps: [step(2)] }));
await refusedPublish('a pause past the last step is refused', 'bad_pauses', routine({ meta: { ...routine().meta, pauses: [9] } }));
await refusedPublish('a site with no dot is refused', 'bad_site', routine({ meta: { ...routine().meta, site: 'localhost' } }));
await refusedPublish('too many steps are refused', 'bad_steps', routine({ meta: { ...routine().meta, pauses: [] }, steps: Array.from({ length: 301 }, (_, i) => step(i + 1)) }));
check((await call(p1, 'PUT', '/routines/play-release', { meta: 1 })).status === 400, 'nonsense is refused');
check(psql('SELECT count(*) FROM routines') === '0', 'nothing refused was stored');

const smuggled = routine();
smuggled.steps[1].evil = '<script>';
smuggled.steps[1].target.attrs = { id: 'go' };
smuggled.meta.owner = 'someone-else';
res = await call(p1, 'PUT', '/routines/play-release', smuggled);
let pub = await res.json();
check(res.ok && pub.owner === 'pone' && pub.version === 1, 'a routine can be published');
res = await call(p1, 'PUT', '/routines/play-release', routine());
check((await res.json()).version === 2, 'publishing it again makes the next version');

// Anyone can read the directory, signed in or not.
res = await call(null, 'GET', '/routines/pone/play-release');
const got = await res.json();
check(res.ok && got.owner === 'pone' && got.version === 2 && got.steps.length === 3 && got.meta.pauses[0] === 3, 'anyone can read a routine in full');
check(!JSON.stringify(got).includes('private') && !JSON.stringify(got).includes('p1@example.com'), 'the example value and the email are not in it');
check(!('evil' in got.steps[1]) && !('owner' in got.meta), 'fields nobody asked for are not kept');
check((await errorOf(await call(null, 'GET', '/routines/pone/nope'))) === 'not_found', 'an unknown routine is a 404');
await call(p2, 'PUT', '/routines/play-release', routine({ meta: { ...routine().meta, description: 'Another take on the release. Use when asked to ship to testing.' } }));
await call(p2, 'PUT', '/routines/gmail-label', routine({ meta: { ...routine().meta, name: 'gmail-label', site: 'mail.google.com', pauses: [], description: 'Label a thread. Use when the user asks to file mail.' }, steps: [step(1, { action: 'navigate', url: 'https://mail.google.com/mail/', page: { url: 'https://mail.google.com/mail/', landmarks: [] } })] }));

res = await call(null, 'GET', '/routines?q=rollout');
let found = (await res.json()).routines;
check(found.length === 1 && found[0].owner === 'pone' && !('steps' in found[0]), 'search finds by words and lists without the steps');
found = (await (await call(null, 'GET', '/routines?site=console.play.google.com')).json()).routines;
check(found.length === 2 && found.every((x) => x.site === 'play.google.com'), 'search by the site a person is on includes its parent site');
found = (await (await call(null, 'GET', '/routines?site=google.com')).json()).routines;
check(found.length === 0, 'but not a sibling site');
found = (await (await call(null, 'GET', '/routines?q=%25')).json()).routines;
check(found.length === 0, 'a percent sign in a search is just a character');
found = (await (await call(null, 'GET', '/routines')).json()).routines;
check(found.length === 3, 'with nothing asked it lists everything');

check((await call(null, 'POST', '/routines/pone/play-release/installs')).status === 204, 'an install can be counted');
check((await (await call(null, 'GET', '/routines/pone/play-release')).json()).installs === 1, 'and shows');
found = (await (await call(null, 'GET', '/routines')).json()).routines;
check(found[0].name === 'play-release' && found[0].installs === 1, 'the most installed comes first');
check((await call(null, 'POST', '/routines/pone/nope/installs')).status === 404, 'counting an unknown routine is a 404');

res = await call(p1, 'GET', '/me/routines');
check((await res.json()).routines.length === 1, 'someone sees their own routines');
check((await call(null, 'GET', '/me/routines')).status === 401, 'and nobody else does');
check((await call(p2, 'DELETE', '/routines/play-release')).status === 204 && (await call(null, 'GET', '/routines/ptwo/play-release')).status === 404, 'a routine can be taken down');
check((await call(p2, 'DELETE', '/routines/play-release')).status === 404, 'only once');
check((await call(null, 'GET', '/routines/pone/play-release')).ok, "and taking down yours leaves nobody else's");

// ---------- an agent uses the directory ----------
const CLI = join(ROOT, 'packages/cli');
const builtCli = sh('pnpm -s --filter browser-routines build', { cwd: ROOT });
check(builtCli.status === 0, 'the CLI builds');
const SDK = `${CLI}/node_modules/@modelcontextprotocol/sdk/dist/esm`;
const { Client } = await import(`${SDK}/client/index.js`);
const { StdioClientTransport } = await import(`${SDK}/client/stdio.js`);
const mcpHome = mkdtempSync(join(tmpdir(), 'br-mcp-'));
const agent = new Client({ name: 'claude-code', version: '2.0.0' });
await agent.connect(new StdioClientTransport({ command: process.execPath, args: [`${CLI}/dist/index.js`, 'mcp'], env: { HOME: mcpHome, PATH: process.env.PATH, BROWSER_ROUTINES_HOME: mcpHome, BROWSER_ROUTINES_API: `http://127.0.0.1:${PORT}` }, stderr: 'inherit' }));
const tool = async (name, args = {}) => {
  const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  return { text: r.content.map((c) => c.text ?? '').join('\n'), error: !!r.isError };
};

let t = await tool('routines_search', { site: 'https://play.google.com/console/x' });
check(!t.error && t.text.includes('pone/play-release v2') && t.text.includes('Use when'), 'an agent finds a routine by the site it is on');
t = await tool('routines_search', { query: 'nothing like this' });
check(!t.error && /nothing in the directory/i.test(t.text), 'and is told when there is none');
t = await tool('routine_install', { id: 'pone/play-release' });
check(!t.error && t.text.includes('Installed pone/play-release v2') && t.text.includes('asks for version_name') && t.text.includes('pauses before step 3'), 'an agent installs it and is told what it asks and where it pauses');
const onDisk = (f) => sh(`cat '${mcpHome}/routines/pone/play-release/${f}'`).stdout;
check(onDisk('ROUTINE.md').includes('owner: pone') && JSON.parse(onDisk('steps.json')).length === 3, 'it is saved under its owner, all steps');
check(!onDisk('ROUTINE.md').includes('private'), 'with no example value in it');
await sleep(500);
check(psql("SELECT installs FROM routines WHERE name = 'play-release'") === '2', 'and the install was counted');
check((await agent.listTools()).tools.some((x) => x.name === 'rt_play_release'), 'it shows up as a tool of its own');
t = await tool('routine_install', { id: 'pone/nope' });
check(t.error && /not in the directory/i.test(t.text), 'an unknown routine is reported');
t = await tool('routine_publish', { name: 'play-release' });
check(t.error && /not connected/i.test(t.text), 'publishing without a browser says so, and does not publish');

// A bad row in the directory must not get into the browser: what runs there is decided on this side too.
await call(p1, 'PUT', '/routines/tamper-me', routine({ meta: { ...routine().meta, name: 'tamper-me' } }));
psql(`UPDATE routines SET steps = jsonb_set(steps, '{0,url}', '\\"https://evil.example/\\"') WHERE name = 'tamper-me'`);
t = await tool('routine_install', { id: 'pone/tamper-me' });
check(t.error && /leaves play\.google\.com/.test(t.text) && sh(`test -d '${mcpHome}/routines/pone/tamper-me'`).status !== 0, 'a routine whose step leaves its site is not installed, whatever the directory says');
await agent.close();

let writes = [];
for (let i = 0; i < 25; i++) writes.push((await call(p1, 'PUT', '/routines/play-release', routine(), '10.8.8.8')).status);
check(writes.includes(429), 'publishing is rate limited');

// Deleting an account removes what it published.
check((await call(p2, 'DELETE', '/me')).status === 204, 'an account can be deleted');
check((await call(p2, 'GET', '/me')).status === 401, 'and it is signed out at once');
check((await call(null, 'GET', '/routines/ptwo/gmail-label')).status === 404 && psql("SELECT count(*) FROM users WHERE email = 'p2@example.com'") === '0', 'with its routines and its sign-in');

// ---------- rate limit ----------
let limited = false;
for (let i = 0; i < 60 && !limited; i++) limited = (await post('/auth/refresh', {}, '10.9.9.9')).status === 429;
check(limited, 'too many sign-in calls from one address are limited');

// ---------- how fast ----------
const token = (await kept.json()).access_token;
const t0 = performance.now();
const times = [];
let okCount = 0;
const seen = {};
await Promise.all(
  Array.from({ length: 32 }, async () => {
    for (let i = 0; i < 125; i++) {
      const s = performance.now();
      const r = await me(token, keepInstall).catch((e) => ({ ok: false, status: e.cause?.code ?? 'error' }));
      okCount += r.ok ? 1 : 0;
      seen[r.status] = (seen[r.status] ?? 0) + 1;
      times.push(performance.now() - s);
    }
  }),
);
times.sort((x, y) => x - y);
const secs = (performance.now() - t0) / 1000;
console.log(`· /me, 4000 calls, 32 at a time: ${Math.round(4000 / secs)} calls/s, median ${times[2000].toFixed(1)} ms, 99th ${times[3960].toFixed(1)} ms (the test machine runs the load tool too)`);
check(okCount === 4000, `every one of them was answered ${JSON.stringify(seen)}`);
const rss = sh(`ps -o rss= -p $(pgrep -f '${STATE}/api' | head -1)`).stdout.trim();
console.log(`· the API process holds ${Math.round(Number(rss) / 1024)} MB after that`);

finish();
