import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import SKILL from '../../../../plugins/agentic-routines/skills/agentic-routines/SKILL.md?text';
import PLUGIN_JSON from '../../../../plugins/agentic-routines/.claude-plugin/plugin.json?text';
import HOOKS_JSON from '../../../../plugins/agentic-routines/hooks/hooks.json?text';
import HOOK_MJS from '../../../../plugins/agentic-routines/hooks/block-other-browsers.mjs?text';
import START_MJS from '../../../../plugins/agentic-routines/hooks/session-start.mjs?text';
import MARKETPLACE_JSON from '../../../../.claude-plugin/marketplace.json?text';
import { paths } from '../paths.ts';

// What `setup` adds on top of the MCP entry so an agent actually uses it: guidance for each agent, a Claude Code
// plugin, and (only when asked) a switch-off for the other browser tools. All of it can be taken back out.

export const SERVER = 'agentic-routines';
export const PLUGIN = 'agentic-routines';
const H = homedir();
const tilde = (p: string) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);

export interface Line {
  ok: boolean;
  name: string;
  detail: string;
}

/** `exclusive`: true turns other browser tools off, false turns them back on, undefined leaves them as they are. */
export interface Mode {
  dry: boolean;
  exclusive?: boolean;
}

// The one text every agent gets. It is the body of the Claude Code skill, so the wording cannot drift.
export const GUIDANCE = SKILL.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
export const START = '<!-- agentic-routines:start -->';
export const END = '<!-- agentic-routines:end -->';
const BLOCK_RE = new RegExp(`${START}[\\s\\S]*?${END}\\n?`);

export function guidanceBlock(): string {
  return `${START}\n<!-- Written by "npx agentic-routines setup". It is replaced when you run setup again and removed by "setup --remove". -->\n${GUIDANCE}\n${END}\n`;
}

/** Insert, replace or delete the marked block and leave the rest of the text as it was. */
export function putBlock(text: string, on: boolean): string {
  if (BLOCK_RE.test(text)) {
    if (on) return text.replace(BLOCK_RE, () => guidanceBlock());
    const rest = text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    return rest ? rest + '\n' : '';
  }
  if (!on) return text;
  return (text.trim() ? text.replace(/\n*$/, '\n\n') : '') + guidanceBlock();
}

export function blockState(text: string): 'none' | 'current' | 'stale' {
  const m = text.match(BLOCK_RE);
  return !m ? 'none' : m[0] === guidanceBlock() ? 'current' : 'stale';
}

// The names of the other browser tool servers come from the hook, so the hook and the config edits agree.
const OTHER_SRC = HOOK_MJS.match(/const OTHER = \/\((.*?)\)\/i/)?.[1] ?? 'playwright';
export const OTHER_BROWSERS = new RegExp(`(${OTHER_SRC})`, 'i');
const isOther = (name: string) => name !== SERVER && !/agentic-routines/i.test(name) && OTHER_BROWSERS.test(name);

// --- files ---

const BAK = '.agentic-routines.bak';

/** Write a file, keeping a copy of how it was the first time we touched it. */
export function save(file: string, content: string) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(file + BAK)) copyFileSync(file, file + BAK);
  writeFileSync(file, content);
}

const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/** The marked block in a Markdown file the agent reads, such as AGENTS.md. */
function markdownBlock(file: string, on: boolean, dry: boolean): boolean {
  const before = read(file);
  if (!on && !existsSync(file)) return false;
  const after = putBlock(before, on);
  if (after === before) return on;
  if (!dry) {
    if (!after.trim() && !before.replace(BLOCK_RE, '').trim()) {
      // The file held only our block: leave no empty file behind.
      rmSync(file, { force: true });
    } else save(file, after);
  }
  return on;
}

// --- what we have switched off, so it can be switched back on ---

interface State {
  claude?: { exclusive?: boolean };
  codex?: { exclusive?: boolean; disabled?: string[] };
  opencode?: { exclusive?: boolean; disabled?: string[] };
}

