import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../paths.ts';

// A routine runs once at a time on this computer, whichever agent or browser profile asks. The browser keeps the same
// rule for its own runs; this covers two profiles (or two browsers) that share the routine and, often, the account
// it acts on. A lock is a folder, which only one process can create, naming the process that took it.

const STALE_MS = 3 * 60 * 60_000;

interface Holder {
  pid: number;
  who: string;
  since: number;
}

const dir = (key: string) => join(paths.root(), 'locks', key.replace(/[^a-zA-Z0-9._-]/g, '_'));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function holder(key: string): Promise<Holder | undefined> {
  try {
    return JSON.parse(await readFile(join(dir(key), 'holder.json'), 'utf8')) as Holder;
  } catch {
    return undefined;
  }
}

/** Takes the lock, waiting up to `waitMs` for whoever has it. Gives back a way to let go, or who has it. */
export async function acquire(key: string, who: string, waitMs: number): Promise<{ release: () => Promise<void> } | { heldBy: string }> {
  await mkdir(join(paths.root(), 'locks'), { recursive: true });
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(dir(key));
      await writeFile(join(dir(key), 'holder.json'), JSON.stringify({ pid: process.pid, who, since: Date.now() } satisfies Holder));
      return { release: () => rm(dir(key), { recursive: true, force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const h = await holder(key);
    // A process that is gone, or a lock that has been held for hours, is not holding anything.
    if (h ? !alive(h.pid) || Date.now() - h.since > STALE_MS : false) {
      await rm(dir(key), { recursive: true, force: true });
      continue;
    }
    if (Date.now() > end) return { heldBy: h?.who ?? 'another agent' };
    await new Promise((r) => setTimeout(r, 500));
  }
}
