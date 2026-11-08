import { createECDH, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { home } from '../paths.ts';

// A browser on one machine and the agent on another. The browser's host listens on a network address; everything else, CDP
// included, stays on the machine.
//
// Pairing: `remote pair` makes a code of 8 characters (40 bits) that works once, for 10 minutes, and five wrong guesses throw
// away all that are pending. The host keeps only a slow hash of it. Over ephemeral ECDH both sides prove they know the code, and
// the host hands over a key of its own for that browser profile. The slow hash means that whoever saw one proof cannot search
// the codes before they expire.
//
// Every later connection: both sides prove they hold the key with an HMAC over fresh nonces, the host first, so nothing talks to
// a host that has not proved itself. The key is never sent. After that the link is plain: anyone on the path can read and change
// what passes, so this belongs on Tailscale, WireGuard or a network you trust. The docs say so too.

export const DEFAULT_PORT = 47931;
const SCHEME = 'agentic-routines-remote-v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_MS = 10 * 60_000;
const MAX_CODES = 5;
const MAX_FAILURES = 5;
const ITERATIONS = 100_000;
const HANDSHAKE_MS = 15_000;
const MAX_HANDSHAKE_BYTES = 8 * 1024;
const MAX_STRANGERS = 8;

export interface ListenConfig {
  address: string;
  port: number;
}
export interface PairedClient {
  key: string;
  name: string;
  profile?: string;
  pairedAt: number;
}
export interface RemoteBrowser {
  name: string;
  address: string;
  port: number;
  id: string;
  key: string;
  browser: string;
  profile?: string;
}

const dir = () => join(home(), 'remote');
const file = (name: string) => join(dir(), name);

function readJson<T>(name: string, empty: T): T {
  try {
    return JSON.parse(readFileSync(file(name), 'utf8')) as T;
  } catch {
    return empty;
  }
}

function writeJson(name: string, value: unknown) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file(name));
}

export const listenConfig = () => readJson<ListenConfig | null>('listen.json', null);
export const setListenConfig = (c: ListenConfig | null) => (c ? writeJson('listen.json', c) : rmSync(file('listen.json'), { force: true }));
export const pairedClients = () => readJson<Record<string, PairedClient>>('clients.json', {});
const setPairedClients = (c: Record<string, PairedClient>) => writeJson('clients.json', c);
export const remoteBrowsers = () => readJson<RemoteBrowser[]>('browsers.json', []);
export const setRemoteBrowsers = (b: RemoteBrowser[]) => writeJson('browsers.json', b);

export function revokeClient(id: string): boolean {
  const all = pairedClients();
  if (!all[id]) return false;
  delete all[id];
  setPairedClients(all);
  return true;
}

// ---------- codes ----------

type Pending = { codes: { key: string; expires: number }[]; failures: number };

const codeKey = (code: string) => pbkdf2Sync(code, `${SCHEME}|code`, ITERATIONS, 32, 'sha256').toString('hex');

export function normalCode(input: string) {
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return new RegExp(`^[${CROCKFORD}]{8}$`).test(code) ? code : undefined;
}

export function mintCode(now = Date.now()): string {
  const code = Array.from(randomBytes(8), (b) => CROCKFORD[b & 31]).join('');
  const pending = readJson<Pending>('codes.json', { codes: [], failures: 0 });
  const codes = [...pending.codes.filter((c) => c.expires > now), { key: codeKey(code), expires: now + CODE_MS }];
  writeJson('codes.json', { codes: codes.slice(-MAX_CODES), failures: 0 });
  return code.match(/.{4}/g)!.join('-');
}

// ---------- proofs ----------

const hmac = (key: Buffer | string, ...parts: (string | Buffer)[]) => {
  const h = createHmac('sha256', key);
  h.update(SCHEME);
  for (const p of parts) h.update('|').update(p);
  return h.digest();
};

const same = (a: Buffer, hex: unknown) => {
  if (typeof hex !== 'string' || !/^[0-9a-f]+$/.test(hex)) return false;
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};

const sessionKey = (key: string, secret: Buffer, a: string, b: string, pubA: string, pubB: string) => hmac(Buffer.from(key, 'hex'), secret, a, b, pubA, pubB);

/** The lines of a handshake, with a cap on what a stranger can send. */
function lines(sock: Socket, on: (m: Record<string, unknown>) => void) {
  let buf = '';
  const data = (d: Buffer) => {
    buf += d.toString('utf8');
    if (buf.length > MAX_HANDSHAKE_BYTES) return sock.destroy();
    let at: number;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(line);
      } catch {
        return sock.destroy();
      }
      on(m);
    }
  };
  sock.on('data', data);
  return () => sock.off('data', data);
}

const say = (sock: Socket, m: unknown) => sock.write(`${JSON.stringify(m)}\n`);

// ---------- the host's side ----------

export interface RemoteHost {
  /** Starts or stops listening to match what is configured. */
  sync(): Promise<ListenConfig | undefined>;
  /** Drops the connections of a client whose key was just revoked. */
  drop(id: string): void;
  close(): void;
}

