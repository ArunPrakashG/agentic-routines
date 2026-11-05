import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { blockedBy, checkFetched, githubSource, ownerFor, parseRoutineFile, repoKey, FILE_PATH, type BlockList, type Fetched, type Origin, type Routine, type Source, type SourceEntry } from '@agentic-routines/core';
import { paths } from './paths.ts';
import * as store from './store.ts';

// Sources the person added, the block list we fetch, and installing from either.
// Nothing here installs on its own: install() runs only when the person clicked Install.

const API = process.env.AGENTIC_ROUTINES_API ?? 'https://agenticroutines.arunprakashg.com';
const DAY = 24 * 60 * 60_000;
const MAX_SOURCES = 20;

export interface SourceConfig {
  id: string;
  kind: 'github' | 'folder';
  enabled: boolean;
}
interface Config {
  directory: boolean;
  sources: SourceConfig[];
}
export interface SourceInfo extends SourceConfig {
  routines?: number;
  checkedAt?: number;
  error?: string;
}

const file = (n: string) => join(paths.root(), n);

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file(name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(name: string, v: unknown) {
  await mkdir(paths.root(), { recursive: true, mode: 0o700 });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file(name));
}

const config = () => readJson<Config>('sources.json', { directory: true, sources: [] });

// ---------- folder source ----------

function folderSource(path: string): Source {
  return {
    kind: 'folder',
    id: path,
    async list() {
      const entries: SourceEntry[] = [];
      let skipped = 0;
      let names: string[] = [];
      try {
        names = (await readdir(join(path, 'routines'))).filter((n) => FILE_PATH.test(`routines/${n}`));
      } catch {
        throw new Error('That folder has no routines folder in it.');
      }
      for (const n of names.slice(0, 50)) {
        try {
          const { meta } = parseRoutineFile(await readFile(join(path, 'routines', n), 'utf8'));
          if (`${meta.name}.md` !== n) throw new Error('name');
          entries.push({ path: `routines/${n}`, name: meta.name, site: meta.site, description: meta.description, version: meta.version });
        } catch {
          skipped++;
        }
      }
      return { entries, skipped };
    },
    async fetch(p) {
      if (!FILE_PATH.test(p)) throw new Error('Not a routine file.');
      const routine = parseRoutineFile(await readFile(join(path, p), 'utf8'));
      if (`routines/${routine.meta.name}.md` !== p) throw new Error('The routine’s name does not match its file.');
      return { routine, path: p };
    },
  };
}

function open(s: SourceConfig): Source {
  if (s.kind === 'folder') return folderSource(s.id);
  const api = process.env.AGENTIC_ROUTINES_GITHUB_API;
  const raw = process.env.AGENTIC_ROUTINES_GITHUB_RAW;
  return githubSource(s.id, fetch, api && raw ? { api, raw } : undefined);
}

// ---------- the list of sources ----------

const listings = new Map<string, { at: number; entries: SourceEntry[]; skipped: number; ref?: string; error?: string }>();

async function listing(s: SourceConfig, fresh = false) {
  const hit = listings.get(s.id);
  if (hit && !fresh && Date.now() - hit.at < 10 * 60_000) return hit;
  let next: NonNullable<typeof hit>;
  try {
    next = { at: Date.now(), ...(await open(s).list()) };
  } catch (e) {
    next = { at: Date.now(), entries: [], skipped: 0, error: (e as Error).message };
  }
  listings.set(s.id, next);
  return next;
}

export async function list(): Promise<{ directory: boolean; sources: SourceInfo[] }> {
  const c = await config();
  const sources = await Promise.all(
    c.sources.map(async (s): Promise<SourceInfo> => {
      if (!s.enabled) return { ...s, routines: listings.get(s.id)?.entries.length };
      const l = await listing(s);
      return { ...s, routines: l.entries.length, checkedAt: l.at, error: l.error };
    }),
  );
  return { directory: c.directory, sources };
}

export async function add(address: string): Promise<SourceConfig> {
  const c = await config();
  if (c.sources.length >= MAX_SOURCES) throw new Error('That is enough sources. Remove one first.');
  const a = address.trim();
  let id: string | null;
  let kind: SourceConfig['kind'];
  if (/^(~|\/|[a-z]:[\\/])/i.test(a) || isAbsolute(a)) {
    kind = 'folder';
    id = resolve(a.replace(/^~(?=$|[\\/])/, homedir()));
    if (!(await stat(id).then((s) => s.isDirectory(), () => false))) throw new Error('That folder does not exist.');
  } else {
    kind = 'github';
    id = repoKey(a);
    if (!id) throw new Error('Use a GitHub address like github.com/owner/repository. Other hosts are not supported yet.');
  }
  if (c.sources.some((s) => s.id === id)) throw new Error('That source is already added.');
  const blocked = kind === 'github' && (await blockList()).repos.includes(id);
  if (blocked) throw new Error('That repository has been blocked.');
  const s: SourceConfig = { id, kind, enabled: true };
  // Looked at before it is kept: a wrong address or an empty repository says so now.
  const l = await listing(s, true);
  if (l.error) throw new Error(l.error);
  if (!l.entries.length) throw new Error('There are no routines in it. Routines are .md files in a routines folder.');
  await writeJson('sources.json', { ...c, sources: [...c.sources, s] });
  return s;
}

