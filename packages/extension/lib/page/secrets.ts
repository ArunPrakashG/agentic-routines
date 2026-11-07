import * as native from '../agent/native';
import { ask, frameOf } from './tabs';

// A secret the person stored for one site. The host hands it over only for that site, and the site is what the browser
// says this frame is on, read just before the value goes in. Once used, it is scrubbed out of anything sent back.

const spent = new Map<string, string>();
const inTab = new Map<number, string>();

/** Fetch the value for this field, or refuse. The field is masked first, so nothing that looks at the page afterwards can read it. */
export async function secretForField(tabId: number, ref: string, name: string, session?: string): Promise<string> {
  const frame = await browser.webNavigation.getFrame({ tabId, frameId: frameOf(ref) });
  let origin = 'null';
  try {
    origin = new URL(frame?.url ?? '').origin;
  } catch {
    // Reads as no origin, which no secret is kept for.
  }
  const value = await native.call<string>('host.secret', { name, origin }, { session });
  // The page may have moved on since the frame was read. The page itself is asked, last thing.
  await ask(tabId, { t: 'secretField', ref, origin });
  if (value.length >= 4) spent.set(value, name);
  inTab.set(tabId, name);
  return value;
}

/** A password an agent typed by hand: not stored, and left out of whatever comes back all the same. */
export function noteTyped(value: string) {
  if (value.length >= 4) spent.set(value, 'typed_password');
}

/** A script could read what was typed, whatever is done to its result. */
export function refuseScript(tabId: number) {
  const name = inTab.get(tabId);
  if (name) throw new Error(`The secret ${name} was typed into this tab, so no script may run here until it goes to a new page.`);
}

/** Each page starts clean. */
export function watchSecrets() {
  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') inTab.delete(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => void inTab.delete(tabId));
}

/** The value, wherever it turned up: a page that echoes it, a request it was sent in, a log line. */
export function scrubText(t: string): string {
  for (const [v, name] of spent) if (t.includes(v)) t = t.split(v).join(`{{secret:${name}}}`);
  return t;
}

export function scrub<T>(result: T): T {
  if (!spent.size || result === undefined || result === null) return result;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(result) as T;
}
