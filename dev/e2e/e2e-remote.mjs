// A browser on another computer, with no browser: the real listener and host under a temporary home, the extension's own
// handshake code, and a stand-in for the extension that answers what agents ask. An agent's CLI goes through all of it.
// What it cannot show is Chrome: a service worker holding this socket, or the panel. e2e-parity.mjs has that part.
// Usage: pnpm -C packages/cli build && node --experimental-strip-types --no-warnings dev/e2e/e2e-remote.mjs
import { spawn } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(REPO, 'packages/cli/dist/index.js');
const { WebSocket: Ws, WebSocketServer } = createRequire(join(REPO, 'packages/cli/package.json'))('ws');
const HOME = mkdtempSync(join(tmpdir(), 'ar-link-'));
const env = { ...process.env, AGENTIC_ROUTINES_HOME: HOME };
delete env.AGENTIC_ROUTINES_SESSION;
const PORT = 47900 + Math.floor(Math.random() * 60);
const OPEN_PORT = PORT + 60;

// What an extension's socket sends, which a website's cannot.
let origin = 'chrome-extension://test';
globalThis.WebSocket = class extends Ws {
  constructor(url) {
    super(url, { origin, perMessageDeflate: false });
  }
};
const { openLink, pairLink } = await import(join(REPO, 'packages/extension/lib/agent/link.ts'));

let bad = 0;
const ok = (c, what) => {
  console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!c) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
};
// Not spawnSync: the stand-in for the extension answers from this same process.
const cli = (...args) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => c.kill(), 40_000);
    c.on('close', (code) => (clearTimeout(timer), resolve({ out, code })));
  });
const refused = (p) => p.then(() => '', (e) => e.message);
const json = (name) => {
  try {
    return JSON.parse(readFileSync(join(HOME, 'remote', name), 'utf8'));
  } catch {
    return undefined;
  }
};
const hostInfos = () => (existsSync(join(HOME, 'hosts')) ? readdirSync(join(HOME, 'hosts')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(HOME, 'hosts', f), 'utf8'))) : []);
const pairCode = (out) => /Code: (\S+)/.exec(out)?.[1];

/** Plays the extension over an open link: answers what is asked of the browser, and asks what the extension asks of the host. */
function standIn(ws) {
  let next = 1;
  const waiting = new Map();
  const asked = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === 'pong') return waiting.get('pong')?.(true);
    if ('method' in m) {
      asked.push(m);
      if (m.method === 'browser.tabs') return ws.send(JSON.stringify({ id: m.id, result: { tabs: [{ id: 7, title: 'A page on the far browser', url: 'https://example.com/far', active: true, agent: true }], note: 'far' } }));
      return ws.send(JSON.stringify({ id: m.id, result: true }));
    }
    const w = waiting.get(m.id);
    if (w) {
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
    }
  });
  return {
    asked,
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    ping: () =>
      new Promise((resolve) => {
        waiting.set('pong', resolve);
        ws.send('{"t":"ping"}');
      }),
  };
}

/** An agent's own line to the host, on this machine. */
function agentLine(socket) {
  const c = createConnection(socket);
  let buf = '';
  let next = 1;
  const waiting = new Map();
  c.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const m = JSON.parse(buf.slice(0, i));
      const w = waiting.get(m.id);
      if (w) m.error ? w.reject(new Error(m.error)) : w.resolve(m.result);
    }
  });
  return {
    close: () => c.destroy(),
    call: (method, params) =>
      new Promise((resolve, reject) => {
        const id = next++;
        waiting.set(id, { resolve, reject });
        c.write(`${JSON.stringify({ id, method, params })}\n`);
      }),
  };
}

const raw = (url, o = {}) =>
  new Promise((resolve) => {
    const ws = new Ws(url, { origin: o.origin ?? 'chrome-extension://test' });
    ws.on('error', () => resolve('refused'));
    ws.on('open', () => resolve(ws));
  });
const closes = (ws, ms = 5000) => new Promise((resolve) => (ws.once('close', () => resolve(true)), setTimeout(() => resolve(false), ms)));

