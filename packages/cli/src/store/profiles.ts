import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../paths.ts';

// Names a person gave to browser profiles, by profile id, so "Work" reads better than a number.

const file = () => join(paths.root(), 'profiles.json');

export async function names(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(file(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setName(id: string, name: string): Promise<void> {
  const all = await names();
  if (name) all[id] = name;
  else delete all[id];
  await mkdir(paths.root(), { recursive: true });
  await writeFile(file(), JSON.stringify(all, null, 2));
}
