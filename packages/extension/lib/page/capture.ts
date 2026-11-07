import * as native from '../agent/native';
import { platform } from '../platform';
import { ensureOffscreen } from './offscreen';
import { scrub as hideLooksSecret, scrubUrl } from './logs';
import { scrubText } from './secrets';
import { ask, markRecording } from './tabs';

// A tab on video, the last minute of it kept in case something breaks, and what it sent over the network. Files go to a
// private folder through the host, under names made here. Passwords are dots in any picture, and nothing here needs the page's help.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const needDebugger = () => {
  if (!platform.cdp) throw new Error('This browser does not let an extension do this. It needs a Chromium browser.');
};

// A picture is asked for by the browser, not taken from the screen, so a tab behind another still gives one, only more slowly.
function pictures(tabId: number, fps: number, each: (jpeg: string) => void, gone: (why: string) => void) {
  let on = true;
  void (async () => {
    while (on) {
      const at = Date.now();
      try {
        const shot = await Promise.race([
          platform.cdp!(tabId, (send) => send('Page.captureScreenshot', { format: 'jpeg', quality: 55, optimizeForSpeed: true })) as Promise<{ data: string }>,
          sleep(5000).then(() => undefined),
        ]);
        if (shot && on) each(shot.data);
      } catch (e) {
        if (!on) return;
        on = false;
        gone((e as Error).message);
        return;
      }
      await sleep(Math.max(0, 1000 / fps - (Date.now() - at)));
    }
  })();
  return () => void (on = false);
}

const toRecorder = async <T = unknown>(msg: object): Promise<T> => {
  const r = (await browser.runtime.sendMessage(msg)) as { ok?: T; err?: string } | undefined;
  if (r?.err) throw new Error(r.err);
  return r?.ok as T;
};

// ---------- files ----------

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const write = (name: string, data: string, base64: boolean) => native.call<{ path: string; bytes: number }>('fs.capture', { name, data, base64 });

// Pieces of one video, in order, whichever message brings them.
const files = new Map<string, { name: string; chain: Promise<unknown>; path?: string; bytes: number }>();
export function videoPiece(id: string, data: string) {
  const f = files.get(id);
  if (!f) return;
  f.chain = f.chain.then(async () => {
    const r = await write(f.name, data, true);
    f.path = r.path;
    f.bytes = r.bytes;
  });
}

async function openVideo(id: string, format: 'webm' | 'mp4', kind: string) {
  needDebugger();
  await ensureOffscreen();
  files.set(id, { name: `${kind}-${stamp()}-${id}.${format}`, chain: Promise.resolve(), bytes: 0 });
  await toRecorder({ t: 'rec.start', id, format });
}

async function closeVideo(id: string) {
  const r = await toRecorder<{ empty: boolean }>({ t: 'rec.stop', id });
  const f = files.get(id);
  await f?.chain;
  files.delete(id);
  if (r.empty || !f?.path) throw new Error('No pictures came from this tab, so there is no video.');
  return { path: f.path, bytes: f.bytes };
}

// ---------- recording ----------

interface Recording {
  id: string;
  format: 'webm' | 'mp4';
  cursor: boolean;
  startedAt: number;
  frames: number;
  stop: () => void;
  broke?: string;
}
const recordings = new Map<number, Recording>();

// The glow, cursor and outline are for whoever is watching live. In a video only when asked.
const veil = (tabId: number, hold: boolean) => ask(tabId, { t: 'veil', on: false, hold }).catch(() => {});

export async function startRecording(tabId: number, o: { format?: 'webm' | 'mp4'; cursor?: boolean }) {
  if (recordings.has(tabId)) throw new Error('This tab is already being recorded. Stop it first.');
  const id = crypto.randomUUID().slice(0, 8);
  const format = o.format ?? 'webm';
  await openVideo(id, format, 'recording');
  const rec: Recording = { id, format, cursor: !!o.cursor, startedAt: Date.now(), frames: 0, stop: () => {} };
  recordings.set(tabId, rec);
  if (!rec.cursor) await veil(tabId, true);
  markRecording(tabId, true);
  rec.stop = pictures(
    tabId,
    8,
    (data) => {
      rec.frames++;
      void toRecorder({ t: 'rec.frame', id, data }).catch(() => {});
    },
    (why) => (rec.broke = why),
  );
  return { recording: true, format };
}

