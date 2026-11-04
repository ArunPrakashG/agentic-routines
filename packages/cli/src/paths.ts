import { mkdirSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

export const HOST_NAME = 'com.browser_routines.host';

export function home(): string {
  return process.env.BROWSER_ROUTINES_HOME ?? join(homedir(), '.browser-routines');
}

export const paths = {
  root: () => home(),
  routines: () => join(home(), 'routines'),
  hosts: () => join(home(), 'hosts'),
  bin: () => join(home(), 'bin'),
  log: () => join(home(), 'host.log'),
};

/** Unix socket on macOS/Linux, named pipe on Windows. */
export function socketPath(pid: number): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\browser-routines-${pid}`;
  const p = join(paths.hosts(), `${pid}.sock`);
  // Longer socket paths get cut short silently, so long homes use a short private dir.
  if (Buffer.byteLength(p) <= 100) return p;
  const dir = join(tmpdir(), `browser-routines-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${pid}.sock`);
}
