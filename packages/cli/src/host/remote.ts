import { spawn, type ChildProcess } from 'node:child_process';
import { createECDH, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { home } from '../paths.ts';
import { nativeFrame, nativeReader, type Message } from '../protocol.ts';

// A browser on another computer. The agent and this program stay here; the extension over there connects out to the address
// the person types in, and needs nothing else on that computer. There is no server of ours in the middle.
//
// A small process listens. For each browser that proves itself it starts an ordinary host and passes messages between the two,
// so to agents here that browser is like any other, the DevTools address and the files included, and the HTTP API and CDP stay
// on this machine. It stops when told to through its settings file, so nothing here ever signals a process by a stale id.
//
// Pairing: a code of 8 characters (40 bits) that works once, for 10 minutes, and five wrong guesses throw away all that are
// pending. Only a slow hash of it is kept. Over ephemeral ECDH both sides prove they know the code, and this side hands over a
// key of its own for that browser. The slow hash means that whoever saw one proof cannot search the codes before they expire.
//
// Every later connection: both sides prove they hold the key with an HMAC over fresh nonces, this side first, so the extension
// says nothing to what has not proved itself. The key is never sent. After that the link is plain: anyone on the path can read
// and change what passes, so this belongs on Tailscale, an SSH tunnel or a network you trust. The docs and the panel say so too.
//
// The extension's half is packages/extension/lib/agent/link.ts.

export const DEFAULT_PORT = 47931;
const SCHEME = 'agentic-routines-link-v1';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_MS = 10 * 60_000;
const MAX_CODES = 5;
const MAX_FAILURES = 5;
const ITERATIONS = 100_000;
const HANDSHAKE_MS = 15_000;
const MAX_HANDSHAKE_BYTES = 8 * 1024;
const MAX_STRANGERS = 8;
const MAX_MESSAGE = 64 * 1024 * 1024;
const BEAT_MS = 3_000;
const GONE_AFTER_MS = 12_000;

export interface ListenConfig {
  address: string;
  port: number;
}
export interface PairedBrowser {
  key: string;
  name: string;
  pairedAt: number;
}
export interface ListenerState extends ListenConfig {
  at: number;
  connected: { id: string; name: string; since: number }[];
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
export const pairedBrowsers = () => readJson<Record<string, PairedBrowser>>('browsers.json', {});
const setPairedBrowsers = (c: Record<string, PairedBrowser>) => writeJson('browsers.json', c);

/** What is listening now, going by the mark it keeps fresh. */
export function listenerState(): ListenerState | undefined {
  const s = readJson<ListenerState | null>('listener.json', null);
  return s && Date.now() - s.at < GONE_AFTER_MS ? s : undefined;
}

export function revokeBrowser(id: string): boolean {
  const all = pairedBrowsers();
  if (!Object.hasOwn(all, id)) return false;
  delete all[id];
  setPairedBrowsers(all);
  return true;
}

// ---------- codes ----------

type Pending = { codes: { key: string; expires: number }[]; failures: number };

const codeKey = (code: string) => pbkdf2Sync(code, `${SCHEME}|code`, ITERATIONS, 32, 'sha256').toString('hex');

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

/** Loopback is the end of an SSH tunnel, and Tailscale encrypts. On anything else what passes can be read, so stored secrets stay here. */
const throughTunnel = (address: string) => {
  if (address === '127.0.0.1' || address === 'localhost' || address === '::1' || address.endsWith('.ts.net')) return true;
  const [a, b] = address.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

// ---------- listening ----------

/** Runs until its settings go away or change. Started on its own by ensureListener, so it outlives any one agent. */
export async function runListener(): Promise<void> {
  const want = listenConfig();
  if (!want) throw new Error('Nothing is set up to listen.');
  const log = (t: string) => {
    try {
      writeFileSync(file('listener.log'), `${new Date().toISOString()} ${t}\n`, { flag: 'a', mode: 0o600 });
    } catch {
      // Logging must never break the link.
    }
  };
  const live = new Map<string, { ws: WebSocket; child: ChildProcess; name: string; since: number }>();
  let strangers = 0;

  const server = await new Promise<WebSocketServer>((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const s = new WebSocketServer({
        host: want.address,
        port: want.port,
        maxPayload: MAX_MESSAGE,
        perMessageDeflate: false,
        // A website can open a WebSocket to any address this computer reaches. Only an extension page is let in.
        verifyClient: ({ origin }: { origin?: string }) => /^(chrome-extension|moz-extension):\/\//.test(origin ?? ''),
      });
      s.once('listening', () => resolve(s));
      s.once('error', (e: NodeJS.ErrnoException) => {
        // The one this replaces takes a moment to notice.
        if (e.code === 'EADDRINUSE' && ++tries < 8) setTimeout(attempt, 1000);
        else reject(e);
      });
    };
    attempt();
  }).catch((e) => {
    writeJson('listener-error.json', { message: `Could not listen on ${want.address}:${want.port}: ${(e as Error).message}` });
    throw e;
  });
  rmSync(file('listener-error.json'), { force: true });

  const mark = () => writeJson('listener.json', { ...want, at: Date.now(), connected: [...live].map(([id, l]) => ({ id, name: l.name, since: l.since })) });

  const attach = (ws: WebSocket, id: string, name: string) => {
    live.get(id)?.ws.terminate();
    // An ordinary host, which cannot tell this from a browser on this machine.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'host'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, AGENTIC_ROUTINES_LINK: throughTunnel(want.address) ? 'private' : 'plain' } });
    const entry = { ws, child, name, since: Date.now() };
    live.set(id, entry);
    mark();
    child.stdout!.on(
      'data',
      nativeReader((m) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      }),
    );
    child.stdin!.on('error', () => {});
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('message', (data: Buffer) => {
      let m: (Message & { t?: string }) | undefined;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.terminate();
      }
      if (m?.t === 'ping') return ws.send('{"t":"pong"}');
      // The person took it off the browser, so this key has no more use.
      if (m?.t === 'forget') {
        revokeBrowser(id);
        return ws.close();
      }
      if (child.stdin!.writable) child.stdin!.write(nativeFrame(m!));
    });
    ws.on('close', () => {
      clearInterval(beat);
      child.stdin!.end();
      setTimeout(() => child.kill(), 2000).unref();
      if (live.get(id) === entry) live.delete(id);
      mark();
      log(`disconnected ${id}`);
    });
    child.on('close', () => ws.close());
    log(`connected ${id} (${name})`);
  };

  server.on('connection', (ws: WebSocket, req: { socket: { remoteAddress?: string } }) => {
    ws.on('error', () => ws.terminate());
    if (strangers >= MAX_STRANGERS) return ws.terminate();
    strangers++;
    let waiting = true;
    const settled = () => {
      if (waiting) strangers--;
      waiting = false;
      clearTimeout(timer);
    };
    const timer = setTimeout(() => ws.terminate(), HANDSHAKE_MS);
    ws.once('close', settled);
    const say = (m: unknown) => ws.send(JSON.stringify(m));
    type Known = { kind: 'key'; id: string; key: string; nc: string; nh: string };
    type Coded = { kind: 'code'; secret: Buffer; nc: string; nh: string; pc: string; ph: string; name: string };
    let state: Known | Coded | undefined;
    const heard = (data: Buffer, binary: boolean) => {
      if (binary || data.length > MAX_HANDSHAKE_BYTES) return ws.terminate();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.terminate();
      }
      if (!state && m.t === 'hello') {
        const id = String(m.id);
        const known = pairedBrowsers();
        const browser = Object.hasOwn(known, id) ? known[id] : undefined;
        const nc = String(m.nonce);
        // Nothing tells a stranger which ids exist.
        if (!browser || !/^[0-9a-f]{64}$/.test(nc)) return ws.terminate();
        const nh = randomBytes(32).toString('hex');
        state = { kind: 'key', id, key: browser.key, nc, nh };
        say({ t: 'challenge', nonce: nh, proof: hmac(Buffer.from(browser.key, 'hex'), 'listener', nc, nh).toString('hex') });
      } else if (!state && m.t === 'pair') {
        const pc = String(m.ecdh);
        const nc = String(m.nonce);
        if (!/^[0-9a-f]{130}$/.test(pc) || !/^[0-9a-f]{64}$/.test(nc)) return ws.terminate();
        const ecdh = createECDH('prime256v1');
        const ph = ecdh.generateKeys('hex');
        const nh = randomBytes(32).toString('hex');
        let secret: Buffer;
        try {
          secret = ecdh.computeSecret(Buffer.from(pc, 'hex'));
        } catch {
          return ws.terminate();
        }
        state = { kind: 'code', secret, nc, nh, pc, ph, name: String(m.name ?? 'browser').slice(0, 80) };
        say({ t: 'challenge', nonce: nh, ecdh: ph });
      } else if (state?.kind === 'key' && m.t === 'proof') {
        if (!same(hmac(Buffer.from(state.key, 'hex'), 'browser', state.nc, state.nh), m.proof)) return ws.terminate();
        ws.off('message', heard);
        settled();
        say({ t: 'ok', computer: hostname() });
        attach(ws, state.id, pairedBrowsers()[state.id]?.name ?? 'browser');
      } else if (state?.kind === 'code' && m.t === 'proof') {
        const pending = readJson<Pending>('codes.json', { codes: [], failures: 0 });
        const now = Date.now();
        const s = state;
        const codes = pending.codes.filter((c) => c.expires > now);
        const hit = codes.find((c) => same(hmac(sessionKey(c.key, s.secret, s.nc, s.nh, s.pc, s.ph), 'browser'), m.proof));
        if (!hit) {
          const failures = pending.failures + 1;
          writeJson('codes.json', failures >= MAX_FAILURES ? { codes: [], failures: 0 } : { codes, failures });
          log(`a wrong pairing code from ${req.socket.remoteAddress}`);
          return ws.terminate();
        }
        writeJson('codes.json', { codes: codes.filter((c) => c !== hit), failures: 0 });
        const session = sessionKey(hit.key, s.secret, s.nc, s.nh, s.pc, s.ph);
        const id = randomBytes(8).toString('hex');
        const key = randomBytes(32);
        setPairedBrowsers({ ...pairedBrowsers(), [id]: { key: key.toString('hex'), name: s.name, pairedAt: now } });
        const wrap = hmac(session, 'wrap');
        log(`paired ${s.name} from ${req.socket.remoteAddress}`);
        say({ t: 'key', id, proof: hmac(session, 'listener').toString('hex'), wrapped: Buffer.from(key.map((b, i) => b ^ wrap[i])).toString('hex'), computer: hostname() });
        ws.close();
      } else ws.terminate();
    };
    ws.on('message', heard);
  });
  server.on('error', (e: Error) => log(e.message));

  const stop = () => {
    for (const l of live.values()) l.ws.terminate();
    server.close();
    rmSync(file('listener.json'), { force: true });
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, stop);
  mark();
  setInterval(() => {
    const now = listenConfig();
    if (!now || now.address !== want.address || now.port !== want.port) return stop();
    const known = pairedBrowsers();
    for (const [id, l] of live) if (!Object.hasOwn(known, id)) l.ws.terminate();
    mark();
  }, BEAT_MS);
}