const stateFile = () => join(paths.root(), 'agents.json');

export function readState(): State {
  try {
    return JSON.parse(read(stateFile())) as State;
  } catch {
    return {};
  }
}

function writeState(s: State, dry: boolean) {
  if (dry) return;
  const empty = !Object.values(s).some((v) => v && (v.exclusive || (v as any).disabled?.length));
  if (empty) rmSync(stateFile(), { force: true });
  else {
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(s, null, 2) + '\n');
  }
}

// --- where each agent keeps things ---

function vscodeUser() {
  return platform() === 'darwin' ? join(H, 'Library/Application Support/Code/User') : platform() === 'win32' ? join(process.env.APPDATA ?? H, 'Code/User') : join(H, '.config/Code/User');
}

export const loc = {
  claudeJson: () => join(H, '.claude.json'),
  claudeHome: () => join(H, '.claude'),
  market: () => join(paths.root(), 'claude-marketplace'),
  codexDir: () => join(H, '.codex'),
  codexConfig: () => join(H, '.codex/config.toml'),
  codexRules: () => join(H, '.codex/AGENTS.md'),
  vscodeUser,
  copilotMcp: () => join(vscodeUser(), 'mcp.json'),
  copilotRules: () => join(vscodeUser(), 'prompts/agentic-routines.instructions.md'),
  opencodeDir: () => join(H, '.config/opencode'),
  opencodeConfig: () => {
    const dir = join(H, '.config/opencode');
    return ['opencode.jsonc', 'opencode.json'].map((f) => join(dir, f)).find(existsSync) ?? join(dir, 'opencode.json');
  },
  opencodeRules: () => join(H, '.config/opencode/AGENTS.md'),
};