export async function stopRecording(tabId: number, cancel = false) {
  const rec = recordings.get(tabId);
  if (!rec) throw new Error('This tab is not being recorded.');
  rec.stop();
  recordings.delete(tabId);
  markRecording(tabId, false);
  if (!rec.cursor) await veil(tabId, false);
  const out = await closeVideo(rec.id).catch((e) => (cancel ? undefined : Promise.reject(e)));
  if (cancel) {
    if (out) await native.call('fs.captureRemove', { path: out.path }).catch(() => {});
    return { cancelled: true };
  }
  return { ...out, frames: rec.frames, seconds: Math.round((Date.now() - rec.startedAt) / 1000), broke: rec.broke };
}

export const recordingStatus = (tabId: number) => {
  const r = recordings.get(tabId);
  return r ? { recording: true, seconds: Math.round((Date.now() - r.startedAt) / 1000), frames: r.frames, format: r.format, broke: r.broke } : { recording: false };
};

// ---------- flight recorder ----------

const FLIGHT_FPS = 2;
const FLIGHT_SECONDS = 60;
const FLIGHT_SPEEDUP = 5;
interface Flight {
  frames: string[];
  startedAt: number;
  stop: () => void;
  broke?: string;
}
const flights = new Map<number, Flight>();
export const flightOn = (tabId: number) => flights.has(tabId);

export function startFlight(tabId: number) {
  needDebugger();
  if (flights.has(tabId)) return { on: true, already: true };
  const f: Flight = { frames: [], startedAt: Date.now(), stop: () => {} };
  flights.set(tabId, f);
  f.stop = pictures(
    tabId,
    FLIGHT_FPS,
    (data) => {
      f.frames.push(data);
      if (f.frames.length > FLIGHT_FPS * FLIGHT_SECONDS) f.frames.shift();
    },
    (why) => (f.broke = why),
  );
  return { on: true };
}

export function stopFlight(tabId: number) {
  flights.get(tabId)?.stop();
  flights.delete(tabId);
}

export const flightStatus = (tabId: number) => {
  const f = flights.get(tabId);
  return f ? { on: true, seconds_kept: Math.round(f.frames.length / FLIGHT_FPS), broke: f.broke } : { on: false };
};

/** The last minute as a video. A person reads it faster than it happened, so it plays that way, and it does not take a minute to make. */
export async function saveFlight(tabId: number) {
  const f = flights.get(tabId);
  if (!f) throw new Error('The flight recorder is not on for this tab. Start it before what you want to catch.');
  if (!f.frames.length) throw new Error('The flight recorder has no pictures yet.');
  const id = crypto.randomUUID().slice(0, 8);
  const frames = [...f.frames];
  await openVideo(id, 'webm', 'flight');
  for (const data of frames) {
    await toRecorder({ t: 'rec.frame', id, data });
    await sleep(1000 / (FLIGHT_FPS * FLIGHT_SPEEDUP));
  }
  const out = await closeVideo(id);
  return { ...out, seconds: Math.round(frames.length / FLIGHT_FPS), plays_faster_by: FLIGHT_SPEEDUP };
}

// ---------- network ----------

const HIDDEN_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|api-key)$/i;
const MAX_ENTRIES = 5000;

interface Entry {
  started: number;
  wall: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  postData?: string;
  mime?: string;
  status?: number;
  statusText?: string;
  respHeaders?: Record<string, string>;
  size?: number;
  ended?: number;
  failed?: string;
}
interface Capture {
  entries: Map<string, Entry>;
  startedAt: number;
}
const captures = new Map<number, Capture>();

