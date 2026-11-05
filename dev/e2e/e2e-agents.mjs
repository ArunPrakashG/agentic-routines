// Functional check of what `setup` tells each agent: the real built CLI against a throwaway HOME with
// Codex, OpenCode and VS Code folders in it (no agent binary on PATH). Covers the marked guidance blocks,
// exclusive mode, doctor, the Claude Code hook and `setup --remove` giving every file back as it was.
// Run `pnpm --filter agentic-routines build` first.   node dev/e2e/e2e-agents.mjs
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const HOOK = join(ROOT, 'plugins/agentic-routines/hooks/block-other-browsers.mjs');
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

const home = mkdtempSync(join(tmpdir(), 'ar-agents-'));
const store = join(home, '.agentic-routines');
const put = (rel, text) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const get = (rel) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : null);
const orig = {
  '.codex/config.toml': 'model = "gpt-5"\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp"]\n',
  '.codex/AGENTS.md': '# Mine\nBe terse.\n',
  '.config/opencode/opencode.jsonc': '{\n  // keep me\n  "theme": "dark",\n  "mcp": { "chrome-devtools": { "type": "local", "command": ["npx", "x"] } }\n}\n',
  '.config/Code/User/mcp.json': '{\n  "servers": {}\n}\n',
};
for (const [k, v] of Object.entries(orig)) put(k, v);

// A stand-in `claude` that only records what it was asked, so the plugin commands can be checked without touching a real install.
const bin = join(home, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "$@" >> '${join(home, 'claude.log')}'\n`);
chmodSync(join(bin, 'claude'), 0o755);
const env = { HOME: home, AGENTIC_ROUTINES_HOME: store, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
const run = (cmd, ...args) => spawnSync(process.execPath, [cmd, ...args], { env, encoding: 'utf8', input: '' });
const setup = (...a) => run(CLI, 'setup', ...a);
const hook = (tool) => run(HOOK) && spawnSync(process.execPath, [HOOK], { env, input: JSON.stringify({ tool_name: tool }), encoding: 'utf8' }).stdout;
const blocks = (s) => (s?.match(/agentic-routines:start/g) ?? []).length;

let r = setup('--dry-run', '--exclusive');
check(r.status === 0 && get('.codex/AGENTS.md') === orig['.codex/AGENTS.md'] && !existsSync(store), 'dry run writes nothing');

r = setup();
check(r.status === 0, 'setup runs');
check(blocks(get('.codex/AGENTS.md')) === 1 && get('.codex/AGENTS.md').startsWith('# Mine\nBe terse.'), 'Codex: block added after the user\'s own rules');
check(blocks(get('.config/opencode/AGENTS.md')) === 1, 'OpenCode: block added');
check(/applyTo/.test(get('.config/Code/User/prompts/agentic-routines.instructions.md') ?? ''), 'Copilot: instructions file written');
const g = (s) => s.slice(s.indexOf('## Agentic Routines'), s.indexOf('<!-- agentic-routines:end'));
check(g(get('.codex/AGENTS.md')) === g(get('.config/opencode/AGENTS.md')) && g(get('.codex/AGENTS.md')) === g(get('.config/Code/User/prompts/agentic-routines.instructions.md')), 'the three agents get identical wording');
for (const t of ['routines_search', 'routines_list', 'routine_propose', 'rt_<name>', 'routine_run']) check(get('.codex/AGENTS.md').includes(t), `wording names ${t}`);
const log = get('claude.log') ?? '';
check(/plugin marketplace add .*claude-marketplace/.test(log) && /plugin install agentic-routines@agentic-routines --scope user/.test(log), 'Claude Code: plugin added from the local marketplace and installed');
check(['.claude-plugin/marketplace.json', 'plugins/agentic-routines/skills/agentic-routines/SKILL.md', 'plugins/agentic-routines/hooks/hooks.json', 'plugins/agentic-routines/hooks/block-other-browsers.mjs', 'plugins/agentic-routines/hooks/session-start.mjs', 'plugins/agentic-routines/.claude-plugin/plugin.json'].every((f) => existsSync(join(store, 'claude-marketplace', f))), 'Claude Code: the marketplace folder has the skill and both hooks');
check(/playwright/.test(get('.codex/config.toml')) && !/enabled = false/.test(get('.codex/config.toml')), 'without --exclusive other browser servers are left on');

setup();
check(blocks(get('.codex/AGENTS.md')) === 1 && blocks(get('.config/opencode/AGENTS.md')) === 1, 'running setup again does not duplicate the blocks');
check(existsSync(join(home, '.codex/config.toml.agentic-routines.bak')), 'a backup of the config was kept');

check(hook('mcp__playwright__browser_click') === '', 'hook: allows everything when exclusive is off');

setup('--exclusive');
check(/enabled = false/.test(get('.codex/config.toml')), 'Codex: --exclusive turns the playwright server off');
check(/"enabled": false/.test(get('.config/opencode/opencode.jsonc')) && get('.config/opencode/opencode.jsonc').includes('// keep me'), 'OpenCode: --exclusive turns chrome-devtools off, comments kept');
const denied = JSON.parse(hook('mcp__claude-in-chrome__navigate') || '{}');
check(denied.hookSpecificOutput?.permissionDecision === 'deny' && /agentic-routines/.test(denied.hookSpecificOutput.permissionDecisionReason), 'hook: blocks Claude in Chrome and says why');
check(hook('mcp__plugin_x_playwright__browser_click') !== '', 'hook: blocks a Playwright server from a plugin');
for (const t of ['Bash', 'WebFetch', 'Read', 'mcp__agentic-routines__navigate', 'mcp__github__list_issues']) check(hook(t) === '', `hook: never blocks ${t}`);
r = run(CLI, 'doctor');
check(/Codex rules\s+~/.test(r.stdout) && /Codex exclusive\s+on/.test(r.stdout) && /OpenCode exclusive\s+on/.test(r.stdout), 'doctor: reports guidance and exclusive mode');

setup('--no-exclusive');
check(!/enabled = false/.test(get('.codex/config.toml')) && !/"enabled": false/.test(get('.config/opencode/opencode.jsonc')), '--no-exclusive turns them back on');
check(hook('mcp__claude-in-chrome__navigate') === '', 'hook: allows again after --no-exclusive');

setup('--exclusive');
r = setup('--remove');
check(r.status === 0, 'setup --remove runs');
check(get('.codex/AGENTS.md') === orig['.codex/AGENTS.md'], 'Codex rules: back to how they were');
check(get('.config/opencode/AGENTS.md') === null && get('.config/Code/User/prompts/agentic-routines.instructions.md') === null, 'OpenCode and Copilot files removed');
check(!/agentic-routines|enabled/.test(get('.codex/config.toml')), 'Codex config: our server gone, playwright back on');
check(!/agentic-routines|"enabled"/.test(get('.config/opencode/opencode.jsonc')) && get('.config/opencode/opencode.jsonc').includes('// keep me'), 'OpenCode config: our server gone, chrome-devtools back on');
check(!/agentic-routines/.test(get('.config/Code/User/mcp.json')), 'Copilot config: our server gone');
check(!existsSync(join(store, 'agents.json')) && !existsSync(join(store, 'claude-marketplace')) && /plugin uninstall agentic-routines@agentic-routines/.test(get('claude.log')), 'plugin uninstalled, state file and marketplace folder removed');

rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
