import { blockProblems } from './blocks.ts';
import { CONFIG_FILE, ConfigError, MAX_CONFIG, formatProblem, isRepoPath, parseConfigRoutine, siteListed, type RepoConfig, type RepoRoutine } from './config-routine.ts';
import { lintForPublish, parseRoutineMd, stringifyRoutineMd } from './routine-md.ts';
import type { Action, Pointer, Routine, Spot, Step } from './types.ts';
import { checkUrls, deriveUrls } from './urls.ts';

// Where routines come from besides the person's own recordings. A source has one job: list what it
// has and fetch one routine. The directory is reviewed by us; every other source is not.

/** Where an installed routine came from. Kept next to it, so a block can find it later. */
export interface Origin {
  kind: 'directory' | 'github' | 'folder';
  /** directory: the publisher's handle. github: https://github.com/owner/repo. folder: the folder path. */
  source: string;
  path?: string;
  /** The commit it was fetched at. */
  ref?: string;
}

export interface SourceEntry {
  /** Path inside the source, e.g. routines/deploy-staging.md. */
  path: string;
  name: string;
  site: string;
  description: string;
  version: number;
  /** From config.routine: the author's notes for the agent, the hosts it is for, how many hooks it brings. */
  instructions?: string;
  sites?: string[];
  /** The pages it applies to: config.routine's, else the routine file's, else worked out from its steps. */
  urls?: string[];
  hooks?: number;
}

/** What a repository says about itself in config.routine. */
export interface RepoInfo {
  name: string;
  description: string;
  instructions?: string;
}

export interface Fetched {
  routine: Routine;
  ref?: string;
  path: string;
  /** Set when the repository has a config.routine that lists this file. */
  repo?: RepoInfo;
  entry?: RepoRoutine;
}

export interface Listing {
  entries: SourceEntry[];
  /** Files that look like routines but could not be read. `problems` says why, where it can. */
  skipped: number;
  ref?: string;
  repo?: RepoInfo;
  /** What is wrong with config.routine or with a file it lists, each with file, line and field where known. */
  problems?: string[];
}

export interface Source {
  kind: 'github' | 'folder';
  /** The stable address: https://github.com/owner/repo, or a folder path. */
  id: string;
  list(): Promise<Listing>;
  fetch(path: string, ref?: string): Promise<Fetched>;
}

// ---------- the routine file ----------

const MAX_FILE = 256 * 1024;
const MAX_STEPS = 200;
const ACTIONS: Action[] = ['each', 'if', 'navigate', 'click', 'type', 'clear', 'select', 'upload', 'press', 'wait', 'read', 'hover', 'drag', 'scroll', 'set', 'dialog', 'handoff'];
const STEPS_BLOCK = /\n```steps\r?\n([\s\S]*?)\r?\n```\s*$/;
export const FILE_PATH = /^routines\/[a-z0-9][a-z0-9-]{1,62}\.md$/;
/** A routine on its own in the root of a repository. */
export const SINGLE_PATH = 'ROUTINE.md';

/** One plain file: the notes as in ROUTINE.md, then the steps in a fenced block at the end. */
export function stringifyRoutineFile(r: Routine): string {
  const steps = r.steps.map((s) => '  ' + JSON.stringify(s)).join(',\n');
  return `${stringifyRoutineMd(r.meta, r.body)}\n\`\`\`steps\n[\n${steps}\n]\n\`\`\`\n`;
}

export function parseRoutineFile(text: string): Routine {
  if (text.length > MAX_FILE) throw new Error('The file is too large.');
  const m = STEPS_BLOCK.exec(text);
  if (!m) throw new Error('The file has no steps block.');
  const { meta, body } = parseRoutineMd(text.slice(0, m.index));
  let steps: unknown;
  try {
    steps = JSON.parse(m[1]);
  } catch {
    throw new Error('The steps are not valid JSON.');
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) throw new Error('The steps are not a list of 1 to 200.');
  for (const s of steps) {
    if (!s || typeof s !== 'object' || typeof (s as Step).n !== 'number' || typeof (s as Step).label !== 'string') throw new Error('A step is malformed.');
  }
  return { meta: { ...meta, owner: undefined }, body, steps: steps as Step[] };
}

// ---------- what is checked before anything is installed ----------