export function remoteHost(o: { attach: (s: Socket) => void; me: () => { browser: string; profile?: string; email?: string } | undefined; log: (t: string) => void; listening: (l: ListenConfig | undefined) => void }): RemoteHost {
  let server: Server | undefined;
  let on: ListenConfig | undefined;
  let strangers = 0;
  const open = new Map<string, Set<Socket>>();

  const welcome = (sock: Socket, id: string) => {
    const me = o.me();
    let set = open.get(id);
    if (!set) open.set(id, (set = new Set()));
    set.add(sock);
    sock.once('close', () => set.delete(sock));
    say(sock, { t: 'ok', browser: me?.browser, profile: me?.profile, email: me?.email });
    o.attach(sock);
  };

  const handle = (sock: Socket) => {
    if (strangers >= MAX_STRANGERS || !o.me()) return void sock.destroy();
    strangers++;
    let known = true;
    const settled = () => {
      if (known) strangers--;
      known = false;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => sock.destroy(), HANDSHAKE_MS);
    sock.once('close', settled);
    sock.on('error', () => sock.destroy());
    sock.setNoDelay(true);
    let state: { kind: 'key'; id: string; key: string; nc: string; nh: string } | { kind: 'code'; secret: Buffer; nc: string; nh: string; pc: string; ph: string; name: string } | undefined;
    const stop = lines(sock, (m) => {
      if (!state && m.t === 'hello') {
        const id = String(m.id);
        const client = Object.hasOwn(pairedClients(), id) ? pairedClients()[id] : undefined;
        const nc = String(m.nonce);
        // A key belongs to one browser profile. And nothing tells a stranger which ids exist.
        if (!client || client.profile !== o.me()?.profile || nc.length !== 64) return void sock.destroy();
        const nh = randomBytes(32).toString('hex');
        state = { kind: 'key', id, key: client.key, nc, nh };
        say(sock, { t: 'challenge', nonce: nh, proof: hmac(Buffer.from(client.key, 'hex'), 'host', nc, nh).toString('hex') });
      } else if (!state && m.t === 'pair') {
        const pc = String(m.ecdh);
        const nc = String(m.nonce);
        if (!/^[0-9a-f]{130}$/.test(pc) || nc.length !== 64) return void sock.destroy();
        const ecdh = createECDH('prime256v1');
        const ph = ecdh.generateKeys('hex');
        const nh = randomBytes(32).toString('hex');
        let secret: Buffer;
        try {
          secret = ecdh.computeSecret(Buffer.from(pc, 'hex'));
        } catch {
          return void sock.destroy();
        }
        state = { kind: 'code', secret, nc, nh, pc, ph, name: String(m.name ?? 'agent').slice(0, 80) };
        say(sock, { t: 'challenge', nonce: nh, ecdh: ph });
      } else if (state?.kind === 'key' && m.t === 'proof') {
        if (!same(hmac(Buffer.from(state.key, 'hex'), 'client', state.nc, state.nh), m.proof)) return void sock.destroy();
        stop();
        settled();
        welcome(sock, state.id);
      } else if (state?.kind === 'code' && m.t === 'proof') {
        const pending = readJson<Pending>('codes.json', { codes: [], failures: 0 });
        const now = Date.now();
        const s = state;
        const live = pending.codes.filter((c) => c.expires > now);
        const hit = live.find((c) => same(hmac(sessionKey(c.key, s.secret, s.nc, s.nh, s.pc, s.ph), 'client'), m.proof));
        if (!hit) {
          const failures = pending.failures + 1;
          writeJson('codes.json', failures >= MAX_FAILURES ? { codes: [], failures: 0 } : { codes: live, failures });
          o.log(`remote: a wrong pairing code from ${sock.remoteAddress}`);
          return void sock.destroy();
        }
        writeJson('codes.json', { codes: live.filter((c) => c !== hit), failures: 0 });
        const session = sessionKey(hit.key, s.secret, s.nc, s.nh, s.pc, s.ph);
        const id = randomBytes(8).toString('hex');
        const key = randomBytes(32);
        const clients = pairedClients();
        clients[id] = { key: key.toString('hex'), name: s.name, profile: o.me()?.profile, pairedAt: now };
        setPairedClients(clients);
        const mask = hmac(session, 'wrap');
        const me = o.me();
        o.log(`remote: paired ${s.name} from ${sock.remoteAddress}`);
        say(sock, { t: 'key', id, proof: hmac(session, 'host').toString('hex'), wrapped: Buffer.from(key.map((b, i) => b ^ mask[i])).toString('hex'), browser: me?.browser, profile: me?.profile });
        sock.end();
      } else sock.destroy();
    });
  };

  const stopListening = () =>
    new Promise<void>((res) => {
      if (!server) return res();
      server.close(() => res());
      server = undefined;
      on = undefined;
      for (const set of open.values()) for (const s of set) s.destroy();
    });

  return {
    async sync() {
      const want = listenConfig();
      if (on && want && on.address === want.address && on.port >= want.port && on.port < want.port + 10) return on;
      await stopListening();
      if (want) {
        // Each browser profile has a host of its own, and takes the next free port.
        for (let port = want.port; port < want.port + 10 && !server; port++) {
          const candidate = createServer(handle);
          const ok = await new Promise<boolean>((res) => {
            candidate.once('error', () => res(false));
            candidate.listen(port, want.address, () => res(true));
          });
          if (ok) {
            candidate.on('error', (e) => o.log(`remote: ${(e as Error).message}`));
            server = candidate;
            on = { address: want.address, port };
          }
        }
        if (!server) o.log(`remote: could not listen on ${want.address}:${want.port}`);
      }
      o.listening(on);
      return on;
    },
    drop(id) {
      for (const s of open.get(id) ?? []) s.destroy();
    },
    close() {
      void stopListening();
    },
  };
}