export async function remove(id: string): Promise<void> {
  const c = await config();
  await writeJson('sources.json', { ...c, sources: c.sources.filter((s) => s.id !== id) });
  listings.delete(id);
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const c = await config();
  if (id === 'directory') return void (await writeJson('sources.json', { ...c, directory: enabled }));
  if (!c.sources.some((s) => s.id === id)) throw new Error('No such source.');
  await writeJson('sources.json', { ...c, sources: c.sources.map((s) => (s.id === id ? { ...s, enabled } : s)) });
}

/** What the enabled sources have, for search and the panel. */
export async function entries(id?: string, fresh = false): Promise<{ source: string; kind: SourceConfig['kind']; entries: SourceEntry[]; skipped: number; error?: string }[]> {
  const c = await config();
  const on = c.sources.filter((s) => s.enabled && (!id || s.id === id));
  return Promise.all(on.map(async (s) => ({ source: s.id, kind: s.kind, ...(await listing(s, fresh)) })));
}

export async function directoryOn(): Promise<boolean> {
  return (await config()).directory;
}

// ---------- the block list ----------

interface Cached {
  at: number;
  list: BlockList;
}

/** The list as last fetched. Fetched again when it is more than a day old; the old one stands if we are offline. */
export async function blockList(): Promise<BlockList> {
  const cached = await readJson<Cached | null>('blocklist.json', null);
  if (cached && Date.now() - cached.at < DAY) return cached.list;
  try {
    const res = await fetch(`${API}/api/v1/blocklist`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    const j = (await res.json()) as Partial<BlockList>;
    const list: BlockList = { users: j.users ?? [], repos: j.repos ?? [], routines: j.routines ?? [] };
    await writeJson('blocklist.json', { at: Date.now(), list });
    return list;
  } catch {
    return cached?.list ?? { users: [], repos: [], routines: [] };
  }
}

/** Turns off what is installed from a source that is now blocked. Returns what it turned off. */
export async function applyBlocks(): Promise<string[]> {
  const list = await blockList();
  const off: string[] = [];
  for (const r of await store.list()) {
    if (!r.origin) continue;
    const why = blockedBy(list, r.origin, `${r.owner}/${r.name}`);
    if (why && (r.enabled || !r.blocked)) {
      await store.block(r.owner, r.name, why);
      off.push(`${r.owner}/${r.name}`);
    }
  }
  return off;
}

/** Turning a routine on is the person's call, unless a block still stands. */
export async function enable(id: string, enabled: boolean): Promise<void> {
  if (enabled) {
    const [owner, name] = await store.locate(id);
    const r = (await store.list()).find((x) => x.owner === owner && x.name === name);
    if (r?.origin) {
      const why = blockedBy(await blockList(), r.origin, `${owner}/${name}`);
      if (why) throw new Error(`It stays off. ${why}`);
    }
  }
  await store.setEnabled(id, enabled);
}

// ---------- installing ----------

export interface Preview {
  source: string;
  kind: SourceConfig['kind'];
  path: string;
  ref?: string;
  routine: Routine;
  /** Reasons it cannot be installed. Empty when it can. */
  problems: string[];
  /** Set when it is already installed, so the card can say what it replaces. */
  installed?: { version: number };
}

async function sourceOf(id: string): Promise<SourceConfig> {
  const s = (await config()).sources.find((x) => x.id === id);
  if (!s) throw new Error('That source is not in your list.');
  if (!s.enabled) throw new Error('That source is turned off.');
  return s;
}

function originOf(s: SourceConfig, f: Fetched): Origin {
  return { kind: s.kind, source: s.id, path: f.path, ref: f.ref };
}

/** Fetches one routine pinned to a commit and runs every check on it. Writes nothing. */
export async function preview(id: string, path: string, ref?: string): Promise<Preview> {
  const s = await sourceOf(id);
  const f = await open(s).fetch(path, ref);
  const origin = originOf(s, f);
  const problems = checkFetched(f.routine);
  const why = blockedBy(await blockList(), origin, `${ownerFor(origin)}/${f.routine.meta.name}`);
  if (why) problems.unshift(why);
  const have = (await store.list()).find((r) => r.owner === ownerFor(origin) && r.name === f.routine.meta.name);
  return { source: id, kind: s.kind, path, ref: f.ref, routine: f.routine, problems, installed: have ? { version: have.version } : undefined };
}

/**
 * Saves it. Re-fetches at the commit the person was shown and checks again, so what is installed is what
 * was read. Called only after the person clicked Install.
 */
export async function install(id: string, path: string, ref?: string): Promise<Routine> {
  const p = await preview(id, path, ref);
  if (p.problems.length) throw new Error(`Not installed. ${p.problems.join(' ')}`);
  const s = await sourceOf(id);
  const origin: Origin = { kind: s.kind, source: s.id, path, ref: p.ref };
  return store.write({ ...p.routine, meta: { ...p.routine.meta, owner: undefined } }, ownerFor(origin), origin);
}

/** Looks up a source by what a person types: owner/repo, a GitHub address or a folder. */
export async function find(text: string): Promise<SourceConfig | undefined> {
  const c = await config();
  const key = repoKey(text) ?? resolve(text);
  return c.sources.find((s) => s.id === key);
}