const SECRET_SHAPE = /(sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-z0-9-]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY|[a-f0-9]{40,})/i;

/** The same rules as for publishing, and more: nothing fetched from elsewhere runs unless it passes. */
export function checkFetched(r: Routine): string[] {
  const out: string[] = [];
  const urls: string[] = [];
  for (const s of r.steps) {
    if (!ACTIONS.includes(s.action)) out.push(`Step ${s.n} has an action this app does not know: ${String(s.action).slice(0, 20)}.`);
    for (const u of [s.url, s.page?.url]) if (u) urls.push(u);
    if (s.value && SECRET_SHAPE.test(s.value)) out.push(`Step ${s.n} contains what looks like a secret.`);
    if (s.url && !/^https:\/\//i.test(s.url)) out.push(`Step ${s.n} opens an address that is not https.`);
    if (s.pointer && !sanePointer(s.pointer)) out.push(`Step ${s.n} has a pointer this app does not understand.`);
  }
  for (const i of lintForPublish(r.meta, urls)) out.push(i.message);
  out.push(...checkPlaceholders(r));
  out.push(...blockProblems(r.steps, r.meta.params ?? {}));
  for (const p of r.meta.pauses) if (!Number.isInteger(p) || p < 1 || p > r.steps.length) out.push('A pause points at a step that is not there.');
  return [...new Set(out)].slice(0, 8);
}

const saneSpot = (p?: Spot) => !p || (p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);

/** Values a routine from elsewhere gives the mouse: places on the element, the usual buttons, nothing else. */
function sanePointer(p: Pointer): boolean {
  if (!saneSpot(p.spot) || !saneSpot(p.to?.spot)) return false;
  if (p.button && !['left', 'right', 'middle'].includes(p.button)) return false;
  if (p.count !== undefined && ![1, 2, 3].includes(p.count)) return false;
  if (p.mods !== undefined && !/^(ctrl|shift|alt|cmd)(\+(ctrl|shift|alt|cmd))*$/.test(p.mods)) return false;
  if (p.by && !(Math.abs(p.by.x) <= 100_000 && Math.abs(p.by.y) <= 100_000)) return false;
  return true;
}

const PLACEHOLDER = /\{\{(secret:)?([a-z0-9_]+)\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{([a-z0-9_]+)\}\}$/;

/**
 * Every {{name}} must be something the routine declares, and an upload takes its file from a file param, so the
 * path always comes from the person who runs it and never from the routine.
 */
function checkPlaceholders(r: Routine): string[] {
  const out: string[] = [];
  const params = r.meta.params ?? {};
  const secrets = r.meta.secrets ?? [];
  for (const s of r.steps) {
    if (s.action === 'upload') {
      const name = WHOLE_PLACEHOLDER.exec(s.value ?? '')?.[1];
      if (!name || params[name]?.type !== 'file') out.push(`Step ${s.n} uploads a file the routine picks. An upload has to take its file from a file the person gives.`);
    }
    if (s.url?.includes('{{secret:')) out.push(`Step ${s.n} puts a secret in an address.`);
    if (s.when?.text?.includes('{{secret:')) out.push(`Step ${s.n} looks for a secret on the page.`);
    for (const text of [s.url, s.value, s.when?.text]) {
      for (const m of (text ?? '').matchAll(PLACEHOLDER)) {
        if (m[1] ? !secrets.includes(m[2]) : !params[m[2]] || (params[m[2]].type === 'file' && s.action !== 'upload')) out.push(`Step ${s.n} uses {{${m[1] ?? ''}${m[2]}}}, which the routine does not declare for that.`);
      }
    }
  }
  return out;
}

// ---------- a repository: config.routine, or the plain layout ----------

/** How a source lets the repository layer look at files. */
export interface RepoIO {
  /** A file by its path in the repository, or null when it is not there. */
  read(path: string): Promise<string | null>;
  /** The files that count as routines when there is no config.routine: routines/*.md and a ROUTINE.md in the root. */
  fallback(): Promise<string[]>;
}

const repoInfo = (c: RepoConfig): RepoInfo => ({ name: c.name, description: c.description, ...(c.instructions ? { instructions: c.instructions } : {}) });
const problemAt = (i: number, r: RepoRoutine, what: string) => `${CONFIG_FILE}:${r.line} routines[${i}] (${r.path}): ${what}`;

/** Reads the routine file a config entry points at, and checks it says what the entry says. */
async function readListed(io: RepoIO, r: RepoRoutine): Promise<Routine> {
  const text = await io.read(r.path);
  if (text === null) throw new Error('the file is not in the repository.');
  const routine = parseRoutineFile(text);
  if (routine.meta.name !== r.name) throw new Error(`the file is named “${routine.meta.name}”, not “${r.name}”.`);
  const why = checkUrls(r.urls, routine.meta.site)[0];
  if (why) throw new Error(`urls: ${why}`);
  if (!siteListed(r.sites, routine.meta.site)) throw new Error(`the routine works on ${routine.meta.site}, which sites does not list (${r.sites!.join(', ')}).`);
  return routine;
}

export async function listRepo(io: RepoIO, limit = LIST_LIMIT): Promise<Listing> {
  const cfg = await io.read(CONFIG_FILE);
  if (cfg !== null) {
    const { config, problems } = parseConfigRoutine(cfg);
    // A file that is there but wrong is an error to fix, not a reason to guess at another layout.
    if (!config) return { entries: [], skipped: 0, problems: problems.map(formatProblem) };
    const entries: SourceEntry[] = [];
    const out: string[] = [];
    let skipped = Math.max(0, config.routines.length - limit);
    for (const [i, r] of config.routines.slice(0, limit).entries()) {
      try {
        const routine = await readListed(io, r);
        const { meta } = routine;
        entries.push({ path: r.path, name: r.name, site: meta.site, description: r.description, version: meta.version, ...(r.instructions ? { instructions: r.instructions } : {}), ...(r.sites ? { sites: r.sites } : {}), urls: r.urls ?? routine.meta.urls ?? deriveUrls(routine.steps, routine.meta.site), ...(r.hooks ? { hooks: Object.keys(r.hooks).length } : {}) });
      } catch (e) {
        skipped++;
        out.push(problemAt(i, r, (e as Error).message));
      }
    }
    return { entries, skipped, repo: repoInfo(config), ...(out.length ? { problems: out } : {}) };
  }
  const entries: SourceEntry[] = [];
  const paths = await io.fallback();
  let skipped = Math.max(0, paths.length - limit);
  for (const path of paths.slice(0, limit)) {
    try {
      const text = await io.read(path);
      if (text === null) throw new Error('gone');
      const { meta, steps } = parseRoutineFile(text);
      if (path !== SINGLE_PATH && `routines/${meta.name}.md` !== path) throw new Error('name does not match the file');
      entries.push({ path, name: meta.name, site: meta.site, description: meta.description, version: meta.version, urls: meta.urls ?? deriveUrls(steps, meta.site) });
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

/** One routine from a repository, with what its config.routine adds. Nothing is installed by this. */
export async function fetchRepo(io: RepoIO, path: string): Promise<Omit<Fetched, 'path' | 'ref'>> {
  const cfg = await io.read(CONFIG_FILE);
  if (cfg !== null) {
    if (!isRepoPath(path)) throw new Error('Not a routine file.');
    const { config, problems } = parseConfigRoutine(cfg);
    if (!config) throw new ConfigError(problems);
    const i = config.routines.findIndex((r) => r.path === path);
    if (i < 0) throw new Error(`${CONFIG_FILE} does not list ${path}.`);
    try {
      return { routine: await readListed(io, config.routines[i]), repo: repoInfo(config), entry: config.routines[i] };
    } catch (e) {
      throw new Error(problemAt(i, config.routines[i], (e as Error).message));
    }
  }
  if (!FILE_PATH.test(path) && path !== SINGLE_PATH) throw new Error('Not a routine file.');
  const text = await io.read(path);
  if (text === null) throw new Error('Not found in the repository.');
  const routine = parseRoutineFile(text);
  if (path !== SINGLE_PATH && `routines/${routine.meta.name}.md` !== path) throw new Error('The routine’s name does not match its file.');
  return { routine };
}

/** The routine as it is installed: the description and notes the repository's config.routine gives, kept with it. */
export function withRepo(f: Pick<Fetched, 'routine' | 'repo' | 'entry'>): Routine {
  const { routine, repo, entry } = f;
  if (!repo || !entry) return routine;
  return {
    ...routine,
    meta: {
      ...routine.meta,
      description: entry.description,
      instructions: entry.instructions ?? routine.meta.instructions,
      ...(entry.urls ? { urls: entry.urls } : {}),
      ...(entry.hooks ? { hooks: entry.hooks } : {}),
      repo: { name: repo.name, ...(repo.instructions ? { instructions: repo.instructions } : {}) },
    },
  };
}

// ---------- the block list ----------

export interface BlockList {
  users: string[];
  repos: string[];
  routines: string[];
}

/** An address in the form the block list stores: https, lowercase, no .git, no trailing slash. GitHub only for now. */
export function repoKey(address: string): string | null {
  const a = address.trim().replace(/^git@github\.com:/i, 'https://github.com/');
  const m = /^(?:https:\/\/)?(?:www\.)?github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(a);
  return m ? `https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

/** Why this origin may not be used, or null. A directory routine is named owner/name by its owner. */
export function blockedBy(list: BlockList, origin: Origin, id: string): string | null {
  if (origin.kind === 'github' && list.repos.includes(origin.source)) return 'The repository it came from was blocked.';
  if (origin.kind === 'directory') {
    if (list.users.includes(origin.source)) return 'Its publisher was blocked.';
    if (list.routines.includes(id)) return 'It was taken down from the directory.';
  }
  return null;
}

// ---------- GitHub ----------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const GITHUB = { api: 'https://api.github.com', raw: 'https://raw.githubusercontent.com' };
const SHA = /^[0-9a-f]{40}$/;
const LIST_LIMIT = 50;

/** `hosts` is only ever changed by the functional test. */
export function githubSource(key: string, doFetch: Fetch = fetch, hosts = GITHUB): Source {
  const API = hosts.api;
  const RAW = hosts.raw;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(key);
  if (!m) throw new Error('Not a GitHub repository address.');
  const [, owner, repo] = m;

  const get = async (url: string, init?: RequestInit) => {
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error('Could not reach GitHub. Check the connection and try again.');
    }
    if (res.status === 404) throw new Error('Not found. The repository may be private or the address wrong.');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is limiting requests. Try again in a while.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    return res;
  };

  const head = async () => {
    const sha = (await (await get(`${API}/repos/${owner}/${repo}/commits/HEAD`, { headers: { Accept: 'application/vnd.github.sha' } })).text()).trim();
    if (!SHA.test(sha)) throw new Error('GitHub gave an unexpected answer.');
    return sha;
  };

  const file = async (path: string, ref: string, max = MAX_FILE) => {
    const res = await get(`${RAW}/${owner}/${repo}/${ref}/${path}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > max) throw new Error('The file is too large.');
    return res.text();
  };

  /** What the repository layer reads: a file at one commit, null when it is not there. */
  const io = (ref: string, tree?: Set<string>): RepoIO => ({
    async read(path) {
      // The listing already has the tree, so a missing file costs no request.
      if (tree && !tree.has(path)) return null;
      try {
        return await file(path, ref, path === CONFIG_FILE ? MAX_CONFIG : MAX_FILE);
      } catch (e) {
        if (/Not found/.test((e as Error).message)) return null;
        throw e;
      }
    },
    async fallback() {
      return [...(tree ?? [])].filter((p) => FILE_PATH.test(p) || p === SINGLE_PATH);
    },
  });

  return {
    kind: 'github',
    id: key,
    async list() {
      const ref = await head();
      const t = (await (await get(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`)).json()) as { tree?: { path: string; type: string; size?: number }[] };
      const blobs = (t.tree ?? []).filter((x) => x.type === 'blob' && (x.size ?? 0) <= (x.path === CONFIG_FILE ? MAX_CONFIG : MAX_FILE));
      return { ...(await listRepo(io(ref, new Set(blobs.map((x) => x.path))))), ref };
    },
    async fetch(path, ref) {
      const sha = ref && SHA.test(ref) ? ref : await head();
      return { ...(await fetchRepo(io(sha), path)), ref: sha, path };
    },
  };
}

/** The owner directory a routine from this origin is saved under. The underscore keeps it apart from any handle. */
export function ownerFor(origin: Origin): string {
  if (origin.kind === 'github') return 'gh_' + origin.source.split('/')[3];
  if (origin.kind === 'folder') return 'folder_' + (origin.source.split(/[\\/]/).filter(Boolean).pop() ?? 'routines').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return origin.source;
}