// ---------- the agent's side ----------

function reach(address: string, port: number) {
  return new Promise<Socket>((res, rej) => {
    const sock = connect({ host: address, port });
    const timer = setTimeout(() => {
      sock.destroy();
      rej(new Error(`Nothing answered at ${address}:${port}.`));
    }, HANDSHAKE_MS);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      res(sock);
    });
    sock.once('error', () => {
      clearTimeout(timer);
      rej(new Error(`Nothing answered at ${address}:${port}.`));
    });
  });
}

/** `name` is what the browser is called here, and `from` what this machine is called over there. */
export async function pair(address: string, port: number, typed: string, name: string, from: string): Promise<RemoteBrowser> {
  const code = normalCode(typed);
  if (!code) throw new Error('A pairing code has 8 characters, like ABCD-1234.');
  const sock = await reach(address, port);
  return new Promise((resolve, reject) => {
    const ecdh = createECDH('prime256v1');
    const pc = ecdh.generateKeys('hex');
    const nc = randomBytes(32).toString('hex');
    let session: Buffer | undefined;
    let done = false;
    const stop = (e: Error) => {
      done = true;
      sock.destroy();
      reject(e);
    };
    sock.once('close', () => done || reject(new Error('The browser turned that down. The code may be wrong, used or too old: make a new one with `agentic-routines remote pair`.')));
    lines(sock, (m) => {
      if (m.t === 'challenge' && !session) {
        const ph = String(m.ecdh);
        try {
          session = sessionKey(codeKey(code), ecdh.computeSecret(Buffer.from(ph, 'hex')), nc, String(m.nonce), pc, ph);
        } catch {
          return stop(new Error('That is not an Agentic Routines host.'));
        }
        say(sock, { t: 'proof', proof: hmac(session, 'client').toString('hex') });
      } else if (m.t === 'key' && session) {
        if (!same(hmac(session, 'host'), m.proof)) return stop(new Error('The other side does not know the code, so it is not the browser you paired with.'));
        const mask = hmac(session, 'wrap');
        const key = Buffer.from(String(m.wrapped), 'hex').map((b, i) => b ^ mask[i]);
        done = true;
        sock.destroy();
        const b: RemoteBrowser = { name, address, port, id: String(m.id), key: Buffer.from(key).toString('hex'), browser: String(m.browser ?? 'browser'), profile: typeof m.profile === 'string' ? m.profile : undefined };
        setRemoteBrowsers([...remoteBrowsers().filter((x) => x.name !== name), b]);
        resolve(b);
      } else stop(new Error('That is not an Agentic Routines host.'));
    });
    say(sock, { t: 'pair', nonce: nc, ecdh: pc, name: from });
  });
}

/** A proved connection, ready for the usual lines. */
export async function connectRemote(b: Pick<RemoteBrowser, 'address' | 'port' | 'id' | 'key'>): Promise<Socket> {
  const sock = await reach(b.address, b.port);
  return new Promise((resolve, reject) => {
    const nc = randomBytes(32).toString('hex');
    const key = Buffer.from(b.key, 'hex');
    const fail = (e: Error) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`${b.address}:${b.port} did not finish proving who it is.`)), HANDSHAKE_MS);
    const closed = () => fail(new Error(`The browser at ${b.address}:${b.port} turned this connection down. It may have been revoked, so pair again.`));
    sock.once('close', closed);
    let nh = '';
    const stop = lines(sock, (m) => {
      if (m.t === 'challenge' && !nh) {
        nh = String(m.nonce);
        // The host goes first: nothing talks to one that cannot prove it holds the key.
        if (!same(hmac(key, 'host', nc, nh), m.proof)) return fail(new Error(`What answered at ${b.address}:${b.port} does not hold the key, so it is not the browser you paired with.`));
        say(sock, { t: 'proof', proof: hmac(key, 'client', nc, nh).toString('hex') });
      } else if (m.t === 'ok' && nh) {
        stop();
        clearTimeout(timer);
        sock.off('close', closed);
        resolve(sock);
      } else fail(new Error('That is not an Agentic Routines host.'));
    });
    say(sock, { t: 'hello', id: b.id, nonce: nc });
  });
}
