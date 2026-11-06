import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { current, debugOn, record, redact } from '../debug.ts';
import { paths } from '../paths.ts';
import * as profileNames from '../store/profiles.ts';
import { isEvent, isResponse, lineReader, type Event, type Response } from '../protocol.ts';

// The MCP server's line to the browser: a socket to whichever native host
// is running. Each browser with the extension starts its own host.

export class NotConnected extends Error {
  constructor() {
    super('The browser extension is not connected. Open Chrome, Edge or Firefox with Agentic Routines installed, then try again.');
  }
}

export interface HostInfo {
  pid: number;
  socket: string;
  browser: string;
  /** Which profile of that browser: each profile with the extension has a host of its own. */
  profile?: string;
  /** The account the extension is signed in with in that profile, if any. */
  email?: string;
  startedAt: number;
  /** When the person last used a window of that profile. */
  focusedAt?: number;
}

export interface BrowserProfile {
  id: string;
  label: string;
  browser: string;
  email?: string;
  /** The one this session is working in. */
  current: boolean;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function hosts(): Promise<HostInfo[]> {
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

/** What a person would call a profile: the name they gave it, the account it is signed in with, else the browser and the start of its id. */
export async function profileLabel(h: HostInfo): Promise<string> {
  const given = h.profile ? (await profileNames.names())[h.profile] : undefined;
  return given ?? h.email ?? `${h.browser}${h.profile ? ` ${h.profile.slice(0, 4)}` : ''}`;
}

export class Bridge {
  private sock?: Socket;
  private host?: HostInfo;
  /** The profile an agent asked for, by name, id or account. Without one, the profile the person used last. */
  private want? = process.env.AGENTIC_ROUTINES_PROFILE || undefined;
  /** An agent that chose a profile is not told which one it got. */
  private told = !!process.env.AGENTIC_ROUTINES_PROFILE;
  private note?: string;
  private nextId = 1;
  /** MCP client name, e.g. "claude-code". */
  agent?: string;
  private session = randomUUID();
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private onEvent: (e: Event) => void = () => {}) {}

  get browser(): string | undefined {
    return this.host?.browser;
  }

  /** Every browser profile with the extension that is open now. */
  async profiles(): Promise<BrowserProfile[]> {
    const all = await hosts();
    // Before the first action nothing is connected yet: the one that would be used is the current one.
    const live = this.sock && !this.sock.destroyed ? this.host : undefined;
    const target = live ?? (all.length ? await this.pick(all).catch(() => undefined) : undefined);
    return Promise.all(all.map(async (h) => ({ id: h.profile ?? String(h.pid), label: await profileLabel(h), browser: h.browser, email: h.email, current: target?.pid === h.pid })));
  }

  /** Work in another profile from now on. */
  async use(name: string): Promise<BrowserProfile> {
    this.want = name;
    this.sock?.destroy();
    this.sock = undefined;
    this.host = undefined;
    this.told = true;
    await this.open();
    return (await this.profiles()).find((p) => p.current)!;
  }

  /** Said once, with the first answer, when more than one profile is open and nobody chose. */
  takeNote(): string | undefined {
    const n = this.note;
    this.note = undefined;
    return n;
  }

  private async pick(all: HostInfo[]): Promise<HostInfo> {
    if (!this.want) return [...all].sort((a, b) => (b.focusedAt ?? b.startedAt) - (a.focusedAt ?? a.startedAt))[0];
    const w = this.want.toLowerCase();
    const named = await Promise.all(all.map(async (h) => ({ h, label: (await profileLabel(h)).toLowerCase() })));
    const found =
      named.find((x) => x.h.profile === this.want || String(x.h.pid) === this.want) ??
      named.find((x) => x.label === w || x.h.email?.toLowerCase() === w) ??
      (named.filter((x) => x.h.profile?.startsWith(w) || x.label.includes(w)).length === 1 ? named.find((x) => x.h.profile?.startsWith(w) || x.label.includes(w)) : undefined);
    if (!found) throw new Error(`No open browser profile matches “${this.want}”. Open now: ${named.map((x) => x.label).join(', ')}.`);
    return found.h;
  }

  private async open(): Promise<Socket> {
    if (this.sock && !this.sock.destroyed) return this.sock;
    const all = await hosts();
    if (!all.length) throw new NotConnected();
    const h = await this.pick(all);
    if (all.length > 1 && !this.told) {
      this.told = true;
      const labels = (await Promise.all(all.map(profileLabel))).join(', ');
      this.note = `Working in ${await profileLabel(h)}. ${all.length} browser profiles are open (${labels}), and this is the one the person used last. To use another, call browser_profile with use; it stays for this session.`;
    }
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
    const t = Date.now();
    const call = current.getStore();
    const note = (ok: boolean, out?: string) => debugOn() && record({ kind: 'bridge', call, agent: this.agent, name: method, args: redact(params, '', method), ms: Date.now() - t, ok, out: out ? out.slice(0, 300) : undefined });
    return this.send<T>(method, params, timeoutMs).then(
      (r) => (note(true), r),
      (e: Error) => {
        note(false, e.message);
        throw e;
      },
    );
  }

  private async send<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const sock = await this.open();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s${/^browser\.(click|type|select|upload|press)$/.test(method) ? '. The action may still have happened: read the page to see before you try it again' : ''}`));
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