/** Starts what listens, unless it is already there. It stays after this process ends. */
export async function ensureListener(): Promise<ListenerState> {
  const want = listenConfig();
  if (!want) throw new Error('Nothing is set up to listen.');
  const on = listenerState();
  if (on && on.address === want.address && on.port === want.port) return on;
  rmSync(file('listener-error.json'), { force: true });
  const { AGENTIC_ROUTINES_SESSION: _, ...env } = process.env;
  spawn(process.execPath, [...process.execArgv, process.argv[1], 'remote', 'serve'], { detached: true, stdio: 'ignore', env }).unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = listenerState();
    if (now && now.address === want.address && now.port === want.port) return now;
    const failed = readJson<{ message: string } | null>('listener-error.json', null);
    if (failed) throw new Error(failed.message);
  }
  throw new Error(`Could not start listening on ${want.address}:${want.port}.`);
}

// ---------- pairing ----------

/** This machine's Tailscale address, the usual private network. CGNAT space, which little else uses. */
function tailscaleAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4') continue;
      const [a, b] = i.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) return i.address;
    }
  }
  return undefined;
}

function firstAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return undefined;
}

function parseAddress(s: string): ListenConfig {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(s.trim());
  const port = Number(m?.[2] ?? DEFAULT_PORT);
  if (!m || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`“${s}” is not an address. Give one like 100.64.0.2, or 100.64.0.2:47931.`);
  return { address: m[1].replace(/^\[|\]$/g, ''), port };
}

