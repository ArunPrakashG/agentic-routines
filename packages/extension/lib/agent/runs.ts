import { findRepeat, type RecordedEvent, type Repeat, type Run } from '@agentic-routines/core';

// Every agent run is recorded. A new run starts after 10 idle minutes,
// after a save, when the agent changes, or when a new agent session starts.

const KEEP = 20;
const IDLE_MS = 10 * 60_000;

export interface StoredRun extends Run {
  updatedAt: number;
  saved?: boolean;
  /** One MCP server process, so two sessions of the same agent stay apart. */
  session?: string;
}

let cache: StoredRun[] | undefined;
const listeners = new Set<() => void>();

export function onRunsChanged(fn: () => void) {
  listeners.add(fn);
}

async function load(): Promise<StoredRun[]> {
  if (!cache) cache = ((await browser.storage.local.get('runs')).runs as StoredRun[] | undefined) ?? [];
  return cache;
}

async function persist() {
  await browser.storage.local.set({ runs: cache });
  for (const fn of listeners) fn();
}

const newId = () => 'run-' + crypto.randomUUID().slice(0, 4);

async function going(source: string, session?: string): Promise<StoredRun> {
  const runs = await load();
  let cur = runs.find((r) => r.source === source && !r.saved);
  if (!cur || cur.session !== session || Date.now() - cur.updatedAt > IDLE_MS) {
    cur = { id: newId(), source, session, startedAt: Date.now(), updatedAt: Date.now(), events: [] };
    runs.unshift(cur);
    if (runs.length > KEEP) runs.length = KEEP;
  }
  return cur;
}

export async function record(source: string, event: RecordedEvent, session?: string): Promise<StoredRun> {
  const cur = await going(source, session);
  cur.events.push(event);
  cur.updatedAt = Date.now();
  await persist();
  return cur;
}

/** What went through execute. It stays with the run, and is not a step of it. */
export async function noteOutside(source: string, did: string[], url: string | undefined, session?: string) {
  const cur = await going(source, session);
  (cur.outside ??= []).push({ ts: Date.now(), url, did });
  cur.updatedAt = Date.now();
  await persist();
}

/** Mark the last event of the current run as having caused a navigation. */
export async function markNavigated(source: string, url: string) {
  const runs = await load();
  const cur = runs.find((r) => r.source === source && !r.saved);
  const last = cur?.events[cur.events.length - 1];
  if (last && last.action !== 'navigate' && last.url !== url) {
    last.navigatedTo = url;
    await persist();
  }
}

export async function get(id?: string, session?: string): Promise<StoredRun> {
  const runs = await load();
  const r = id ? runs.find((x) => x.id === id) : runs.find((x) => !x.saved && x.events.length && (!session || x.session === session));
  if (!r && !id && runs.some((x) => !x.saved && x.outside?.length && (!session || x.session === session))) throw new Error('Everything in this run went through execute, which cannot become a routine. Do the task with the step tools to keep it.');
  if (!r) throw new Error(id ? `No run ${id}` : 'No recorded run. Do the task with the browser tools first.');
  return r;
}

/** The session's own run against everything recorded on this machine. */
export async function repeat(session?: string): Promise<Repeat | null> {
  const runs = await load();
  const cur = runs.find((x) => !x.saved && x.events.length && (!session || x.session === session));
  return cur ? findRepeat(cur, runs.filter((x) => x !== cur)) : null;
}

export async function list(): Promise<StoredRun[]> {
  return (await load()).filter((r) => r.events.length);
}

export async function markSaved(id: string) {
  const runs = await load();
  const r = runs.find((x) => x.id === id);
  if (r) {
    r.saved = true;
    await persist();
  }
}

export async function discard(id: string) {
  const runs = await load();
  cache = runs.filter((r) => r.id !== id);
  await persist();
}

/** Start a fresh run for a human demo. */
export async function startHuman(): Promise<string> {
  const runs = await load();
  const r: StoredRun = { id: newId(), source: 'You', startedAt: Date.now(), updatedAt: Date.now(), events: [] };
  runs.unshift(r);
  await persist();
  return r.id;
}
