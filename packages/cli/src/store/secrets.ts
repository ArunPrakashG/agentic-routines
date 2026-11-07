import { createHmac } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../paths.ts';

// Values a person chose to keep for one site each, so a routine can sign in by itself. Nothing is here unless they put it here.
// The files are private to the user account and not encrypted: anything running as that user can read them.

export interface StoredSecret {
  name: string;
  origin: string;
  /** A password or other text, or the seed of a one-time code. */
  kind: 'value' | 'totp';
  value: string;
}

const dir = () => join(paths.root(), 'secrets');
const NAME = /^[a-z0-9_]{1,60}$/;
const fileOf = (name: string) => {
  if (!NAME.test(name)) throw new Error('A secret name is lower-case letters, digits and underscores.');
  return join(dir(), `${name}.json`);
};

/** Only an address with a scheme and a host: what a browser compares. */
export function originOf(given: string): string {
  let u: URL;
  try {
    u = new URL(given);
  } catch {
    throw new Error(`${given} is not an origin. Write it as https://example.com`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`${given} is not a website origin.`);
  return u.origin;
}

export async function add(s: StoredSecret): Promise<void> {
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  await chmod(dir(), 0o700);
  await writeFile(fileOf(s.name), JSON.stringify(s), { mode: 0o600 });
  await chmod(fileOf(s.name), 0o600);
}

export async function remove(name: string): Promise<boolean> {
  const f = fileOf(name);
  const there = await stat(f).then(() => true, () => false);
  await rm(f, { force: true });
  return there;
}

async function read(name: string): Promise<StoredSecret | undefined> {
  try {
    const f = fileOf(name);
    if (process.platform !== 'win32' && (await stat(f)).mode & 0o077) throw new Error(`${f} can be read by other accounts on this computer, so it is not used. Remove it and add it again.`);
    return JSON.parse(await readFile(f, 'utf8')) as StoredSecret;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Names and sites. This is all an agent gets to see. */
export async function list(): Promise<Omit<StoredSecret, 'value'>[]> {
  const files = await readdir(dir()).catch(() => [] as string[]);
  const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => read(f.slice(0, -5)).catch(() => undefined)));
  return all.filter((s): s is StoredSecret => !!s).map(({ name, origin, kind }) => ({ name, origin, kind }));
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function fromBase32(seed: string): Buffer {
  let bits = '';
  for (const c of seed.toUpperCase().replace(/[\s=-]/g, '')) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error('That one-time code seed is not base32.');
    bits += i.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
}

/** The six digits an authenticator app would show now (RFC 6238). */
export function totp(seed: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', fromBase32(seed)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** The value, only for the site it was stored for. The browser says which origin the field is on, read from the browser's own record of the frame. */
export async function valueFor(name: string, origin: string): Promise<string> {
  const s = await read(name);
  if (!s) throw new Error(`Missing secret ${name}`);
  if (s.origin !== origin) throw new Error(`The secret ${name} is kept for ${s.origin}, and this field is on ${origin}, so it was not used.`);
  return s.kind === 'totp' ? totp(s.value) : s.value;
}
