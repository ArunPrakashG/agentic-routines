import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkFetched, parseRoutineFile, stringifyRoutineFile } from '@agentic-routines/core';
import { paths } from '../paths.ts';
import * as sources from './sources.ts';
import * as store from './routines.ts';

// Routines kept in a project's own repository, so they are tracked by Git and a team shares them.
//
//   <repo>/.agentic-routines/routines/<name>.md      one routine per file, as `export` prints it
//
// The folder is a folder source. An agent that starts in the repository lists it (nothing more), and each person
// installs a routine once, after reading its steps in the side panel. A routine that changes after that shows as changed.
// A repository is somebody else's text, so nothing here installs on its own.

export const PROJECT_DIR = '.agentic-routines';

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
const exists = (p: string) => stat(p).then(() => true, () => false);

/** The repository root that `from` is in: the nearest folder with .git, not looking above the home folder. */
export async function gitRoot(from = process.cwd()): Promise<string | undefined> {
  const home = await realpath(homedir()).catch(() => homedir());
  let d = await realpath(resolve(from)).catch(() => resolve(from));
  for (;;) {
    if (d === home) return undefined;
    if (await exists(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/** The project's shared folder, when `from` is in a repository that has one. */
export async function find(from = process.cwd()): Promise<string | undefined> {
  const root = await gitRoot(from);
  if (!root) return undefined;
  const dir = join(root, PROJECT_DIR);
  // The app keeps its own files in a folder of the same name in the home folder; that is never a project.
  if (resolve(dir) === resolve(paths.root())) return undefined;
  return (await isDir(dir)) ? dir : undefined;
}

export type ProjectState = 'new' | 'installed' | 'changed';
export interface ProjectRoutine {
  name: string;
  path: string;
  site: string;
  version: number;
  state: ProjectState;
}

/** What the project shares, and for each routine whether it is installed here and still the same as the file. */
export async function status(dir: string): Promise<{ routines: ProjectRoutine[]; problems: string[]; removed: string[] }> {
  const l = await sources.checkFolder(dir);
  const mine = (await store.list()).filter((r) => r.origin?.kind === 'folder' && r.origin.source === dir);
  const routines = l.entries.map((e): ProjectRoutine => {
    const have = mine.find((r) => r.origin?.path === e.path);
    return { name: e.name, path: e.path, site: e.site, version: e.version, state: !have ? 'new' : have.origin?.ref === e.ref ? 'installed' : 'changed' };
  });
  // Installed from this folder, and the file is gone: it was taken off the team, or renamed.
  const removed = l.problems?.length ? [] : mine.filter((r) => !l.entries.some((e) => e.path === r.origin?.path)).map((r) => `${r.owner}/${r.name}`);
  return { routines, problems: l.problems ?? [], removed };
}

/** Uninstalls the copies on this computer whose file the project no longer has. */
export async function prune(dir: string): Promise<string[]> {
  const { removed } = await status(dir);
  for (const id of removed) await store.remove(id);
  return removed;
}

/**
 * For an agent that starts in a repository: lists the project's routines as a source and says what is there.
 * It is text for the agent's instructions, so names are cut down to what a routine name can be.
 */
export async function note(from = process.cwd()): Promise<string> {
  const dir = await find(from);
  if (!dir) return '';
  await sources.addProject(dir).catch(() => {});
  const { routines } = await status(dir).catch(() => ({ routines: [] as ProjectRoutine[], problems: [], removed: [] }));
  const safe = (r: ProjectRoutine) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(r.name);
  const all = routines.filter(safe);
  if (!all.length) return '';
  const waiting = all.filter((r) => r.state !== 'installed');
  const list = (rs: ProjectRoutine[]) => rs.slice(0, 20).map((r) => r.name).join(', ');
  return (
    `\n\nThis project's repository shares routines in ${PROJECT_DIR}/routines: ${list(all)}. The team keeps them in Git. ` +
    (waiting.length
      ? `Not installed on this computer yet, or changed since: ${list(waiting)}. routines_search lists them; routine_install_from_git installs one once the user has read it in the side panel. Do not tell the user a project routine ran if it has not been installed.`
      : 'All are installed here.') +
    ` To share a routine with the team, run: agentic-routines project add <routine>, and leave the commit to the user.`
  );
}

const README = `# Shared routines

Browser routines for this project, kept in Git so the team shares them.

Each file in \`routines/\` is one routine. An agent started in this repository lists them. Each person installs a routine
once, after reading its steps in the Agentic Routines side panel, and again when it changes.

Add one with \`agentic-routines project add <routine>\`. Review the diff like any other code: a routine acts in a
signed-in browser.
`;

/** Saves an installed or recorded routine into the repository that `from` is in. */
export async function save(id: string, o: { from?: string; dir?: string; examples?: boolean } = {}): Promise<{ file: string; version: number; change: 'created' | 'updated' | 'unchanged' }> {
  let dir = o.dir;
  if (!dir) {
    const root = await gitRoot(o.from);
    if (!root) throw new Error('Run this inside a Git repository.');
    dir = join(root, PROJECT_DIR);
  }
  const r = await store.read(id);
  // Example values are what was typed when it was recorded. They stay out of a repository unless asked for.
  const params = Object.fromEntries(Object.entries(r.meta.params ?? {}).map(([k, v]) => [k, o.examples ? v : { ...v, example: undefined }]));
  const shared = { meta: { ...r.meta, owner: undefined, repo: undefined, params }, body: r.body, steps: r.steps };
  const problems = checkFetched(shared);
  if (problems.length) throw new Error(`Fix this first: ${problems.join(' ')}`);

  const file = join(dir, 'routines', `${r.meta.name}.md`);
  const before = await readFile(file, 'utf8').catch(() => undefined);
  let version = shared.meta.version;
  let change: 'created' | 'updated' | 'unchanged' = 'created';
  if (before !== undefined) {
    const old = parseRoutineFile(before);
    // The same routine again is not a new version.
    if (stringifyRoutineFile({ ...shared, meta: { ...shared.meta, version: old.meta.version } }) === stringifyRoutineFile(old)) return { file, version: old.meta.version, change: 'unchanged' };
    version = Math.max(version, old.meta.version + 1);
    change = 'updated';
  }
  await mkdir(join(dir, 'routines'), { recursive: true });
  await writeFile(file, stringifyRoutineFile({ ...shared, meta: { ...shared.meta, version } }));
  if (!(await exists(join(dir, 'README.md')))) await writeFile(join(dir, 'README.md'), README);
  await sources.addProject(dir).catch(() => {});
  return { file, version, change };
}

/** Takes a routine out of the repository. The copy installed on each computer stays until its owner removes it. */
export async function unshare(name: string, from = process.cwd()): Promise<string> {
  const dir = await find(from);
  if (!dir || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) throw new Error('No such shared routine.');
  const file = join(dir, 'routines', `${name}.md`);
  if (!(await exists(file))) throw new Error('No such shared routine.');
  await rm(file);
  return file;
}

/** The projects the side panel may share into: the ones an agent was started in, and the person did not remove. */
export async function targets(): Promise<{ dir: string; name: string }[]> {
  const { sources: all } = await sources.list();
  return all.filter((x) => x.project && x.enabled).map((x) => ({ dir: x.id, name: x.id.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? 'project' }));
}

/** From the side panel, after the person chose the project. Only a listed project is written to. */
export async function share(id: string, dir: string): Promise<{ name: string; change: string; version: number }> {
  const t = (await targets()).find((x) => x.dir === dir);
  if (!t) throw new Error('That is not one of your projects.');
  if (!(await isDir(dir))) throw new Error('That project folder is gone.');
  const r = await save(id, { dir });
  return { name: t.name, change: r.change, version: r.version };
}
