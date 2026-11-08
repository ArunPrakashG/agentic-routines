import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

export const HOST_NAME = 'com.agentic_routines.host';

export const LEGACY_HOST_NAME = 'com.browser_routines.host';

let moved = false;

export function home(): string {
  if (process.env.AGENTIC_ROUTINES_HOME) return process.env.AGENTIC_ROUTINES_HOME;
  const dir = join(homedir(), '.agentic-routines');
  if (!moved) {
    moved = true;
    // The project was called Browser Routines before: keep what is already saved.
    const old = join(homedir(), '.browser-routines');
    try {
      if (existsSync(old) && !existsSync(dir)) renameSync(old, dir);
    } catch {
      // Left where it is; a fresh folder is used.
    }
  }
  return dir;
}

export const paths = {
  root: () => home(),
  routines: () => join(home(), 'routines'),
  hosts: () => join(home(), 'hosts'),
  bin: () => join(home(), 'bin'),
  log: () => join(home(), 'host.log'),
  logs: () => join(home(), 'logs'),
  actions: () => join(home(), 'logs', 'actions.jsonl'),
  debugFlag: () => join(home(), 'debug'),
  marksFlag: () => join(home(), 'marks'),
  shots: () => join(home(), 'logs', 'shots'),
  captures: () => join(home(), 'captures'),
};

/** Unix socket on macOS/Linux, named pipe on Windows. */
export function socketPath(pid: number): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\agentic-routines-${pid}`;
  const p = join(paths.hosts(), `${pid}.sock`);
  // Longer socket paths get cut short silently, so long homes use a short private dir.
  if (Buffer.byteLength(p) <= 100) return p;
  const dir = join(tmpdir(), `agentic-routines-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${pid}.sock`);
}