const shown = (address: string, port: number) => `${address.includes(':') ? `[${address}]` : address}:${port}`;

/**
 * Listens if it is not yet, and makes a code. The person's typing the two into the browser is what connects it, so handing them
 * out needs no more care than this. With no address given: what it listens on already, else Tailscale, else this machine only.
 */
export async function startPairing(asked?: string): Promise<{ address: string; code: string; text: string }> {
  const config = asked ? parseAddress(asked) : (listenConfig() ?? { address: tailscaleAddress() ?? '127.0.0.1', port: DEFAULT_PORT });
  setListenConfig(config);
  await ensureListener();
  const code = mintCode();
  const loopback = config.address === '127.0.0.1' || config.address === 'localhost' || config.address === '::1';
  const everywhere = config.address === '0.0.0.0' || config.address === '::';
  const address = shown(everywhere ? (firstAddress() ?? config.address) : config.address, config.port);
  const lines = [
    `On the computer with the browser, open the Agentic Routines side panel, then Settings, and under Another computer enter:`,
    `  Address: ${address}`,
    `  Code: ${code}`,
    `The code works once, for 10 minutes. That computer only needs the browser and the extension. Once connected, agents here can use that browser with its sign-ins, so enter these only on a browser of your own.`,
  ];
  if (loopback) lines.push(`This computer listens only to itself, as it has no private network address that could be used. To connect over SSH, run this on the computer with the browser and leave it running: ssh -N -L ${config.port}:127.0.0.1:${config.port} ${hostname()}`, `Or use another address, such as a VPN's: agentic-routines remote pair <address>`);
  else lines.push(`The link is not encrypted by us, so keep this address on Tailscale, WireGuard, an SSH tunnel or a network you trust.`);
  return { address, code, text: lines.join('\n') };
}
