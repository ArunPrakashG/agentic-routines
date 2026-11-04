import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseRoutineMd, stringifyRoutineMd, type Routine, type Step } from '@browser-routines/core';
import { paths } from './paths.ts';

// Routines live at ~/.browser-routines/routines/<owner>/<name>/{ROUTINE.md,steps.json}.
// "local" is the owner until the user signs in and picks a handle.

export const LOCAL = 'local';

export interface Listed {
  name: string;
  owner: string;
  version: number;
  site: string;
  description: string;
  enabled: boolean;
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
        out.push({ name, owner, version: meta.version, site: meta.site, description: meta.description, enabled: !disabled });
      } catch {
        // Not a routine folder.
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
export async function write(r: Routine, owner = r.meta.owner ?? LOCAL): Promise<Routine> {
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
  return saved;
}

export async function remove(id: string): Promise<void> {
  const [owner, name] = await locate(id);
  await rm(dir(owner, name), { recursive: true, force: true });
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  const [owner, name] = await locate(id);
  const f = join(dir(owner, name), '.disabled');
  if (enabled) await rm(f, { force: true });
  else await writeFile(f, '');
}
