// Builds everything a release ships and writes it to releases/v<version>/.
// Usage: node releases/scripts/build.mjs [--allow-dirty]
//
//   extensions/agentic-routines-<v>-chrome.zip     Chrome Web Store, and Edge Add-ons (same package)
//   extensions/agentic-routines-<v>-firefox.zip    Firefox Add-ons
//   extensions/agentic-routines-<v>-sources.zip    The source Firefox Add-ons asks for
//   cli/agentic-routines-<v>.tgz                   The npm package
//   NOTES.md, SHA256SUMS, RELEASE.json             Notes, and what was built from which commit
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { out, releases, root, run, sha256, version } from './lib.mjs';

const dirty = out('git', ['status', '--porcelain', '--', '.', ':!releases']);
if (dirty && !process.argv.includes('--allow-dirty')) {
  console.error('Uncommitted changes outside releases/. Commit them first, or pass --allow-dirty for a trial build.\n' + dirty);
  process.exit(1);
}

const v = version();
const commit = out('git', ['rev-parse', '--short', 'HEAD']);
const dest = join(releases, `v${v}`);
const stage = join(root, '.dev', 'release-build');
rmSync(stage, { recursive: true, force: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(join(dest, 'extensions'), { recursive: true });
mkdirSync(join(dest, 'cli'), { recursive: true });

console.log(`Building ${v} from ${commit}${dirty ? ' (dirty)' : ''}`);
run('pnpm', ['install', '--frozen-lockfile']);
run('pnpm', ['-r', 'typecheck']);
run('pnpm', ['-C', 'packages/cli', 'build']);

// The extension, built for the stores: no dev key, written away from the unpacked build.
const env = { ...process.env, AR_STORE: '1', AR_OUT: stage };
run('pnpm', ['-C', 'packages/extension', 'exec', 'wxt', 'zip'], { env });
run('pnpm', ['-C', 'packages/extension', 'exec', 'wxt', 'zip', '-b', 'firefox', '--mv3'], { env });
run('node', ['releases/scripts/check-store.mjs', stage]);

const names = readdirSync(stage);
const pick = (re) => names.find((n) => re.test(n));
const chrome = pick(/-chrome\.zip$/);
const firefox = pick(/-firefox\.zip$/);
const sources = pick(/-sources\.zip$/);
if (!chrome || !firefox || !sources) {
  console.error(`Expected chrome, firefox and sources zips, found: ${names.join(', ')}`);
  process.exit(1);
}
copyFileSync(join(stage, chrome), join(dest, 'extensions', `agentic-routines-${v}-chrome.zip`));
copyFileSync(join(stage, firefox), join(dest, 'extensions', `agentic-routines-${v}-firefox.zip`));
copyFileSync(join(stage, sources), join(dest, 'extensions', `agentic-routines-${v}-sources.zip`));

run('npm', ['pack', '--pack-destination', join(dest, 'cli')], { cwd: join(root, 'packages', 'cli'), stdio: 'inherit' });

const built = ['extensions', 'cli'].flatMap((d) => readdirSync(join(dest, d)).sort().map((f) => `${d}/${f}`));
const sums = built.map((f) => ({ name: f, sha256: sha256(join(dest, f)) }));
writeFileSync(join(dest, 'SHA256SUMS'), sums.map((s) => `${s.sha256}  ${s.name}`).join('\n') + '\n');
writeFileSync(join(dest, 'RELEASE.json'), JSON.stringify({ version: v, commit, dirty: !!dirty, files: sums }, null, 2) + '\n');

const notes = join(dest, 'NOTES.md');
if (!existsSync(notes)) {
  const prev = out('git', ['tag', '--list', 'v*', '--sort=-v:refname']).split('\n').find((t) => t && t !== `v${v}`);
  const log = out('git', ['log', '--merges', '--format=- %s', prev ? `${prev}..HEAD` : 'HEAD']);
  writeFileSync(notes, `# ${v}\n\nEdit this before publishing. Merged since ${prev ?? 'the start'}:\n\n${log}\n`);
}
rmSync(stage, { recursive: true, force: true });
console.log(`\nDone: releases/v${v}\n` + sums.map((s) => `  ${s.name}`).join('\n'));
