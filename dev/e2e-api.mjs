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
check(psql('SELECT count(*) FROM schema_migrations') === '1', 'the migration ran once');
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
