import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { paths } from './paths.ts';
import { isEvent, isResponse, lineReader, type Event, type Response } from './protocol.ts';

// The MCP server's line to the browser: a socket to whichever native host
// is running. Each browser with the extension starts its own host.

export class NotConnected extends Error {
  constructor() {
    super('The browser extension is not connected. Open Chrome, Edge or Firefox with Agentic Routines installed, then try again.');
  }
}

interface HostInfo {
  pid: number;
  socket: string;
  browser: string;
  startedAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function hosts(): Promise<HostInfo[]> {
  let files: string[] = [];
  try {
    files = (await readdir(paths.hosts())).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: HostInfo[] = [];
  for (const f of files) {
    try {
      const h = JSON.parse(await readFile(join(paths.hosts(), f), 'utf8')) as HostInfo;
      if (alive(h.pid)) out.push(h);
      else await rm(join(paths.hosts(), f), { force: true });
    } catch {
      // Half-written file from a host that is starting.
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

export class Bridge {
  private sock?: Socket;
  private host?: HostInfo;
  private nextId = 1;
  /** MCP client name, e.g. "claude-code". */
  agent?: string;
  private session = randomUUID();
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private onEvent: (e: Event) => void = () => {}) {}

  get browser(): string | undefined {
    return this.host?.browser;
  }

  private async open(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const [h] = await hosts();
    if (!h) throw new NotConnected();
    const sock = connect(h.socket);
    await new Promise<void>((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    }).catch(() => {
      throw new NotConnected();
    });
    sock.on(
      'data',
      lineReader((m) => {
        if (isEvent(m)) return this.onEvent(m);
        if (!isResponse(m)) return;
        const w = this.waiting.get(m.id);
        if (!w) return;
        this.waiting.delete(m.id);
        clearTimeout(w.timer);
        const r = m as Response;
        if (r.error) w.reject(new Error(r.error));
        else w.resolve(r.result);
      }),
    );
    sock.on('close', () => {
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(new NotConnected());
      }
      this.waiting.clear();
      this.sock = undefined;
    });
    sock.on('error', () => sock.destroy());
    this.sock = sock;
    this.host = h;
    return sock;
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    const sock = await this.open();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      // The extension records which agent did what.
      if (this.agent && !/^(store|host)\./.test(method)) params = { ...(params as object), agent: this.agent, session: this.session };
      sock.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.sock?.destroy();
  }
}
