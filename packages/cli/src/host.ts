import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { paths, socketPath } from './paths.ts';
import { isEvent, isRequest, isResponse, lineReader, nativeFrame, nativeReader, type Message, type Request } from './protocol.ts';
import * as store from './store.ts';

// Started by the browser through native messaging, one per browser.
// stdout belongs to the browser, so all logging goes to a file.

// Native messages to the browser are capped at 1 MB; base64 adds a third.
const CHUNK = 640 * 1024;

function log(...a: unknown[]) {
  try {
    appendFileSync(paths.log(), `${new Date().toISOString()} [${process.pid}] ${a.map(String).join(' ')}\n`);
  } catch {
    // Logging must never break the host.
  }
}

export async function handleStore(method: string, p: any): Promise<unknown> {
  switch (method) {
    case 'store.list':
      return store.list();
    case 'store.read':
      return store.read(p.id);
    case 'store.write':
      return store.write(p.routine, p.owner);
    case 'store.remove':
      return store.remove(p.id);
    case 'store.setEnabled':
      return store.setEnabled(p.id, p.enabled);
    default:
      throw new Error(`Unknown method ${method}`);
  }
}

export function runHost(): void {
  mkdirSync(paths.hosts(), { recursive: true, mode: 0o700 });
  const sock = socketPath(process.pid);
  const info = join(paths.hosts(), `${process.pid}.json`);
  const clients = new Set<Socket>();
  // Requests forwarded to the extension: our id -> where the answer goes.
  const pending = new Map<number, { client: Socket; id: number }>();
  let nextId = 1;
  let browser = 'unknown';
  // Files an agent asked to upload. The extension can read only these.
  const allowed = new Map<string, number>();

  async function readChunk(p: { path: string; offset: number }) {
    const until = allowed.get(p.path);
    if (!until || until < Date.now()) throw new Error(`Not allowed to read ${p.path}`);
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
        if (m.method.startsWith('store.')) {
          try {
            toClient(client, { id: m.id, result: await handleStore(m.method, m.params) });
          } catch (e) {
            toClient(client, { id: m.id, error: (e as Error).message });
          }
          if (m.method !== 'store.list' && m.method !== 'store.read') toBrowser({ event: 'routines.changed' });
          return;
        }
        if (m.method === 'host.info') {
          toClient(client, { id: m.id, result: { pid: process.pid, browser } });
          return;
        }
        if (m.method === 'host.allowFiles') {
          for (const p of (m.params as { paths: string[] }).paths) allowed.set(p, Date.now() + 60 * 60_000);
          toClient(client, { id: m.id, result: true });
          return;
        }
        const id = nextId++;
        pending.set(id, { client, id: m.id });
        toBrowser({ id, method: m.method, params: m.params });
      }),
    );
    const drop = () => {
      clients.delete(client);
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
          browser = String((req.params as any)?.browser ?? 'unknown');
          writeFileSync(info, JSON.stringify({ pid: process.pid, socket: sock, browser, startedAt: Date.now() }), { mode: 0o600 });
          toBrowser({ id: req.id, result: { pid: process.pid, version: process.env.npm_package_version ?? '0.1.0' } });
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
          if (req.method !== 'store.list' && req.method !== 'store.read') for (const c of clients) toClient(c, { event: 'routines.changed' });
        } catch (e) {
          toBrowser({ id: req.id, error: (e as Error).message });
        }
      } else if (isEvent(m)) {
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

  cleanup();
  server.listen(sock, () => {
    log('listening', sock);
    writeFileSync(info, JSON.stringify({ pid: process.pid, socket: sock, browser, startedAt: Date.now() }), { mode: 0o600 });
  });
  server.on('error', (e) => log('server error', e.message));
}
