import { execFile } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { paths } from './paths.ts';

// An installed copy keeps itself current, when nothing is going on. This only ever applies to a copy from the install script:
// npx has its own way of updating, and a checkout is yours. A manifest has to carry a signature from the release key built in
// here, since this runs whatever it downloads with no one looking. Agents have no tool for the setting, and the command asks in
// a terminal. An agent with a shell could still edit the file, as it could anything else of yours.

declare const __UPDATE_KEY__: string;
const KEY = typeof __UPDATE_KEY__ === 'string' ? __UPDATE_KEY__ : '';

const BASE = () => process.env.AGENTIC_ROUTINES_BASE ?? 'https://github.com/ArunPrakashG/agentic-routines/releases/latest/download';
const FIRST_MS = 10 * 60_000;
const EVERY_MS = 60 * 60_000;
const LOCK_MS = 10 * 60_000;

const appDir = () => join(paths.root(), 'app');
const stateFile = () => join(appDir(), 'update.json');

interface UpdateState {
  auto?: boolean;
  checkedAt?: number;
  error?: string;
  installed?: string;
}

const readState = (): UpdateState => {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
};

const writeState = (change: UpdateState) => {
  mkdirSync(appDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...change }, null, 2), { mode: 0o600 });
};

export const version = (): string => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** The command that always starts the current version, when this is an installed copy. */
export function launcher(): string | undefined {
  const run = join(appDir(), process.platform === 'win32' ? 'run.cmd' : 'run');
  try {
    return realpathSync(process.argv[1]).startsWith(realpathSync(appDir()) + sep) && existsSync(run) ? run : undefined;
  } catch {
    return undefined;
  }
}

export const hasKey = () => !!KEY;
export const autoOn = () => readState().auto !== false && !process.env.AGENTIC_ROUTINES_NO_UPDATE;
export const setAuto = (auto: boolean) => writeState({ auto });
export const updateState = readState;

const newer = (a: string, b: string) => {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

async function fetched(name: string): Promise<Buffer> {
  const r = await fetch(`${BASE()}/${name}`, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
  if (!r.ok) throw new Error(`The download of ${name} answered ${r.status}.`);
  return Buffer.from(await r.arrayBuffer());
}

export const target = () => `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

function takeLock(): boolean {
  const lock = join(appDir(), 'update.lock');
  mkdirSync(appDir(), { recursive: true, mode: 0o700 });
  try {
    if (Date.now() - statSync(lock).mtimeMs > LOCK_MS) rmdirSync(lock);
  } catch {
    // No lock, which is the usual case.
  }
  try {
    mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

/** Says what happened, for a person. A failure throws, and an attempt that failed is noted for doctor. */
export async function updateNow(): Promise<string> {
  if (!launcher()) return 'This copy did not come from the install script, so it does not update itself.';
  if (!KEY) return 'This build has no release key, so it does not update itself.';
  if (!takeLock()) return 'Another update is going on.';
  try {
    const raw = await fetched('manifest.json');
    const signature = (await fetched('manifest.sig')).toString('utf8').trim();
    if (!verify(null, raw, createPublicKey({ key: Buffer.from(KEY, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'))) throw new Error('The manifest does not carry the release signature, so nothing was installed.');
    const manifest = JSON.parse(raw.toString('utf8')) as { version: string; files: Record<string, { name: string; size: number; sha256: string }> };
    const now = version();
    writeState({ checkedAt: Date.now(), error: undefined });
    if (!newer(manifest.version, now)) return `Up to date: ${now}.`;
    const file = manifest.files[target()];
    if (!file) throw new Error(`Version ${manifest.version} has nothing for ${target()}.`);
    const bytes = await fetched(file.name);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('The download does not match the manifest, so nothing was installed.');
    if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(manifest.version)) throw new Error('The manifest names an odd version.');
    const dir = join(appDir(), manifest.version);
    const incoming = `${dir}.new-${process.pid}`;
    rmSync(incoming, { recursive: true, force: true });
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    const tar = join(incoming, 'bundle.tar.gz');
    writeFileSync(tar, bytes);
    await promisify(execFile)('tar', ['-xzf', tar, '-C', incoming]);
    rmSync(tar);
    rmSync(dir, { recursive: true, force: true });
    renameSync(incoming, dir);
    const current = join(appDir(), 'current.txt');
    writeFileSync(`${current}.tmp`, manifest.version);
    renameSync(`${current}.tmp`, current);
    writeState({ installed: manifest.version });
    // Keeps the one that is running, for whatever still has it open.
    for (const old of readdirSync(appDir())) if (/^\d+\.\d+\.\d+/.test(old) && old !== manifest.version && old !== now) rmSync(join(appDir(), old), { recursive: true, force: true });
    return `Updated from ${now} to ${manifest.version}. What is running keeps ${now} until it restarts.`;
  } catch (e) {
    writeState({ checkedAt: Date.now(), error: (e as Error).message });
    throw e;
  } finally {
    rmSync(join(appDir(), 'update.lock'), { recursive: true, force: true });
  }
}

/** In the background of an agent's server, as nothing else of ours stays running. Not while it is busy. */
export function updateWhenIdle(busy: () => boolean) {
  if (!launcher() || !KEY) return;
  const tick = () => {
    const last = readState().checkedAt ?? 0;
    if (!autoOn() || busy() || Date.now() - last < EVERY_MS - 60_000) return;
    void updateNow().catch(() => {});
  };
  setTimeout(tick, FIRST_MS).unref();
  setInterval(tick, EVERY_MS).unref();
}
