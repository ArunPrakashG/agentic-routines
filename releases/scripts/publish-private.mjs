// Publishes a release's CLI package to GitHub Packages, as @<owner>/agentic-routines, so it stays as private as the repo.
// Needs `gh` signed in with the write:packages scope. Usage: node releases/scripts/publish-private.mjs 0.3.1
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = process.argv[2] ?? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const owner = 'arunprakashg';
const tgz = join(root, 'releases', `v${version}`, 'cli', `agentic-routines-${version}.tgz`);

const work = mkdtempSync(join(tmpdir(), 'ar-private-'));
try {
  execFileSync('tar', ['-xzf', tgz, '-C', work]);
  const dir = join(work, 'package');
  const file = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.name = `@${owner}/agentic-routines`;
  pkg.publishConfig = { registry: 'https://npm.pkg.github.com' };
  pkg.repository = { type: 'git', url: 'git+https://github.com/ArunPrakashG/agentic-routines.git' };
  writeFileSync(file, JSON.stringify(pkg, null, 2));
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  writeFileSync(join(dir, '.npmrc'), `//npm.pkg.github.com/:_authToken=${token}\n@${owner}:registry=https://npm.pkg.github.com\n`);
  execFileSync('npm', ['publish'], { cwd: dir, stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