try {
  console.log('Pairing');
  const first = (await cli('remote', 'pair', `127.0.0.1:${PORT}`));
  const code = pairCode(first.out);
  ok(first.code === 0 && code && first.out.includes(`Address: 127.0.0.1:${PORT}`), 'remote pair starts listening and gives an address and a code');
  ok(/ssh -N -L/.test(first.out), 'on loopback it says how to tunnel');
  ok(json('listener.json')?.port === PORT, 'something is listening');
  ok(statSync(join(HOME, 'remote/codes.json')).mode % 0o1000 === 0o600 && !readFileSync(join(HOME, 'remote/codes.json'), 'utf8').includes(code.replace('-', '')), 'the code is not kept, only a slow hash, in a private file');
  const addr = `127.0.0.1:${PORT}`;
  ok(/Turned down/.test(await refused(pairLink(addr, 'AAAA-AAAA', 'x'))), 'a wrong code is turned down');
  const key = await pairLink(addr, code, 'Chrome here');
  ok(key.id && key.key.length === 64, 'the right code gets a key of its own');
  ok(json('browsers.json')?.[key.id]?.key === key.key, 'both sides hold the same key, which was never sent as it is');
  ok(/Turned down/.test(await refused(pairLink(addr, code, 'y'))), 'a code works once');

  const c2 = pairCode((await cli('remote', 'pair')).out);
  for (let i = 0; i < 5; i++) await refused(pairLink(addr, `AAAA-AAA${i}`, 'g'));
  ok(/Turned down/.test(await refused(pairLink(addr, c2, 'z'))), 'five wrong codes throw away the ones pending');

  console.log('Who may connect');
  origin = 'https://evil.example';
  ok(/Nothing answered|Turned down/.test(await refused(openLink(key))), 'a website cannot open it, even holding the key');
  origin = 'chrome-extension://test';
  ok(/does not hold the key/.test(await refused(openLink({ ...key, key: '00'.repeat(32) }))), 'the wrong key is not let in');
  ok(/Turned down/.test(await refused(openLink({ ...key, id: 'nope' }))), 'an unknown id is not let in');
  ok(/Turned down/.test(await refused(openLink({ ...key, id: '__proto__' }))), 'nor one that names a property of every object');

  const skip = await raw(`ws://${addr}`);
  skip.send(JSON.stringify({ t: 'hello', id: key.id, nonce: 'a'.repeat(64) }));
  await sleep(200);
  skip.send(JSON.stringify({ t: 'proof', proof: '00'.repeat(32) }));
  ok(await closes(skip), 'a made-up proof is dropped');
  const fat = await raw(`ws://${addr}`);
  fat.send('x'.repeat(20_000));
  ok(await closes(fat), 'a stranger cannot send much');
  const mute = await raw(`ws://${addr}`);
  mute.send(JSON.stringify({ id: 1, method: 'browser.tabs' }));
  ok(await closes(mute), 'nothing is passed on before the proof');

  // Something that answers at the address but has no key.
  const impostor = new WebSocketServer({ port: PORT + 200, host: '127.0.0.1' });
  impostor.on('connection', (ws) => ws.on('message', () => ws.send(JSON.stringify({ t: 'challenge', nonce: 'b'.repeat(64), proof: '11'.repeat(32) }))));
  ok(/does not hold the key/.test(await refused(openLink({ ...key, address: `ws://127.0.0.1:${PORT + 200}/` }))), 'an impostor does not get a proof out of the extension');
  impostor.removeAllListeners('connection');
  const fake = createECDH('prime256v1');
  fake.generateKeys();
  impostor.on('connection', (ws) => ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'pair') ws.send(JSON.stringify({ t: 'challenge', nonce: 'b'.repeat(64), ecdh: fake.getPublicKey('hex') }));
    else if (m.t === 'proof') ws.send(JSON.stringify({ t: 'key', id: 'x', proof: '11'.repeat(32), wrapped: '00'.repeat(32) }));
  }));
  ok(/does not know the code/.test(await refused(pairLink(`127.0.0.1:${PORT + 200}`, 'ABCD-1234', 'x'))), 'pairing with something that does not know the code fails');
  impostor.close();

  console.log('An agent here, the browser there');
  const { ws, computer } = await openLink(key);
  ok(!!computer, `both sides proved it (${computer})`);
  const far = standIn(ws);
  ok(await far.ping(), 'the keepalive is answered');
  await far.call('host.hello', { browser: 'chrome', profile: 'far-profile', email: 'far@example.com' });
  ok(await until(() => hostInfos().some((h) => h.profile === 'far-profile')), 'an ordinary host is there for it');
  const info = hostInfos().find((h) => h.profile === 'far-profile');
  ok(info.onLink === true, 'and it knows it is over a link');
  const tabs = (await cli('tabs'));
  ok(tabs.out.includes('A page on the far browser'), `the CLI reached the far browser: ${tabs.out.trim().slice(0, 100)}`);
  ok(far.asked.some((m) => m.method === 'browser.tabs'), 'the request crossed the link');
  ok((await cli('remote', 'status')).out.includes('connected'), 'remote status says it is connected');
  ok(/listening on/.test((await cli('doctor')).out), 'doctor says what is listening');

  console.log('Files');
  const file = join(HOME, 'report.txt');
  writeFileSync(file, 'the agent has this file');
  ok(/not named/.test(await refused(far.call('fs.info', { path: file }))), 'the browser cannot read a file no agent named');
  ok(/cannot name files/.test(await refused(far.call('host.allowFiles', { paths: [file] }))), 'nor name one itself');
  const agent = agentLine(info.socket);
  await agent.call('host.allowFiles', { paths: [file] });
  const size = await far.call('fs.info', { path: file });
  const piece = await far.call('fs.readChunk', { path: file, offset: 0 });
  ok(size.size === 23 && Buffer.from(piece.data, 'base64').toString() === 'the agent has this file', 'once the agent names it, it streams to the browser');
  writeFileSync(join(HOME, '.env'), 'X=1');
  ok(/credentials/.test(await refused(agent.call('host.allowFiles', { paths: [join(HOME, '.env')] }))), 'a sensitive path is refused as ever');
  const part = await far.call('fs.download', { name: 'stamp-abc-file.bin', data: Buffer.from('from the ').toString('base64') });
  const whole = await far.call('fs.download', { name: 'stamp-abc-file.bin', data: Buffer.from('browser').toString('base64') });
  ok(whole.path === part.path && readFileSync(whole.path, 'utf8') === 'from the browser' && whole.path.startsWith(join(HOME, 'downloads')), 'a download arrives in pieces in its own folder');
  ok(statSync(whole.path).mode % 0o1000 === 0o600, 'and is private');
  ok((await refused(far.call('fs.download', { name: '../../escape', data: 'AA==' }))) !== '' && !existsSync(join(HOME, 'escape')), 'a name cannot climb out of the folder');
  agent.close();

  console.log('Stored secrets');
  ok(!/plain link/.test(await refused(far.call('host.secret', { name: 'none', origin: 'https://example.com' }))), 'through a tunnel they are asked for as usual');

  console.log('Taking it back');
  const closed = closes(ws, 10_000);
  ok((await cli('remote', 'revoke', key.id)).code === 0, 'remote revoke takes the key back');
  ok(await closed, 'and its connection closes');
  ok(await until(() => !hostInfos().some((h) => h.profile === 'far-profile')), 'and its host goes');
  ok(/Turned down/.test(await refused(openLink(key))), 'and the key no longer works');
  ok(/no id|No browser/.test((await cli('remote', 'revoke', '__proto__')).out), 'revoking nothing says so');

  const k2 = await pairLink(addr, pairCode((await cli('remote', 'pair')).out), 'Second');
  const second = await openLink(k2);
  second.ws.send(JSON.stringify({ t: 'forget' }));
  ok(await until(() => !json('browsers.json')?.[k2.id]), 'disconnecting in the panel gives the key back too');

  console.log('On an open address');
  (await cli('remote', 'stop'));
  ok(await until(() => !existsSync(join(HOME, 'remote/listener.json'))), 'remote stop stops it');
  const open = (await cli('remote', 'pair', `0.0.0.0:${OPEN_PORT}`));
  ok(/not encrypted/.test(open.out), `it says the link is not encrypted`);
  ok(!/Address: 0\.0\.0\.0/.test(open.out), 'and gives an address that can be reached');
  const k3 = await pairLink(`127.0.0.1:${OPEN_PORT}`, pairCode(open.out), 'Open');
  const third = await openLink(k3);
  const plain = standIn(third.ws);
  await plain.call('host.hello', { browser: 'chrome', profile: 'open-profile' });
  ok(/plain link/.test(await refused(plain.call('host.secret', { name: 'x', origin: 'https://example.com' }))), 'stored secrets do not cross a plain link');
  third.ws.close();
} catch (e) {
  bad++;
  console.log(`  FAIL  stopped: ${e.stack}`);
} finally {
  (await cli('remote', 'stop'));
  await until(() => !existsSync(join(HOME, 'remote/listener.json')), 8000);
  ok(!existsSync(join(HOME, 'remote/listener.json')), 'nothing is left listening');
  rmSync(HOME, { recursive: true, force: true });
}
console.log(bad ? `${bad} failed` : 'All passed');
process.exit(bad ? 1 : 0);
