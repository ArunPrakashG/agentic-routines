// Functional check of setup across every agent it knows: the real built CLI against a throwaway HOME, no browser.
// Each config starts with somebody else's server and a comment. Setup must add ours and keep those; removal must take
// out only what setup wrote. Run `pnpm --filter agentic-routines build` first.   node dev/e2e/e2e-clients.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = join(ROOT, 'packages/cli/dist/index.js');
const require = createRequire(join(ROOT, 'packages/cli/package.json'));
const { parse: jsonc } = require('jsonc-parser');
const { parse: toml } = await import(pathToFileURL(require.resolve('smol-toml')).href);
const { parse: yaml } = require('yaml');
let failures = 0;
const check = (ok, what) => {
  console.log(ok ? '✓' : '✗', what);
  if (!ok) failures++;
};

const SERVER = 'agentic-routines';
const J = 'json', T = 'toml', Y = 'yaml';
// Every client: where its config lives under HOME on Linux, its format, and how to reach the servers in it.
const CLIENTS = {
  cursor: ['.cursor/mcp.json', J, 'mcpServers'],
  windsurf: ['.codeium/windsurf/mcp_config.json', J, 'mcpServers'],
  'claude-desktop': ['.config/Claude/claude_desktop_config.json', J, 'mcpServers'],
  gemini: ['.gemini/settings.json', J, 'mcpServers'],
  zed: ['.config/zed/settings.json', J, 'context_servers'],
  cline: ['.cline/data/settings/cline_mcp_settings.json', J, 'mcpServers'],
  roo: ['.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json', J, 'mcpServers'],
  kilo: ['.config/kilo/kilo.json', J, 'mcp'],
  goose: ['.config/goose/config.yaml', Y, 'extensions'],
  amp: ['.config/amp/settings.json', J, 'amp.mcpServers'],
  kiro: ['.kiro/settings/mcp.json', J, 'mcpServers'],
  droid: ['.factory/mcp.json', J, 'mcpServers'],
  copilot: ['.copilot/mcp-config.json', J, 'mcpServers'],
  warp: ['.warp/.mcp.json', J, 'mcpServers'],
  'lm-studio': ['.lmstudio/mcp.json', J, 'mcpServers'],
  'qwen-code': ['.qwen/settings.json', J, 'mcpServers'],
  kimi: ['.kimi/mcp.json', J, 'mcpServers'],
  augment: ['.augment/settings.json', J, 'mcpServers'],
  antigravity: ['.gemini/config/mcp_config.json', J, 'mcpServers'],
  junie: ['.junie/mcp/mcp.json', J, 'mcpServers'],
  codebuddy: ['.codebuddy/.mcp.json', J, 'mcpServers'],
  cortex: ['.snowflake/cortex/mcp.json', J, 'mcpServers'],
  hermes: ['.hermes/config.yaml', Y, 'mcp_servers'],
  grok: ['.grok/config.toml', T, 'mcp_servers'],
  vibe: ['.vibe/config.toml', T, 'mcp_servers'],
  qoder: ['.qoder/settings.json', J, 'mcpServers'],
};
// Claude Code, Codex, VS Code and OpenCode have their own, deeper check in e2e-agents.mjs; here they get the same round trip.
const BUILTIN = {
  codex: ['.codex/config.toml', T, 'mcp_servers'],
  vscode: ['.config/Code/User/mcp.json', J, 'servers'],
  opencode: ['.config/opencode/opencode.jsonc', J, 'mcp'],
  claude: ['.claude.json', J, 'mcpServers'],
};

const start = (id, fmt, key) => {
  if (fmt === T) return id === 'vibe' ? `# keep me\ntheme = "dark"\n\n[[${key}]]\nname = "other"\ncommand = "other"\n` : `# keep me\ntheme = "dark"\n\n[${key}.other]\ncommand = "other"\n`;
  if (fmt === Y) return `# keep me\ntheme: dark\n${key}:\n  other:\n    command: other\n`;
  return `{\n  // keep me\n  "theme": "dark",\n  "${key}": { "other": { "command": "other" } }\n}\n`;
};
const parse = (fmt, text) => (fmt === T ? toml(text) : fmt === Y ? yaml(text) : jsonc(text));
const servers = (id, fmt, text, key) => parse(fmt, text)?.[key];
const has = (box, name, id) => (id === 'vibe' ? (box ?? []).some((s) => s.name === name) : !!box?.[name]);

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'ar-clients-'));
  const env = { HOME: home, AGENTIC_ROUTINES_HOME: join(home, 'store'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: join(home, '.config') };
  const setup = (...a) => spawnSync(process.execPath, [CLI, 'setup', ...a], { env, encoding: 'utf8', input: '' });
  const put = (rel, text) => {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  };
  return { home, setup, put, get: (rel) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : null), done: () => rmSync(home, { recursive: true, force: true }) };
}

