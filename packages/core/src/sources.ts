import { lintForPublish, parseRoutineMd, stringifyRoutineMd } from './routine-md.ts';
import type { Action, Routine, Step } from './types.ts';

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
}

export interface Fetched {
  routine: Routine;
  ref?: string;
  path: string;
}

export interface Source {
  kind: 'github' | 'folder';
  /** The stable address: https://github.com/owner/repo, or a folder path. */
  id: string;
  list(): Promise<{ entries: SourceEntry[]; skipped: number; ref?: string }>;
  fetch(path: string, ref?: string): Promise<Fetched>;
}

// ---------- the routine file ----------

const MAX_FILE = 256 * 1024;
const MAX_STEPS = 200;
const ACTIONS: Action[] = ['navigate', 'click', 'type', 'clear', 'select', 'upload', 'press', 'wait', 'read'];
const STEPS_BLOCK = /\n```steps\r?\n([\s\S]*?)\r?\n```\s*$/;
export const FILE_PATH = /^routines\/[a-z0-9][a-z0-9-]{1,62}\.md$/;

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
  }
  for (const i of lintForPublish(r.meta, urls)) out.push(i.message);
  for (const p of r.meta.pauses) if (!Number.isInteger(p) || p < 1 || p > r.steps.length) out.push('A pause points at a step that is not there.');
  return [...new Set(out)].slice(0, 8);
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

  const file = async (path: string, ref: string) => {
    const res = await get(`${RAW}/${owner}/${repo}/${ref}/${path}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_FILE) throw new Error('The file is too large.');
    return res.text();
  };

  return {
    kind: 'github',
    id: key,
    async list() {
      const ref = await head();
      const tree = (await (await get(`${API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`)).json()) as { tree?: { path: string; type: string; size?: number }[] };
      const paths = (tree.tree ?? []).filter((t) => t.type === 'blob' && FILE_PATH.test(t.path) && (t.size ?? 0) <= MAX_FILE).map((t) => t.path);
      const entries: SourceEntry[] = [];
      let skipped = Math.max(0, paths.length - LIST_LIMIT);
      for (const path of paths.slice(0, LIST_LIMIT)) {
        try {
          const { meta } = parseRoutineFile(await file(path, ref));
          if (`routines/${meta.name}.md` !== path) throw new Error('name does not match the file');
          entries.push({ path, name: meta.name, site: meta.site, description: meta.description, version: meta.version });
        } catch {
          skipped++;
        }
      }
      return { entries, skipped, ref };
    },
    async fetch(path, ref) {
      if (!FILE_PATH.test(path)) throw new Error('Not a routine file.');
      const sha = ref && SHA.test(ref) ? ref : await head();
      const routine = parseRoutineFile(await file(path, sha));
      if (`routines/${routine.meta.name}.md` !== path) throw new Error('The routine’s name does not match its file.');
      return { routine, ref: sha, path };
    },
  };
}

/** The owner directory a routine from this origin is saved under. The underscore keeps it apart from any handle. */
export function ownerFor(origin: Origin): string {
  if (origin.kind === 'github') return 'gh_' + origin.source.split('/')[3];
  if (origin.kind === 'folder') return 'folder_' + (origin.source.split(/[\\/]/).filter(Boolean).pop() ?? 'routines').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return origin.source;
}
