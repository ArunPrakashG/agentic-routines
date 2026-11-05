import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, sep } from 'node:path';

// What may be uploaded. The host checks every path an agent or a routine names, whichever way the file
// travels to the page, so the browser never reads something nobody allowed.

/** Past this a file does not go through the host in pieces; it needs the browser's own file access. */
export const MAX_STREAM = 25 * 1024 * 1024;
/** The most a single upload may be. */
export const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

const HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.docker', '.password-store', '.config/gcloud', '.config/gh', '.config/google-chrome', '.config/chromium', '.config/BraveSoftware', '.config/microsoft-edge', '.mozilla', '.local/share/keyrings', '.claude', '.agentic-routines', '.browser-routines', 'Library/Keychains', 'Library/Application Support/Google/Chrome'];
const SYSTEM_DIRS = ['/etc/shadow', '/etc/sudoers', '/proc', '/sys', '/dev'];
const SENSITIVE_NAME = /^(?:\.env(?:\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|.+\.kdbx|login data|cookies)$/i;

/** Why this path is not something to hand to a website, or null. */
export function sensitive(realPath: string): string | null {
  const home = homedir();
  const norm = realPath.split(sep).join('/');
  for (const d of HOME_DIRS) {
    const full = join(home, d).split(sep).join('/');
    if (norm === full || norm.startsWith(full + '/')) return `it is inside ~/${d}, where credentials and browser data live`;
  }
  for (const d of SYSTEM_DIRS) if (norm === d || norm.startsWith(d + '/')) return `${d} is a system location`;
  if (SENSITIVE_NAME.test(basename(realPath))) return `${basename(realPath)} looks like a credentials file`;
  return null;
}

export interface Checked {
  path: string;
  name: string;
  size: number;
}

/** Throws an error written for an agent to act on. */
export async function checkUpload(path: string): Promise<Checked> {
  if (!path || !isAbsolute(path)) throw new Error(`“${path}” is not an absolute path. Pass the full path of the file on this machine.`);
  let real: string;
  try {
    real = await realpath(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`No file at ${path}. Check the path; it has to exist on the machine where the agent runs.`);
    if (code === 'EACCES') throw new Error(`${path} cannot be reached: permission denied on a folder in its path.`);
    throw new Error(`${path} cannot be opened (${code ?? 'error'}).`);
  }
  const why = process.env.AGENTIC_ROUTINES_ALLOW_SENSITIVE_UPLOADS === '1' ? null : sensitive(real);
  if (why) throw new Error(`Refused to upload ${path}: ${why}. Only the user can change this, by setting AGENTIC_ROUTINES_ALLOW_SENSITIVE_UPLOADS=1 for the agent.`);
  const s = await stat(real);
  if (s.isDirectory()) throw new Error(`${path} is a folder. Pass a file, or paths with one entry per file.`);
  if (!s.isFile()) throw new Error(`${path} is not a regular file.`);
  try {
    await access(real, constants.R_OK);
  } catch {
    throw new Error(`${path} exists but cannot be read: permission denied. Ask the user to fix its permissions or pick another file.`);
  }
  if (s.size > MAX_UPLOAD) throw new Error(`${basename(path)} is ${mb(s.size)}, more than the ${mb(MAX_UPLOAD)} limit for an upload.`);
  return { path: real, name: basename(path), size: s.size };
}

export const mb = (n: number) => (n >= 1024 * 1024 * 1024 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/** A routine step's value can name several files, one per line. */
export const splitPaths = (v: string) => v.split('\n').map((p) => p.trim()).filter(Boolean);