export function watchCaptures() {
  platform.onEvent?.((tabId, method, p) => {
    const c = captures.get(tabId);
    if (!c) return;
    if (method === 'Network.requestWillBeSent') {
      if (c.entries.size >= MAX_ENTRIES) return;
      c.entries.set(p.requestId, { started: p.timestamp, wall: (p.wallTime ?? Date.now() / 1000) * 1000, method: p.request?.method ?? '', url: p.request?.url ?? '', headers: p.request?.headers ?? {}, postData: p.request?.postData, mime: p.request?.headers?.['Content-Type'] });
    }
    const e = c.entries.get(p.requestId);
    if (!e) return;
    if (method === 'Network.responseReceived') Object.assign(e, { status: p.response?.status, statusText: p.response?.statusText, respHeaders: p.response?.headers });
    if (method === 'Network.loadingFinished') Object.assign(e, { ended: p.timestamp, size: p.encodedDataLength });
    if (method === 'Network.loadingFailed') Object.assign(e, { ended: p.timestamp, failed: p.errorText ?? 'failed' });
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    stopFlight(tabId);
    captures.delete(tabId);
    const rec = recordings.get(tabId);
    if (rec) void stopRecording(tabId).catch(() => {});
  });
  // A new document starts with its overlay showing.
  browser.tabs.onUpdated.addListener((tabId, info) => {
    const rec = recordings.get(tabId);
    if (rec && !rec.cursor && info.status === 'complete') void veil(tabId, true);
  });
}

export async function startNetwork(tabId: number) {
  needDebugger();
  if (captures.has(tabId)) throw new Error('This tab is already being captured. Stop it first.');
  await platform.cdp!(tabId, (send) => send('Network.enable'));
  captures.set(tabId, { entries: new Map(), startedAt: Date.now() });
  return { capturing: true };
}

export const networkStatus = (tabId: number) => {
  const c = captures.get(tabId);
  return c ? { capturing: true, requests: c.entries.size, seconds: Math.round((Date.now() - c.startedAt) / 1000) } : { capturing: false };
};

const clean = (t: string) => hideLooksSecret(scrubText(t)).text;
const headerList = (h: Record<string, string> | undefined) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: HIDDEN_HEADERS.test(name) ? '[hidden]' : clean(String(value)) }));
/** The address without its query values, unless they are plainly harmless: a token is often there. */
const queryOf = (url: string) => {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value: clean(`${name}=${value}`).slice(name.length + 1) }));
  } catch {
    return [];
  }
};
const urlWithout = (url: string) => {
  try {
    const u = new URL(url);
    return `${scrubUrl(`${u.origin}${u.pathname}`)}${u.search ? `?${queryOf(url).map((q) => `${encodeURIComponent(q.name)}=${encodeURIComponent(q.value)}`).join('&')}` : ''}`;
  } catch {
    return '[an address that could not be read]';
  }
};

/** Written as HAR 1.2. Response bodies are left out: they are the likeliest place for what should not be here. */
function toHar(c: Capture) {
  const entries = [...c.entries.values()].map((e) => ({
    startedDateTime: new Date(e.wall).toISOString(),
    time: e.ended ? Math.round((e.ended - e.started) * 1000) : 0,
    request: {
      method: e.method,
      url: urlWithout(e.url),
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headerList(e.headers),
      queryString: queryOf(e.url),
      headersSize: -1,
      bodySize: e.postData?.length ?? 0,
      ...(e.postData ? { postData: { mimeType: e.mime ?? '', text: clean(e.postData) } } : {}),
    },
    response: {
      status: e.status ?? 0,
      statusText: e.failed ?? e.statusText ?? '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: headerList(e.respHeaders),
      content: { size: e.size ?? 0, mimeType: e.respHeaders?.['content-type'] ?? e.respHeaders?.['Content-Type'] ?? '' },
      redirectURL: '',
      headersSize: -1,
      bodySize: e.size ?? -1,
    },
    cache: {},
    timings: { send: 0, wait: e.ended ? Math.round((e.ended - e.started) * 1000) : 0, receive: 0 },
  }));
  return { log: { version: '1.2', creator: { name: 'Agentic Routines', version: browser.runtime.getManifest().version }, entries } };
}

export async function stopNetwork(tabId: number, cancel = false) {
  const c = captures.get(tabId);
  if (!c) throw new Error('This tab is not being captured.');
  captures.delete(tabId);
  if (cancel) return { cancelled: true };
  const out = await write(`network-${stamp()}-${crypto.randomUUID().slice(0, 8)}.har`, JSON.stringify(toHar(c), null, 1), false);
  return { ...out, requests: c.entries.size };
}