export function onPath(cmd: string): boolean {
  try {
    execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const fmt = { insertSpaces: true, tabSize: 2 };
const ok = (name: string, detail: string): Line => ({ ok: true, name, detail });
const note = (name: string, detail: string): Line => ({ ok: false, name, detail });

// --- Claude Code: a plugin with a skill and a hook ---

/** The plugin and its marketplace as a folder, the same layout as this repository. */
export function claudeMarketplaceFiles(): Record<string, string> {
  const hash = createHash('sha256').update(SKILL + HOOKS_JSON + HOOK_MJS + START_MJS + PLUGIN_JSON).digest('hex').slice(0, 8);
  // Claude Code keeps one copy per version, so a changed plugin needs a changed version.
  const manifest = JSON.stringify({ ...JSON.parse(PLUGIN_JSON), version: `${JSON.parse(PLUGIN_JSON).version}+${hash}` }, null, 2) + '\n';
  return {
    '.claude-plugin/marketplace.json': MARKETPLACE_JSON,
    'plugins/agentic-routines/.claude-plugin/plugin.json': manifest,
    'plugins/agentic-routines/skills/agentic-routines/SKILL.md': SKILL,
    'plugins/agentic-routines/hooks/hooks.json': HOOKS_JSON,
    'plugins/agentic-routines/hooks/block-other-browsers.mjs': HOOK_MJS,
    'plugins/agentic-routines/hooks/session-start.mjs': START_MJS,
  };
}

function claude(args: string[]) {
  execFileSync('claude', args, { stdio: 'ignore', timeout: 60_000 });
}

function claudeUninstall() {
  for (const a of [['plugin', 'uninstall', `${PLUGIN}@${PLUGIN}`, '--scope', 'user'], ['plugin', 'marketplace', 'remove', PLUGIN]]) {
    try {
      claude(a);
    } catch {
      // Not there.
    }
  }
}

function installedPlugin(): boolean {
  try {
    return `${PLUGIN}@${PLUGIN}` in (JSON.parse(read(join(loc.claudeHome(), 'plugins/installed_plugins.json'))).plugins ?? {});
  } catch {
    return false;
  }
}

export function claudeGuidance(m: Mode): Line[] {
  const out: Line[] = [];
  if (!onPath('claude')) {
    return [note('Claude Code plugin', `needs the claude command. Then run: claude plugin marketplace add ${tilde(loc.market())} && claude plugin install ${PLUGIN}@${PLUGIN}`)];
  }
  if (!m.dry) {
    rmSync(loc.market(), { recursive: true, force: true });
    for (const [rel, text] of Object.entries(claudeMarketplaceFiles())) {
      mkdirSync(dirname(join(loc.market(), rel)), { recursive: true });
      writeFileSync(join(loc.market(), rel), text);
    }
    claudeUninstall();
    claude(['plugin', 'marketplace', 'add', loc.market()]);
    claude(['plugin', 'install', `${PLUGIN}@${PLUGIN}`, '--scope', 'user']);
  }
  out.push(ok('Claude Code plugin', `${PLUGIN}@${PLUGIN}: skill and hook (${tilde(loc.market())})`));
  const state = readState();
  if (m.exclusive !== undefined) {
    state.claude = m.exclusive ? { exclusive: true } : undefined;
    writeState(state, m.dry);
  }
  out.push(exclusiveLine('Claude Code', m.exclusive ?? state.claude?.exclusive ?? false, 'the hook blocks other browser tools'));
  return out;
}

export function claudeRemove(dry: boolean): Line[] {
  if (!dry) {
    if (onPath('claude')) claudeUninstall();
    rmSync(loc.market(), { recursive: true, force: true });
    const s = readState();
    delete s.claude;
    writeState(s, false);
  }
  return [ok('Claude Code plugin', 'removed')];
}

function exclusiveLine(agent: string, on: boolean, how: string): Line {
  return ok(`${agent} exclusive`, on ? `on: ${how}` : 'off (turn on with: npx agentic-routines setup --exclusive)');
}

// --- Codex: AGENTS.md block, and other browser servers switched off ---

/** Switch the other browser servers off or back on in a config object. Returns the names it changed. */
function toggleServers(servers: Record<string, any> | undefined, on: boolean, restore: string[]): string[] {
  if (!servers) return [];
  const changed: string[] = [];
  if (on) {
    for (const [name, def] of Object.entries(servers)) {
      if (isOther(name) && def && def.enabled !== false) changed.push(name);
    }
  } else {
    for (const name of restore) if (servers[name] && servers[name].enabled === false) changed.push(name);
  }
  return changed;
}

function exclusiveCodex(on: boolean, dry: boolean): string[] {
  const file = loc.codexConfig();
  if (!existsSync(file)) return [];
  const conf = parseToml(read(file)) as Record<string, any>;
  const state = readState();
  const names = toggleServers(conf.mcp_servers, on, state.codex?.disabled ?? []);
  for (const n of names) {
    if (on) conf.mcp_servers[n].enabled = false;
    else delete conf.mcp_servers[n].enabled;
  }
  if (names.length && !dry) save(file, stringifyToml(conf) + '\n');
  const disabled = on ? [...new Set([...(state.codex?.disabled ?? []), ...names])] : (state.codex?.disabled ?? []).filter((n) => !names.includes(n));
  state.codex = on || disabled.length ? { exclusive: on, disabled } : undefined;
  writeState(state, dry);
  return names;
}

export function codexGuidance(m: Mode): Line[] {
  if (!existsSync(loc.codexDir())) return [];
  markdownBlock(loc.codexRules(), true, m.dry);
  const out = [ok('Codex rules', tilde(loc.codexRules()))];
  let names: string[] = [];
  if (m.exclusive !== undefined) names = exclusiveCodex(m.exclusive, m.dry);
  const on = m.exclusive ?? readState().codex?.exclusive ?? false;
  out.push(exclusiveLine('Codex', on, `other browser servers set to enabled = false${names.length ? ' (' + names.join(', ') + ')' : ''}`));
  return out;
}

export function codexRemove(dry: boolean): Line[] {
  if (!existsSync(loc.codexDir())) return [];
  markdownBlock(loc.codexRules(), false, dry);
  exclusiveCodex(false, dry);
  return [ok('Codex rules', 'removed')];
}

// --- GitHub Copilot in VS Code: a user instructions file ---

const COPILOT_HEAD = `---\napplyTo: '**'\ndescription: Use Agentic Routines for all browser work\n---\n`;

export function copilotGuidance(m: Mode): Line[] {
  if (!existsSync(loc.vscodeUser())) return [];
  const file = loc.copilotRules();
  if (!m.dry) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, COPILOT_HEAD + guidanceBlock());
  }
  const out = [ok('Copilot instructions', tilde(file))];
  if (m.exclusive) out.push(note('Copilot exclusive', 'not available: VS Code has no off switch for a server in mcp.json. Turn the other browser tools off in the Chat tools picker'));
  return out;
}

