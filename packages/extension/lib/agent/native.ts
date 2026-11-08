// The lines to a host, which the MCP server talks to: the native host on this computer, and the link to one on another
// computer when the person made one. An open line also keeps the service worker alive.
// What an agent asks for comes back on its own line. What the extension asks on behalf of an agent, such as a file or a secret,
// goes to that agent's computer too, as that is where it lives. The panel uses the host here when there is one.
import { platform } from '../platform';
import { openLink, pairLink, type LinkKey } from './link';

const HOST = 'com.agentic_routines.host';
const PING_MS = 20_000;

type Handler = (method: string, params: any) => Promise<unknown>;
type Kind = 'native' | 'network';
type Wire = { send: (m: unknown) => void; close: () => void };
/** Which agent this is on behalf of, as far as the caller knows. */
export type Via = { session?: string; tab?: number };

const wires: Partial<Record<Kind, Wire>> = {};
/** Answered its hello. A native port opens even with no host installed, and closes a moment later. */
const ready = new Set<Kind>();
const ofSession = new Map<string, Kind>();
const ofTab = new Map<number, Kind>();
const firstSeen = new Map<string, number>();
let nextId = 1;
const waiting = new Map<number, { kind: Kind; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const listeners = new Set<(connected: boolean) => void>();
const eventListeners = new Set<(event: string, data: unknown) => void>();
let handler: Handler = async () => {
  throw new Error('Not ready');
};
let retry = 1000;

export function onRequest(h: Handler) {
  handler = h;
}

export function onConnection(fn: (connected: boolean) => void) {
  listeners.add(fn);
}

export function onHostEvent(fn: (event: string, data: unknown) => void) {
  eventListeners.add(fn);
}

export function connected() {
  return ready.size > 0;
}

function kindFor(via?: Via): Kind {
  const known = (via?.session && ofSession.get(via.session)) || (via?.tab !== undefined && ofTab.get(via.tab));
  return known || (ready.has('native') || !wires.network ? 'native' : 'network');
}

/** The agent behind this is on another computer, so its files are not on this one. */
export const linked = (via?: Via) => kindFor(via) === 'network';

/** The tab an agent is working in, for what is later done there without saying whose it is. */
export function noteTab(tabId: number, session?: string) {
  const kind = session && ofSession.get(session);
  if (kind) ofTab.set(tabId, kind);
}

/** When this agent was first heard from. It is told about nothing from before. */
export const firstSeenAt = (session?: string) => (session && firstSeen.get(session)) || Date.now();

function received(kind: Kind, wire: Wire, m: any) {
  if ('method' in m && 'id' in m) {
    const session = m.params?.session;
    if (typeof session === 'string') {
      ofSession.set(session, kind);
      if (!firstSeen.has(session)) firstSeen.set(session, Date.now());
    }
    Promise.resolve()
      .then(() => handler(m.method, m.params))
      .then(
        (result) => wire.send({ id: m.id, result: result ?? null }),
        (e) => wire.send({ id: m.id, error: (e as Error).message }),
      );
  } else if ('id' in m) {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m.result);
  } else if ('event' in m) {
    if (m.event === 'agent.gone') {
      ofSession.delete(m.data?.session);
      firstSeen.delete(m.data?.session);
    }
    for (const fn of eventListeners) fn(m.event, m.data);
  }
}

function dropped(kind: Kind) {
  delete wires[kind];
  ready.delete(kind);
  for (const [id, w] of waiting) {
    if (w.kind !== kind) continue;
    waiting.delete(id);
    w.reject(new Error('Host disconnected'));
  }
  for (const fn of listeners) fn(false);
}

function connectNative() {
  if (wires.native) return;
  let p: Browser.runtime.Port;
  try {
    p = browser.runtime.connectNative(HOST);
  } catch {
    setTimeout(connectNative, (retry = Math.min(retry * 2, 30_000)));
    return;
  }
  const wire: Wire = { send: (m) => p.postMessage(m), close: () => p.disconnect() };
  wires.native = wire;
  p.onMessage.addListener((m: any) => received('native', wire, m));
  p.onDisconnect.addListener(() => {
    // Reading it marks it handled. With no host installed yet, this is the normal state.
    void browser.runtime.lastError;
    dropped('native');
    setTimeout(connectNative, (retry = Math.min(retry * 2, 30_000)));
  });
  sayHello('native').then(
    () => {
      retry = 1000;
      ready.add('native');
      for (const fn of listeners) fn(true);
    },
    () => {},
  );
}

// ---------- the link to another computer ----------

