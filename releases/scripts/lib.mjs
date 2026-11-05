import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const releases = join(root, 'releases');

export const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
export const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts }).trim();

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Every package.json that carries the product version. */
export const versioned = ['package.json', 'packages/cli/package.json', 'packages/core/package.json', 'packages/browsers/package.json', 'packages/extension/package.json'];

export const version = () => readJson(join(root, 'package.json')).version;

export function files(dir) {
  return readdirSync(dir)
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
}