export function copilotRemove(dry: boolean): Line[] {
  if (!existsSync(loc.vscodeUser())) return [];
  const file = loc.copilotRules();
  // The file is ours alone, but a person may have added to it: keep it if so.
  if (!dry && existsSync(file)) {
    const rest = read(file).replace(BLOCK_RE, '').replace(COPILOT_HEAD, '').trim();
    if (!rest) rmSync(file, { force: true });
    else save(file, putBlock(read(file), false));
  }
  return [ok('Copilot instructions', 'removed')];
}

// --- OpenCode: AGENTS.md block, and other browser servers switched off ---

function exclusiveOpenCode(on: boolean, dry: boolean): string[] {
  const file = loc.opencodeConfig();
  if (!existsSync(file)) return [];
  let text = read(file);
  const conf = (parseJsonc(text) ?? {}) as Record<string, any>;
  const state = readState();
  const names = toggleServers(conf.mcp, on, state.opencode?.disabled ?? []);
  for (const n of names) text = applyEdits(text, modify(text, ['mcp', n, 'enabled'], on ? false : undefined, { formattingOptions: fmt }));
  if (names.length && !dry) save(file, text);
  const disabled = on ? [...new Set([...(state.opencode?.disabled ?? []), ...names])] : (state.opencode?.disabled ?? []).filter((n) => !names.includes(n));
  state.opencode = on || disabled.length ? { exclusive: on, disabled } : undefined;
  writeState(state, dry);
  return names;
}

export function opencodeGuidance(m: Mode): Line[] {
  if (!existsSync(loc.opencodeDir())) return [];
  markdownBlock(loc.opencodeRules(), true, m.dry);
  const out = [ok('OpenCode rules', tilde(loc.opencodeRules()))];
  let names: string[] = [];
  if (m.exclusive !== undefined) names = exclusiveOpenCode(m.exclusive, m.dry);
  const on = m.exclusive ?? readState().opencode?.exclusive ?? false;
  out.push(exclusiveLine('OpenCode', on, `other browser servers set to enabled: false${names.length ? ' (' + names.join(', ') + ')' : ''}`));
  return out;
}

export function opencodeRemove(dry: boolean): Line[] {
  if (!existsSync(loc.opencodeDir())) return [];
  markdownBlock(loc.opencodeRules(), false, dry);
  exclusiveOpenCode(false, dry);
  return [ok('OpenCode rules', 'removed')];
}

// --- doctor ---

function hasServer(file: string, pick: (conf: any) => any): boolean {
  try {
    return Boolean(pick(file.endsWith('.toml') ? parseToml(read(file)) : parseJsonc(read(file)))?.[SERVER]);
  } catch {
    return false;
  }
}

