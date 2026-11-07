import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveUrls, hookHash, parseRoutineMd, stringifyRoutineMd, type ByHand, type Origin, type Routine, type Step } from '@agentic-routines/core';
import type { Surface } from '@agentic-routines/core';
import { paths } from '../paths.ts';

// Routines live at ~/.agentic-routines/routines/<owner>/<name>/{ROUTINE.md,steps.json}.
// "local" is the owner until the user signs in and picks a handle.

export const LOCAL = 'local';

export interface Listed {
  name: string;
  owner: string;
  version: number;
  site: string;
  description: string;
  enabled: boolean;
  draftedBy?: string;
  /** Set when it came from somewhere other than the person's own recordings. */
  origin?: Origin;
  /** Why it was turned off by a block, when it was. */
  blocked?: string;
  /** Its hooks: how many events have code, and the hash approval is pinned to. */
  hooks?: { count: number; hash: string };
  /** The pages it applies to: the ones it declares, else worked out from its steps. */
  urls: string[];
  /** Where it acts. Only the browser is implemented. */
  surface: Surface;
  /** How the agent's runs of it have gone on this machine. */
  stats?: Stats;
}

/** Efficiency of a routine as the agent has run it. Kept in the routine's folder, never sent anywhere. */
export interface Stats {
  runs: number;
  /** The last STATS_KEPT finished runs, newest last. */
  recent: RunStat[];
  last?: { at: number; ok: boolean };
  /** When the routine was last deliberately refined. Runs before it say nothing about the routine as it is now. */
  refined?: number;
  /** The run it was recorded from, to compare replays with. Stays on this computer. */
  byHand?: ByHand;
}

export interface RunStat {
  ok: boolean;
  calls: number;
  ms: number;
  at: number;
  /** Steps whose element had to be chosen again. */
  fixed?: number[];
  /** The slowest steps, when any took long. */
  slow?: { n: number; ms: number }[];
  /** All the steps ran and the page did not show what the routine expects. */
  unconfirmed?: boolean;
  steps?: number;
  agent?: string;
}

const STATS_KEPT = 200;
const STATS_WINDOW = 20;
/** Runs in a row that were not clean before a routine is marked stale. */
export const STALE_AFTER = 3;
export const SLOW_STEP_MS = 5000;

export interface StatsView {
  runs: number;
  /** Its last STALE_AFTER runs since it was refined all failed or needed a fix. */
  stale: boolean;
  /** A step that was slow in each of those runs. */
  slowStep?: { n: number; ms: number };
  /** Over the recent runs, 0 to 1. */
  success: number;
  /** Model calls per run over the recent runs. */
  calls: number;
  medianMs: number;
  last?: { at: number; ok: boolean };
}

export function viewStats(s?: Stats): StatsView | undefined {
  if (!s?.recent.length) return undefined;
  const r = s.recent.slice(-STATS_WINDOW);
  const tail = r.filter((x) => x.at > (s.refined ?? 0)).slice(-STALE_AFTER);
  const full = tail.length === STALE_AFTER;
  const slowStep = full ? tail[0].slow?.filter((a) => tail.every((x) => x.slow?.some((b) => b.n === a.n))).sort((a, b) => b.ms - a.ms)[0] : undefined;
  const ms = r.map((x) => x.ms).sort((a, b) => a - b);
  const mid = Math.floor(ms.length / 2);
  return {
    runs: s.runs,
    stale: full && tail.every((x) => !x.ok || x.calls > 0 || !!x.fixed?.length),
    ...(slowStep ? { slowStep } : {}),
    success: r.filter((x) => x.ok).length / r.length,
    calls: r.reduce((n, x) => n + x.calls, 0) / r.length,
    medianMs: ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2,
    last: s.last,
  };
}

/** Higher is better: finishes reliably and needs the model rarely. A routine never run has no say either way. */
export function efficiency(v?: StatsView): number {
  return v ? v.success - 0.15 * Math.min(v.calls, 4) - (v.stale ? 0.3 : 0) : 0.4;
}

/** Count one finished run of a routine. Paused runs are not counted until they end. */
export async function recordRun(id: string, r: Omit<RunStat, 'at'>): Promise<void> {
  const [owner, name] = await locate(id);
  const f = join(dir(owner, name), '.stats.json');
  const s = (await readJson<Stats>(f)) ?? { runs: 0, recent: [] };
  const at = Date.now();
  s.runs += 1;
  s.recent = [...s.recent, { ...r, at }].slice(-STATS_KEPT);
  s.last = { at, ok: r.ok };
  await atomicWrite(f, JSON.stringify(s) + '\n');
}

/** What a save means for the record. A deliberate new version: what went wrong before it no longer counts against it. */
export async function noteSaved(id: string, o: { version: number; byHand?: ByHand }): Promise<void> {
  const [owner, name] = await locate(id);
  const f = join(dir(owner, name), '.stats.json');
  const s = (await readJson<Stats>(f)) ?? { runs: 0, recent: [] };
  await atomicWrite(f, JSON.stringify({ ...s, ...(o.version > 1 ? { refined: Date.now() } : {}), ...(o.byHand ? { byHand: o.byHand } : {}) }) + '\n');
}

