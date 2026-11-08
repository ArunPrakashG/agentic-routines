// Builds what the install script downloads: for each platform, a Node runtime and the CLI, so nothing else has to be on the machine.
// It is a folder in an archive, not one file. Bundles are too big to commit, so they go to .dev/ and then to the GitHub release.
// Usage: node releases/scripts/bundle.mjs [--only linux-x64] [--node /path/to/node] [--out dir] [--key file] [--as 1.2.3]
//
//   agentic-routines-<v>-<target>.tar.gz     One for each target
//   manifest.json                            Version, size and checksum of each, with a target on each line for the shell script
//   manifest.sig                             Ed25519 over manifest.json, when there is a key. Installed copies insist on it
//
// --node uses a Node you have instead of downloading one, for a trial on this machine. --as stamps another version on the package,
// for trying an update.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, root, run, sha256, version } from './lib.mjs';

// Move this along with Node's security releases, and say so in the notes.
const NODE = '22.20.0';
const TARGETS = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'darwin-x64': 'darwin-x64', 'darwin-arm64': 'darwin-arm64', 'win-x64': 'win-x64' };

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const v = flag('as') ?? version();
const only = flag('only');
const targets = only ? only.split(',') : Object.keys(TARGETS);
for (const t of targets) if (!TARGETS[t]) throw new Error(`There is no target called ${t}. There are: ${Object.keys(TARGETS).join(', ')}`);
const dest = flag('out') ?? join(root, '.dev', 'bundles', `v${v}`);
const stage = join(root, '.dev', 'bundle-stage');
const cache = join(root, '.dev', 'node-cache', NODE);

const keyFile = flag('key') ?? join(root, '.keys', 'update-signing.pem');
const pem = process.env.AR_UPDATE_SIGNING_KEY ?? (existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : undefined);
const key = pem ? createPrivateKey(pem) : undefined;
if (!key) console.warn('No signing key, so these bundles are unsigned and will not update themselves. See releases/scripts/signing-key.mjs.');

rmSync(stage, { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(join(stage, 'app'), { recursive: true });
mkdirSync(dest, { recursive: true });
mkdirSync(cache, { recursive: true });

// The build reads the public key, so it has to be the one that goes with what signs these.
const env = { ...process.env, ...(key ? { AR_UPDATE_PUBLIC_KEY: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64') } : {}) };
run('pnpm', ['-C', 'packages/cli', 'build'], { env });
run('npm', ['pack', '--silent', '--pack-destination', stage], { cwd: join(root, 'packages', 'cli'), stdio: ['ignore', 'ignore', 'inherit'] });
const tgz = readdirSync(stage).find((f) => f.endsWith('.tgz'));
run('npm', ['install', join(stage, tgz), '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--silent', '--prefix', join(stage, 'app')]);
const pkg = join(stage, 'app', 'node_modules', 'agentic-routines', 'package.json');
writeFileSync(pkg, JSON.stringify({ ...readJson(pkg), version: v }, null, 2));

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** A folder holding the runtime for a target, checked against the checksums Node publishes. */
async function runtime(target) {
  const dir = join(stage, 'node', target);
  mkdirSync(dir, { recursive: true });
  const windows = target.startsWith('win');
  const bin = windows ? 'node.exe' : 'node';
  if (flag('node')) {
    run('cp', [flag('node'), join(dir, bin)]);
    return { dir, bin };
  }
  const sums = join(cache, 'SHASUMS256.txt');
  if (!existsSync(sums)) await download(`https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`, sums);
  const name = windows ? `${TARGETS[target]}/node.exe` : `node-v${NODE}-${TARGETS[target]}.tar.gz`;
  const file = join(cache, name.replace('/', '-'));
  if (!existsSync(file)) await download(`https://nodejs.org/dist/v${NODE}/${name}`, file);
  const want = readFileSync(sums, 'utf8').split('\n').find((l) => l.endsWith(`  ${name}`))?.split(' ')[0];
  if (!want || sha256(file) !== want) {
    rmSync(file, { force: true });
    throw new Error(`${name} does not match the checksums Node publishes, so it was not used.`);
  }
  if (windows) {
    run('cp', [file, join(dir, bin)]);
  } else {
    const inner = `node-v${NODE}-${TARGETS[target]}`;
    run('tar', ['-xzf', file, '-C', dir, '--strip-components=2', `${inner}/bin/node`]);
  }
  return { dir, bin };
}

const files = {};
for (const target of targets) {
  const { dir, bin } = await runtime(target);
  const name = `agentic-routines-${v}-${target}.tar.gz`;
  run('tar', ['-czf', join(dest, name), '-C', join(stage, 'app'), 'node_modules', '-C', dir, bin]);
  files[target] = { name, size: statSync(join(dest, name)).size, sha256: createHash('sha256').update(readFileSync(join(dest, name))).digest('hex') };
  console.log(`${name}  ${(files[target].size / 1e6).toFixed(0)} MB`);
}

const lines = Object.entries(files).map(([t, f]) => `${JSON.stringify(t)}:${JSON.stringify(f)}`);
const manifest = `{"version":${JSON.stringify(v)},"files":{\n${lines.join(',\n')}\n}}\n`;
writeFileSync(join(dest, 'manifest.json.tmp'), manifest);
renameSync(join(dest, 'manifest.json.tmp'), join(dest, 'manifest.json'));
if (key) writeFileSync(join(dest, 'manifest.sig'), `${sign(null, Buffer.from(manifest), key).toString('base64')}\n`);
rmSync(stage, { recursive: true, force: true });
console.log(`Written to ${dest}. Upload every file there to the GitHub release of v${v}.`);
