import type { RecordedEvent, Run } from '@browser-routines/core';

// Every agent run is recorded. A new run starts after 10 idle minutes,
// after a save, or when the agent changes.

const KEEP = 20;
const IDLE_MS = 10 * 60_000;

export interface StoredRun extends Run {
  updatedAt: number;
  saved?: boolean;
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

export async function record(source: string, event: RecordedEvent, forceNew = false): Promise<StoredRun> {
  const runs = await load();
  let cur = runs.find((r) => r.source === source && !r.saved);
  if (!cur || forceNew || Date.now() - cur.updatedAt > IDLE_MS) {
    cur = { id: newId(), source, startedAt: Date.now(), updatedAt: Date.now(), events: [] };
    runs.unshift(cur);
    if (runs.length > KEEP) runs.length = KEEP;
  }
  cur.events.push(event);
  cur.updatedAt = Date.now();
  await persist();
  return cur;
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

export async function get(id?: string): Promise<StoredRun> {
  const runs = await load();
  const r = id ? runs.find((x) => x.id === id) : runs.find((x) => !x.saved && x.events.length);
  if (!r) throw new Error(id ? `No run ${id}` : 'No recorded run. Do the task with the browser tools first.');
  return r;
}

export async function list(): Promise<StoredRun[]> {
  return load();
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
