// The line to the native host, which the MCP server talks to.
// An open port also keeps the service worker alive.
import { platform } from '../platform';

const HOST = 'com.agentic_routines.host';

type Handler = (method: string, params: any) => Promise<unknown>;

let port: Browser.runtime.Port | undefined;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
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
  return !!port;
}

export function connect() {
  if (port) return;
  let p: Browser.runtime.Port;
  try {
    p = browser.runtime.connectNative(HOST);
  } catch {
    setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
    return;
  }
  port = p;
  p.onMessage.addListener(async (m: any) => {
    if ('method' in m && 'id' in m) {
      try {
        p.postMessage({ id: m.id, result: (await handler(m.method, m.params)) ?? null });
      } catch (e) {
        p.postMessage({ id: m.id, error: (e as Error).message });
      }
    } else if ('id' in m) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error));
      else w.resolve(m.result);
    } else if ('event' in m) {
      for (const fn of eventListeners) fn(m.event, m.data);
    }
  });
  p.onDisconnect.addListener(() => {
    // Reading it marks it handled. With no host installed yet, this is the normal state.
    void browser.runtime.lastError;
    port = undefined;
    for (const w of waiting.values()) w.reject(new Error('Host disconnected'));
    waiting.clear();
    for (const fn of listeners) fn(false);
    setTimeout(connect, (retry = Math.min(retry * 2, 30_000)));
  });
  hello().then(
    () => {
      retry = 1000;
      for (const fn of listeners) fn(true);
    },
    () => {},
  );
}

/**
 * Tells the host which browser and which profile this is. Every profile with the extension has its own host, and the
 * profile id is kept in this profile's storage, so an agent can pick one and keep it. The sign-in, when there is one,
 * helps a person tell profiles apart. Said again when it changes.
 */
export async function hello() {
  const { profileId, session } = (await browser.storage.local.get(['profileId', 'session'])) as { profileId?: string; session?: { account?: { email?: string } } };
  let profile = profileId;
  if (!profile) {
    profile = crypto.randomUUID();
    await browser.storage.local.set({ profileId: profile });
  }
  return call('host.hello', { browser: platform.name, profile, email: session?.account?.email });
}

export function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!port) return Promise.reject(new Error('Run `npx agentic-routines setup` to connect this browser.'));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    port!.postMessage({ id, method, params });
  });
}

export function emit(event: string, data?: unknown) {
  port?.postMessage({ event, data });
}