for (const [id, [rel, fmt, key]] of Object.entries({ ...CLIENTS, ...BUILTIN })) {
  const h = fresh();
  const orig = start(id, fmt, key);
  h.put(rel, orig);
  const a = h.setup('--agent', id, '--no-exclusive');
  const text = h.get(rel);
  const box = text && servers(id, fmt, text, key);
  check(a.status === 0 && has(box, SERVER, id) && has(box, 'other', id) && parse(fmt, text).theme === 'dark', `${id}: added next to what was there`);
  check(text.includes('keep me'), `${id}: comment kept`);
  const again = h.setup('--agent', id, '--no-exclusive');
  check(again.status === 0 && servers(id, fmt, h.get(rel), key) && (h.get(rel).match(new RegExp(SERVER, 'g')) ?? []).length === (text.match(new RegExp(SERVER, 'g')) ?? []).length, `${id}: running again adds nothing`);
  const r = h.setup('--remove', '--agent', id);
  const after = h.get(rel);
  const left = after && servers(id, fmt, after, key);
  check(r.status === 0 && !has(left, SERVER, id) && has(left, 'other', id) && after.includes('keep me'), `${id}: removal takes out ours and nothing else`);
  h.done();
}

// With no config there yet, removal leaves nothing behind.
for (const [id, [rel, fmt, key]] of Object.entries(CLIENTS)) {
  const h = fresh();
  h.setup('--agent', id);
  const made = h.get(rel);
  h.setup('--remove', '--agent', id);
  check(made !== null && has(servers(id, fmt, made, key), SERVER, id) && h.get(rel) === null, `${id}: a config setup created goes away again`);
  h.done();
}

// Detection, --yes and --all-agents only touch what is found.
{
  const h = fresh();
  h.put('.cursor/mcp.json', '{}\n');
  h.put('.grok/config.toml', '');
  const r = h.setup('--yes');
  check(r.status === 0 && h.get('.cursor/mcp.json').includes(SERVER) && h.get('.grok/config.toml').includes(SERVER), '--yes connects what it finds');
  check(h.get('.gemini/settings.json') === null && h.get('.goose/config.yaml') === null, '--yes leaves what it does not find');
  h.done();
  const k = fresh();
  k.put('.factory/mcp.json', '{}\n');
  check(k.setup('--all-agents').status === 0 && k.get('.factory/mcp.json').includes(SERVER) && k.get('.kiro/settings/mcp.json') === null, '--all-agents is every agent found');
  k.done();
}

// An entry a person has changed is theirs: neither overwritten nor removed.
{
  const h = fresh();
  h.put('.cursor/mcp.json', `{ "mcpServers": { "${SERVER}": { "command": "mine" } } }\n`);
  const r = h.setup('--agent', 'cursor');
  check(/different/.test(r.stdout) && jsonc(h.get('.cursor/mcp.json')).mcpServers[SERVER].command === 'mine', 'an entry it did not write is left alone');
  h.setup('--remove', '--agent', 'cursor');
  check(jsonc(h.get('.cursor/mcp.json')).mcpServers[SERVER].command === 'mine', 'and removal leaves it too');
  h.done();
  const k = fresh();
  k.setup('--agent', 'cursor');
  const conf = jsonc(k.get('.cursor/mcp.json'));
  conf.mcpServers[SERVER].args.push('--mine');
  k.put('.cursor/mcp.json', JSON.stringify(conf));
  const out = k.setup('--remove', '--agent', 'cursor');
  check(/changed since/.test(out.stdout) && !!jsonc(k.get('.cursor/mcp.json')).mcpServers[SERVER], 'an entry changed after setup wrote it stays');
  k.done();
}

// A broken config is refused, not overwritten.
for (const [id, rel, bad] of [['cursor', '.cursor/mcp.json', '{ broken'], ['grok', '.grok/config.toml', '= broken'], ['hermes', '.hermes/config.yaml', 'a: [broken']]) {
  const h = fresh();
  h.put(rel, bad);
  const r = h.setup('--agent', id);
  check(h.get(rel) === bad && !r.stdout.includes(`✓ ${id}`), `${id}: broken config left unchanged`);
  h.done();
}

// A client it cannot identify gets the entry to add by hand, and no config changes.
{
  const h = fresh();
  h.put('.cursor/mcp.json', '{}\n');
  const byName = h.setup('--agent', 'someagent');
  check(/does not know "someagent"/.test(byName.stdout) && byName.stdout.includes(`"${SERVER}"`), 'an unknown name gets the entry printed');
  const blind = h.setup();
  check(/no agent config was changed/.test(blind.stdout) && blind.stdout.includes('--agent cursor') && h.get('.cursor/mcp.json') === '{}\n', 'no terminal and no caller prints it too, and writes nothing');
  const none = h.setup('--agent', 'none');
  check(none.stdout.includes(`"${SERVER}"`) && h.get('.cursor/mcp.json') === '{}\n', '--agent none prints it');
  h.done();
}

// Inside a recognized agent, setup connects that agent alone.
{
  const h = fresh();
  h.put('.cursor/mcp.json', '{}\n');
  h.put('.gemini/settings.json', '{}\n');
  const env = { HOME: h.home, AGENTIC_ROUTINES_HOME: join(h.home, 'store'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, XDG_CONFIG_HOME: join(h.home, '.config'), GEMINI_CLI: '1' };
  spawnSync(process.execPath, [CLI, 'setup'], { env, encoding: 'utf8', input: '' });
  check(h.get('.gemini/settings.json').includes(SERVER) && h.get('.cursor/mcp.json') === '{}\n', 'an agent running setup connects itself');
  h.done();
}

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
