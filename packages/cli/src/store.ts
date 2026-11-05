import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRoutineMd, stringifyRoutineMd, type Origin, type Routine, type Step } from '@agentic-routines/core';
import { paths } from './paths.ts';

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
        const disabled = await readFile(join(paths.routines(), owner, name, '.disabled'), 'utf8').then(() => true, () => false);
        const origin = await readJson<Origin>(join(paths.routines(), owner, name, '.origin.json'));
        const blocked = (await readJson<{ reason: string }>(join(paths.routines(), owner, name, '.blocked.json')))?.reason;
        out.push({ name, owner, version: meta.version, site: meta.site, description: meta.description, enabled: !disabled, draftedBy: meta.drafted_by, origin, blocked });
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