/** Whether each installed agent has the tool server, the guidance and (optionally) exclusivity in place. */
export function agentStatus(): { ok: boolean; name: string; detail: string; optional?: boolean }[] {
  const lines: { ok: boolean; name: string; detail: string; optional?: boolean }[] = [];
  const state = readState();
  const fix = 'Run: npx agentic-routines setup';
  const guidance = (name: string, file: string) => {
    const s = blockState(read(file));
    if (s === 'current') lines.push({ ok: true, name: `${name} rules`, detail: tilde(file) });
    else if (s === 'stale') lines.push({ ok: false, name: `${name} rules`, detail: `out of date. ${fix}` });
    else lines.push({ ok: false, name: `${name} rules`, detail: `missing, so the agent is not told to prefer routines. ${fix}` });
  };
  const exclusive = (name: string, on: boolean | undefined, check?: () => string | null) => {
    const bad = on ? check?.() : null;
    if (bad) lines.push({ ok: false, name: `${name} exclusive`, detail: bad });
    else lines.push({ ok: true, name: `${name} exclusive`, detail: on ? 'on: other browser tools are blocked' : 'off. Turn on with: npx agentic-routines setup --exclusive', optional: !on });
  };

  if (onPath('claude') || existsSync(loc.claudeJson())) {
    lines.push(
      hasServer(loc.claudeJson(), (c) => c.mcpServers) ? { ok: true, name: 'Claude Code', detail: 'tool server added' } : { ok: false, name: 'Claude Code', detail: `tool server missing. ${fix}` },
    );
    const plugin = installedPlugin();
    lines.push(plugin ? { ok: true, name: 'Claude Code plugin', detail: `${PLUGIN}@${PLUGIN}: skill and hook` } : { ok: false, name: 'Claude Code plugin', detail: `not installed, so the agent is not told to prefer routines. ${fix}` });
    exclusive('Claude Code', state.claude?.exclusive, () => (plugin ? null : 'turned on, but the plugin with the hook is not installed. ' + fix));
  }
  if (existsSync(loc.codexDir())) {
    lines.push(hasServer(loc.codexConfig(), (c) => c.mcp_servers) ? { ok: true, name: 'Codex', detail: 'tool server added' } : { ok: false, name: 'Codex', detail: `tool server missing. ${fix}` });
    guidance('Codex', loc.codexRules());
    exclusive('Codex', state.codex?.exclusive, () => {
      const conf = parseToml(read(loc.codexConfig())) as any;
      const still = Object.entries(conf.mcp_servers ?? {}).filter(([n, d]: [string, any]) => isOther(n) && d?.enabled !== false).map(([n]) => n);
      return still.length ? `turned on, but ${still.join(', ')} is enabled again. ${fix} --exclusive` : null;
    });
  }
  if (existsSync(loc.vscodeUser())) {
    lines.push(hasServer(loc.copilotMcp(), (c) => c.servers) ? { ok: true, name: 'GitHub Copilot', detail: 'tool server added' } : { ok: false, name: 'GitHub Copilot', detail: `tool server missing. ${fix}` });
    guidance('Copilot', loc.copilotRules());
    lines.push({ ok: true, name: 'Copilot exclusive', detail: 'not available in VS Code: turn other browser tools off in the Chat tools picker', optional: true });
  }
  if (existsSync(loc.opencodeDir())) {
    lines.push(hasServer(loc.opencodeConfig(), (c) => c.mcp) ? { ok: true, name: 'OpenCode', detail: 'tool server added' } : { ok: false, name: 'OpenCode', detail: `tool server missing. ${fix}` });
    guidance('OpenCode', loc.opencodeRules());
    exclusive('OpenCode', state.opencode?.exclusive, () => {
      const conf = (parseJsonc(read(loc.opencodeConfig())) ?? {}) as any;
      const still = Object.entries(conf.mcp ?? {}).filter(([n, d]: [string, any]) => isOther(n) && d?.enabled !== false).map(([n]) => n);
      return still.length ? `turned on, but ${still.join(', ')} is enabled again. ${fix} --exclusive` : null;
    });
  }
  return lines;
}
