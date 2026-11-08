import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../paths.ts';

// Named sessions. The tabs are the browser's to keep; this is what a new server needs to pick one up again.

export interface NamedSession {
  name: string;
  id: string;
  /** The browser profile it started in. It stays there. */
  profile?: string;
  hosts?: string[];
  allowPrivate?: boolean;
  readOnly?: boolean;
  createdAt: number;
}

const file = () => join(paths.root(), 'sessions.json');

export async function all(): Promise<NamedSession[]> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as NamedSession[];
  } catch {
    return [];
  }
}

async function save(list: NamedSession[]) {
  await mkdir(paths.root(), { recursive: true });
  await writeFile(file(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

export const get = async (name: string) => (await all()).find((s) => s.name === name);

export async function create(name: string, o: Pick<NamedSession, 'hosts' | 'allowPrivate' | 'readOnly' | 'profile'>): Promise<NamedSession> {
  const list = await all();
  if (list.some((s) => s.name === name)) throw new Error(`There is already a session called ${name}. Use session_use, or pick another name.`);
  const s = { name, id: `named:${randomUUID()}`, createdAt: Date.now(), ...o };
  await save([...list, s]);
  return s;
}

export async function update(name: string, change: Partial<NamedSession>): Promise<NamedSession> {
  const list = await all();
  const s = list.find((x) => x.name === name);
  if (!s) throw new Error(`There is no session called ${name}.`);
  Object.assign(s, change);
  await save(list);
  return s;
}

export async function remove(name: string): Promise<void> {
  await save((await all()).filter((s) => s.name !== name));
}

/** What a person writes (a name or an address) as the host the browser compares. */
export function hostOf(entry: string): string {
  const t = entry.trim().replace(/^\*\./, '');
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `http://${t}`).hostname.toLowerCase();
  } catch {
    throw new Error(`${entry} is not a site name.`);
  }
}

/** Only ever shrinks: a new list must sit inside the old one. Anything wider is the person's to give. */
export function narrower(before: string[] | undefined, after: string[]): boolean {
  if (!before) return true;
  return after.every((h) => before.some((b) => h === b || h.endsWith(`.${b}`)));
}
