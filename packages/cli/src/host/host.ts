import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { checkUpload, MAX_STREAM, mb } from './files.ts';
import { paths, socketPath } from '../paths.ts';
import { isEvent, isRequest, isResponse, lineReader, nativeFrame, nativeReader, type Message, type Request } from '../protocol.ts';
import * as sources from '../store/sources.ts';
import * as store from '../store/routines.ts';

// Started by the browser through native messaging, one per browser.
// stdout belongs to the browser, so all logging goes to a file.

// Native messages to the browser are capped at 1 MB; base64 adds a third.
// A multiple of three, so the pieces of a file join as base64 without re-encoding.
const CHUNK = 639 * 1024;

function log(...a: unknown[]) {
  try {
    appendFileSync(paths.log(), `${new Date().toISOString()} [${process.pid}] ${a.map(String).join(' ')}\n`);
  } catch {
    // Logging must never break the host.
  }
}

// What an agent may ask of the host over the socket. Changing sources and installing from them is only
// ever done from the browser, after the person clicked.
const AGENT_MAY = new Set(['store.list', 'store.read', 'store.write', 'store.remove', 'store.setEnabled', 'sources.list', 'sources.entries', 'sources.preview']);

export async function handleStore(method: string, p: any, fromBrowser = true): Promise<unknown> {
  if (!fromBrowser && !AGENT_MAY.has(method)) throw new Error('Only the browser can do that.');
  switch (method) {
    case 'store.list':
      return store.list();
    case 'store.read':
      return store.read(p.id);
    case 'store.write':
      return store.write(p.routine, p.owner, p.origin);
    case 'store.remove':
      return store.remove(p.id);
    case 'store.setEnabled':
      return sources.enable(p.id, p.enabled);
    case 'sources.list':
      return sources.list();
    case 'sources.add':
      return sources.add(String(p.address));
    case 'sources.remove':
      return sources.remove(String(p.id));
    case 'sources.setEnabled':
      return sources.setEnabled(String(p.id), !!p.enabled);
    case 'sources.entries':
      return sources.entries(p.id ? String(p.id) : undefined, !!p.fresh);
    case 'sources.preview':
      return sources.preview(String(p.id), String(p.path), p.ref ? String(p.ref) : undefined);
    case 'sources.install':
      return sources.install(String(p.id), String(p.path), p.ref ? String(p.ref) : undefined);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

export function runHost(): void {
  mkdirSync(paths.hosts(), { recursive: true, mode: 0o700 });
  const sock = socketPath(process.pid);
  const info = join(paths.hosts(), `${process.pid}.json`);
  const clients = new Set<Socket>();
  // Agent sessions by connection, to tell the browser when one goes away.
  const sessions = new Map<Socket, string>();
  // Requests forwarded to the extension: our id -> where the answer goes.
  const pending = new Map<number, { client: Socket; id: number }>();
  let nextId = 1;
  let browser = 'unknown';
  // Which profile of that browser, as it says in hello. The file is rewritten when any of it changes.
  let profile: string | undefined;
  let email: string | undefined;
  const startedAt = Date.now();
  let focusedAt = startedAt;
  const writeInfo = () => writeFileSync(info, JSON.stringify({ pid: process.pid, socket: sock, browser, profile, email, startedAt, focusedAt }), { mode: 0o600 });
  // Files an agent asked to upload. The extension can read only these.
  const allowed = new Map<string, number>();

  /** Checks each path, then lets the browser read it for an hour. Nothing is allowed unless every path passes. */
  async function allowFiles(list: string[]) {
    if (!Array.isArray(list) || list.length > 20) throw new Error('Up to 20 files at a time.');
    const ok = [];
    for (const p of list) ok.push({ asked: String(p), ...(await checkUpload(String(p))) });
    for (const c of ok) {
      allowed.set(c.path, Date.now() + 60 * 60_000);
      allowed.set(c.asked, Date.now() + 60 * 60_000);
    }
    return ok.map((c) => ({ name: c.name, size: c.size }));
  }

  /** The browser asks before reading a file: is it allowed, and how big. */
  async function fileInfo(p: { path: string }) {
    const until = allowed.get(p.path);
    if (!until || until < Date.now()) throw new Error(`${p.path} was not named by the user or the agent for this upload, so the browser will not read it.`);
    const c = await checkUpload(p.path);
    return { name: c.name, size: c.size, tooBigToStream: c.size > MAX_STREAM, label: mb(c.size), limit: mb(MAX_STREAM) };
  }

  async function readChunk(p: { path: string; offset: number }) {
    const until = allowed.get(p.path);
    if (!until || until < Date.now()) throw new Error(`Not allowed to read ${p.path}`);
    const c = await checkUpload(p.path);
    if (c.size > MAX_STREAM) throw new Error(`${c.name} is ${mb(c.size)}. Without a DevTools session files over ${mb(MAX_STREAM)} cannot be sent through the host. Use a Chromium browser, or a smaller file.`);
    const fh = await open(p.path, 'r');
    try {
      const { size } = await fh.stat();
      const buf = Buffer.alloc(Math.min(CHUNK, Math.max(0, size - p.offset)));
      await fh.read(buf, 0, buf.length, p.offset);
      return { name: basename(p.path), size, data: buf.toString('base64') };
    } finally {
      await fh.close();
    }
  }

  const toBrowser = (m: Message) => process.stdout.write(nativeFrame(m));
  const toClient = (c: Socket, m: Message) => c.writable && c.write(JSON.stringify(m) + '\n');

  const cleanup = () => {
    rmSync(sock, { force: true });
    rmSync(info, { force: true });
  };

  const server = createServer((client) => {
    clients.add(client);
    client.on(
      'data',
      lineReader(async (m) => {
        if (!isRequest(m)) return;
        const session = (m.params as { session?: string } | undefined)?.session;
        if (session) sessions.set(client, session);
        if (m.method.startsWith('store.') || m.method.startsWith('sources.')) {
          try {
            toClient(client, { id: m.id, result: await handleStore(m.method, m.params, false) });
          } catch (e) {
            toClient(client, { id: m.id, error: (e as Error).message });
          }
          if (m.method === 'store.write' || m.method === 'store.remove' || m.method === 'store.setEnabled' || m.method === 'sources.install') {
            toBrowser({ event: 'routines.changed' });
            for (const c of clients) if (c !== client) toClient(c, { event: 'routines.changed' });
          }
          return;
        }
        if (m.method === 'host.info') {
          toClient(client, { id: m.id, result: { pid: process.pid, browser } });
          return;
        }
        if (m.method === 'host.allowFiles') {
          allowFiles((m.params as { paths: string[] }).paths).then(
            (result) => toClient(client, { id: m.id, result }),
            (e) => toClient(client, { id: m.id, error: (e as Error).message }),
          );
          return;
        }
        const id = nextId++;
        pending.set(id, { client, id: m.id });
        toBrowser({ id, method: m.method, params: m.params });
      }),
    );
    const drop = () => {
      clients.delete(client);
      const session = sessions.get(client);
      sessions.delete(client);
      if (session) toBrowser({ event: 'agent.gone', data: { session } });
      for (const [k, v] of pending) if (v.client === client) pending.delete(k);
    };
    client.on('close', drop);
    client.on('error', drop);
  });

  process.stdin.on(
    'data',
    nativeReader(async (m) => {
      if (isResponse(m)) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        toClient(p.client, { ...m, id: p.id });
      } else if (isRequest(m)) {
        const req = m as Request;
        if (req.method === 'host.hello') {
          const hello = (req.params ?? {}) as { browser?: string; profile?: string; email?: string };
          browser = String(hello.browser ?? 'unknown');
          profile = typeof hello.profile === 'string' ? hello.profile : undefined;
          email = typeof hello.email === 'string' ? hello.email : undefined;
          writeInfo();
          toBrowser({ id: req.id, result: { pid: process.pid, version: process.env.npm_package_version ?? '0.1.0' } });
          return;
        }
        if (req.method === 'fs.info') {
          fileInfo(req.params as { path: string }).then(
            (result) => toBrowser({ id: req.id, result }),
            (e) => toBrowser({ id: req.id, error: (e as Error).message }),
          );
          return;
        }
        // The person typed this path in the panel to run a routine; the same checks apply.
        if (req.method === 'host.allowFiles') {
          allowFiles((req.params as { paths: string[] }).paths).then(
            (result) => toBrowser({ id: req.id, result }),
            (e) => toBrowser({ id: req.id, error: (e as Error).message }),
          );
          return;
        }
        if (req.method === 'fs.readChunk') {
          readChunk(req.params as { path: string; offset: number }).then(
            (result) => toBrowser({ id: req.id, result }),
            (e) => toBrowser({ id: req.id, error: (e as Error).message }),
          );
          return;
        }
        try {
          const result = await handleStore(req.method, req.params);
          toBrowser({ id: req.id, result });
          if (req.method === 'store.write' || req.method === 'store.remove' || req.method === 'store.setEnabled' || req.method === 'sources.install') for (const c of clients) toClient(c, { event: 'routines.changed' });
        } catch (e) {
          toBrowser({ id: req.id, error: (e as Error).message });
        }
      } else if (isEvent(m)) {
        // The person went to a window of this profile: an agent with no other instruction uses the profile they were last in.
        if (m.event === 'profile.focus') {
          focusedAt = Date.now();
          writeInfo();
          return;
        }
        for (const c of clients) toClient(c, m);
      }
    }),
  );
  process.stdin.on('end', () => {
    log('browser closed the port');
    cleanup();
    process.exit(0);
  });
  for (const sig of ['SIGINT', 'SIGTERM'] as const)
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });

  // The block list is read at least daily: routines from a blocked source turn themselves off.
  const checkBlocks = () =>
    sources.applyBlocks().then(
      (off) => {
        if (!off.length) return;
        log('turned off by the block list:', off.join(', '));
        toBrowser({ event: 'routines.changed' });
        for (const c of clients) toClient(c, { event: 'routines.changed' });
      },
      (e) => log('block list check failed', (e as Error).message),
    );
  checkBlocks();
  setInterval(checkBlocks, 6 * 60 * 60_000).unref();

  cleanup();
  server.listen(sock, () => {
    // Only this user's programs may talk to the browser through it, whatever the umask was.
    if (process.platform !== 'win32') chmodSync(sock, 0o600);
    log('listening', sock);
    writeInfo();
  });
  server.on('error', (e) => log('server error', e.message));
}
