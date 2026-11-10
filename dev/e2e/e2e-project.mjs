// Functional check of project routines: the built CLI against a throwaway home and Git repository.
// Run `pnpm --filter agentic-routines build` first.
//   node dev/e2e/e2e-project.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../packages/cli/dist/index.js');
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};
const t = mkdtempSync(join(tmpdir(), 'ar-project-'));
const home = join(t, 'home');
const repo = join(t, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
mkdirSync(join(t, 'uhome'));
spawnSync('git', ['init', '-q'], { cwd: repo });
const run = (args, cwd = repo, input) => spawnSync(process.execPath, [CLI, ...args], { cwd, input, timeout: 15000, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: join(t, 'uhome'), AGENTIC_ROUTINES_HOME: home } });

const dir = join(home, 'routines/local/deploy-staging');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'steps.json'), JSON.stringify([{ n: 1, label: 'Open', action: 'navigate', url: 'https://staging.acme.com/deploys' }, { n: 2, label: 'Version', action: 'type', value: '{{version}}' }, { n: 3, label: 'Start', action: 'click' }]));
const md = (extra = '') => `---\nname: deploy-staging\nversion: 1\nsite: staging.acme.com\ndescription: Deploy the latest build to staging. Use when asked to push to staging.\nparams:\n  version:\n    type: string\n    example: 2.15.0-private\nsecrets: []\npauses:\n  - 3\n---\n\nDeploys.${extra}\n`;
writeFileSync(join(dir, 'ROUTINE.md'), md());
const file = join(repo, '.agentic-routines/routines/deploy-staging.md');

check(/No .agentic-routines folder/.test(run(['project'], join(repo, 'src')).stdout), 'a repository with no shared routines says so');
check(run(['project', 'add', 'deploy-staging'], t).status !== 0, 'outside a repository, adding is refused');
let r = run(['project', 'add', 'deploy-staging'], join(repo, 'src'));
check(r.status === 0 && existsSync(file) && existsSync(join(repo, '.agentic-routines/README.md')), 'adding from a subfolder writes the file at the repository root');
check(!readFileSync(file, 'utf8').includes('2.15.0-private'), 'example values stay out of the repository');
check(/already up to date/.test(run(['project', 'add', 'deploy-staging']).stdout), 'adding the same routine again changes nothing');
writeFileSync(join(dir, 'ROUTINE.md'), md(' And waits.'));
r = run(['project', 'add', 'deploy-staging']);
check(/Updated/.test(r.stdout) && /^version: 2$/m.test(readFileSync(file, 'utf8')), 'a changed routine becomes the next version');

r = run(['project'], join(repo, 'src'));
check(/deploy-staging v2 .*not installed here/.test(r.stdout), 'status says it is not installed here');
const sources = JSON.parse(readFileSync(join(home, 'sources.json'), 'utf8'));
check(sources.sources.length === 1 && sources.sources[0].project === true && sources.sources[0].enabled, 'it is listed as a project source, which installs nothing');
check(!existsSync(join(home, 'routines/folder_repo')) && !run(['sources']).stdout.includes('could not be read'), 'and nothing was installed');

// The agent's server tells the agent about it.
const init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}\n';
r = run(['mcp'], join(repo, 'src'), init);
check(/shares routines in \.agentic-routines\/routines: deploy-staging/.test(r.stdout) && /Not installed on this computer yet/.test(r.stdout), 'an agent started in the repository is told which routines it has and that they are not installed');

// A routine installed from the folder shows as installed, then changed when the file changes.
const origin = (ref) => JSON.stringify({ kind: 'folder', source: join(repo, '.agentic-routines'), path: 'routines/deploy-staging.md', ref });
const copy = join(home, 'routines/folder_repo-test/deploy-staging');
mkdirSync(copy, { recursive: true });
writeFileSync(join(copy, 'steps.json'), '[]');
writeFileSync(join(copy, 'ROUTINE.md'), md());
writeFileSync(join(copy, '.origin.json'), origin('old'));
check(/installed, but the file has changed/.test(run(['project']).stdout), 'a routine installed before the file changed shows as changed');

// A secret is not written into a repository.
const bad = join(home, 'routines/local/leaky');
mkdirSync(bad, { recursive: true });
writeFileSync(join(bad, 'steps.json'), JSON.stringify([{ n: 1, label: 'Open', action: 'navigate', url: 'https://staging.acme.com/' }, { n: 2, label: 'Key', action: 'type', value: 'sk-abcdefghijklmnopqrstuvwxyz123456' }]));
writeFileSync(join(bad, 'ROUTINE.md'), md().replace('deploy-staging', 'leaky'));
r = run(['project', 'add', 'leaky']);
check(r.status !== 0 && !existsSync(join(repo, '.agentic-routines/routines/leaky.md')), 'a routine with a secret in it is refused');

r = run(['project', 'remove', 'deploy-staging']);
check(r.status === 0 && !existsSync(file), 'a shared routine can be removed');

// A removed project source stays removed.
run(['sources', 'remove', join(repo, '.agentic-routines')]);
run(['project', 'add', 'deploy-staging']);
run(['mcp'], repo, init);
check(JSON.parse(readFileSync(join(home, 'sources.json'), 'utf8')).sources.length === 0, 'a project the person removed is not added again');

// The folder the app keeps in the home folder is not a project.
mkdirSync(join(t, 'uhome/.agentic-routines/routines'), { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: join(t, 'uhome') });
check(/No .agentic-routines folder/.test(run(['project'], join(t, 'uhome')).stdout), 'the app\'s own folder in the home folder is never a project');

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