export async function statsOf(id: string): Promise<Stats | undefined> {
  const [owner, name] = await locate(id);
  return readJson<Stats>(join(dir(owner, name), '.stats.json'));
}

function dir(owner: string, name: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(owner) || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`Bad routine id ${owner}/${name}`);
  return join(paths.routines(), owner, name);
}

/** "play-release" or "arunprakashg/play-release" -> [owner, name]. A bare name searches all owners. */
export async function locate(id: string): Promise<[string, string]> {
  const [a, b] = id.split('/');
  if (b) return [a, b];
  const all = await list();
  const hit = all.find((r) => r.name === a && r.owner === LOCAL) ?? all.find((r) => r.name === a);
  if (!hit) throw new Error(`No routine named ${a}`);
  return [hit.owner, hit.name];
}

export async function list(): Promise<Listed[]> {
  const out: Listed[] = [];
  let owners: string[] = [];
  try {
    owners = await readdir(paths.routines());
  } catch {
    return out;
  }
  for (const owner of owners) {
    let names: string[] = [];
    try {
      names = await readdir(join(paths.routines(), owner));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const md = await readFile(join(paths.routines(), owner, name, 'ROUTINE.md'), 'utf8');
        const { meta } = parseRoutineMd(md);
        const urls = meta.urls ?? deriveUrls(await readJson<Step[]>(join(paths.routines(), owner, name, 'steps.json')) ?? [], meta.site);
        const stats = await readJson<Stats>(join(paths.routines(), owner, name, '.stats.json'));
        const disabled = await readFile(join(paths.routines(), owner, name, '.disabled'), 'utf8').then(() => true, () => false);
        const origin = await readJson<Origin>(join(paths.routines(), owner, name, '.origin.json'));
        const blocked = (await readJson<{ reason: string }>(join(paths.routines(), owner, name, '.blocked.json')))?.reason;
        const n = Object.keys(meta.hooks ?? {}).length;
        out.push({ name, owner, version: meta.version, site: meta.site, description: meta.description, enabled: !disabled, draftedBy: meta.drafted_by, origin, blocked, hooks: n ? { count: n, hash: await hookHash(meta.hooks) } : undefined, urls, surface: meta.surface ?? 'browser', stats });
      } catch {
        // Not a routine folder.
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export async function read(id: string): Promise<Routine & { owner: string }> {
  const [owner, name] = await locate(id);
  const d = dir(owner, name);
  const { meta, body } = parseRoutineMd(await readFile(join(d, 'ROUTINE.md'), 'utf8'));
  const steps = JSON.parse(await readFile(join(d, 'steps.json'), 'utf8')) as Step[];
  return { meta, body, steps, owner };
}

async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
}

/** Save a routine. Versions only go up: saving over an existing one bumps it. */
export async function write(r: Routine, owner = r.meta.owner ?? LOCAL, origin?: Origin): Promise<Routine> {
  const d = dir(owner, r.meta.name);
  await mkdir(d, { recursive: true, mode: 0o700 });
  let version = r.meta.version;
  try {
    const { meta } = parseRoutineMd(await readFile(join(d, 'ROUTINE.md'), 'utf8'));
    version = Math.max(version, meta.version + 1);
  } catch {
    // New routine.
  }
  const saved: Routine = { ...r, meta: { ...r.meta, owner: owner === LOCAL ? undefined : owner, version } };
  await atomicWrite(join(d, 'steps.json'), JSON.stringify(saved.steps, null, 2) + '\n');
  await atomicWrite(join(d, 'ROUTINE.md'), stringifyRoutineMd(saved.meta, saved.body));
  if (origin) await atomicWrite(join(d, '.origin.json'), JSON.stringify(origin) + '\n');
  // A new copy is the person's call again, so an earlier block note goes.
  await rm(join(d, '.blocked.json'), { force: true });
  return saved;
}

export async function remove(id: string): Promise<void> {
  const [owner, name] = await locate(id);
  await rm(dir(owner, name), { recursive: true, force: true });
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const [owner, name] = await locate(id);
  const f = join(dir(owner, name), '.disabled');
  if (enabled) {
    await rm(f, { force: true });
    await rm(join(dir(owner, name), '.blocked.json'), { force: true });
  } else await writeFile(f, '');
}

/** Turns a routine off because of a block, and says why. Turning it on again by hand is the person's call. */
export async function block(owner: string, name: string, reason: string): Promise<void> {
  const d = dir(owner, name);
  await writeFile(join(d, '.disabled'), '');
  await atomicWrite(join(d, '.blocked.json'), JSON.stringify({ reason, at: new Date().toISOString() }) + '\n');
}
