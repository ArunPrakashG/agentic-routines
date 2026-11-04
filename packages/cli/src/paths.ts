import { homedir } from 'node:os';
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
  return join(paths.hosts(), `${pid}.sock`);
}