export interface LinkStatus {
  address: string;
  computer: string;
  connected: boolean;
  error?: string;
}

let opening = false;
let linkError: string | undefined;
let linkRetry = 1000;
let saved: LinkKey | undefined;
const stored = async () => ((await browser.storage.local.get('link')) as { link?: LinkKey }).link;

export const linkStatus = async (): Promise<LinkStatus | undefined> => {
  const k = saved ?? (saved = await stored());
  return k && { address: k.address, computer: k.computer, connected: !!wires.network, error: linkError };
};

/** Tries now, if there is a link and it is down. A service worker with nothing open goes to sleep, so an alarm brings it back. */
export async function connectLink() {
  if (wires.network || opening) return;
  const k = (saved = await stored());
  if (!k) return;
  opening = true;
  try {
    const { ws, computer } = await openLink(k);
    linkError = undefined;
    linkRetry = 1000;
    if (computer !== k.computer) {
      saved = { ...k, computer };
      await browser.storage.local.set({ link: saved });
    }
    const wire: Wire = { send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)), close: () => ws.close() };
    wires.network = wire;
    let heard = Date.now();
    const ping = setInterval(() => {
      if (Date.now() - heard > 3 * PING_MS) return ws.close();
      wire.send({ t: 'ping' });
    }, PING_MS);
    ws.addEventListener('message', (e) => {
      heard = Date.now();
      const m = JSON.parse(String(e.data));
      if (m.t !== 'pong') received('network', wire, m);
    });
    ws.addEventListener('close', () => {
      clearInterval(ping);
      if (wires.network !== wire) return;
      dropped('network');
      setTimeout(connectLink, (linkRetry = Math.min(linkRetry * 2, 30_000)));
    });
    await sayHello('network');
    ready.add('network');
    for (const fn of listeners) fn(true);
  } catch (e) {
    linkError = (e as Error).message;
    setTimeout(connectLink, (linkRetry = Math.min(linkRetry * 2, 30_000)));
    for (const fn of listeners) fn(false);
  } finally {
    opening = false;
  }
}

/** The person typed these in the panel. An agent or a page has no way to reach this. */
export async function pair(address: string, code: string) {
  const { profileId } = (await browser.storage.local.get('profileId')) as { profileId?: string };
  const k = await pairLink(address, code, `${platform.name}${profileId ? ` ${profileId.slice(0, 4)}` : ''}`);
  await forget();
  saved = k;
  await browser.storage.local.set({ link: k });
  browser.alarms.create('link', { periodInMinutes: 1 });
  linkError = undefined;
  await connectLink();
}

export async function forget() {
  const wire = wires.network;
  wires.network = undefined;
  if (wire) {
    wire.send({ t: 'forget' });
    wire.close();
    dropped('network');
  }
  saved = undefined;
  linkError = undefined;
  await browser.storage.local.remove('link');
  await browser.alarms.clear('link');
}

export function connect() {
  connectNative();
  void connectLink();
}

/**
 * Tells the host which browser and which profile this is. Every profile with the extension has its own host, and the
 * profile id is kept in this profile's storage, so an agent can pick one and keep it. The sign-in, when there is one,
 * helps a person tell profiles apart. Said again when it changes.
 */
async function sayHello(kind: Kind) {
  const { profileId, session } = (await browser.storage.local.get(['profileId', 'session'])) as { profileId?: string; session?: { account?: { email?: string } } };
  let profile = profileId;
  if (!profile) {
    profile = crypto.randomUUID();
    await browser.storage.local.set({ profileId: profile });
  }
  return ask(kind, 'host.hello', { browser: platform.name, profile, email: session?.account?.email });
}

export async function hello() {
  await Promise.all((Object.keys(wires) as Kind[]).map(sayHello));
}

function ask<T>(kind: Kind, method: string, params?: unknown): Promise<T> {
  const wire = wires[kind];
  if (!wire) return Promise.reject(new Error('Run `npx agentic-routines setup` to connect this browser, or connect to your agent on another computer in Settings.'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { kind, resolve: resolve as (v: unknown) => void, reject });
    wire.send({ id, method, params });
  });
}

export function call<T = unknown>(method: string, params?: unknown, via?: Via): Promise<T> {
  return ask(kindFor(via), method, params);
}

/** To the agent it concerns when that is known, else to every host. */
export function emit(event: string, data?: unknown, via?: Via) {
  if (via?.session || via?.tab !== undefined) return wires[kindFor(via)]?.send({ event, data });
  for (const w of Object.values(wires)) w?.send({ event, data });
}
