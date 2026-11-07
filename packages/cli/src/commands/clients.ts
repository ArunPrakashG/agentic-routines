import { randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { isMap, parseDocument } from 'yaml';
import { paths } from '../paths.ts';
import { SERVER, loc } from './agents.ts';

// Every agent `setup` can connect, by the name `--agent` takes. Claude Code, Codex, VS Code and OpenCode are also told
// how to use it (see agents.ts); the rest get the server entry, and the server's own instructions do the telling.
// User-level config only: never a project, workspace or managed one.

const H = () => homedir();
const at = (...p: string[]) => join(H(), ...p);
const env = process.env;
const xdg = () => env.XDG_CONFIG_HOME ?? at('.config');
const support = () => (platform() === 'darwin' ? at('Library/Application Support') : platform() === 'win32' ? (env.APPDATA ?? at('AppData/Roaming')) : xdg());
const first = (...files: string[]) => files.find(existsSync) ?? files[0];

/** On PATH, looked up by hand: asking `which` thirty times is slow. */
function bin(name: string): boolean {
  const exts = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (env.PATH ?? '').split(delimiter).some((d) => d && exts.some((e) => existsSync(join(d, name + e))));
}
const app = (name: string) => platform() === 'darwin' && ['/Applications', at('Applications')].some((d) => existsSync(join(d, `${name}.app`)));

type Entry = Record<string, unknown>;
type Shape = (command: string, args: string[]) => Entry;
const plain: Shape = (command, args) => ({ command, args });
const stdio: Shape = (command, args) => ({ type: 'stdio', command, args });

export interface Client {
  id: string;
  label: string;
  /** Connected by setup.ts itself, with guidance on top. */
  builtin?: boolean;
  format?: 'json' | 'toml' | 'yaml';
  /** The key that holds the servers. A dotted name is one literal key, as in Amp's settings. */
  key?: string;
  /** Vibe's servers are a list of tables, not a map. */
  list?: boolean;
  shape?: Shape;
  file: () => string;
  found: () => boolean;
}

const client = (id: string, label: string, file: () => string, opts: { bin?: string; app?: string; dirs?: () => string[]; format?: Client['format']; key?: string; list?: boolean; shape?: Shape } = {}): Client => ({
  id,
  label,
  format: opts.format ?? 'json',
  key: opts.key ?? 'mcpServers',
  list: opts.list,
  shape: opts.shape ?? plain,
  file,
  found: () => (!!opts.bin && bin(opts.bin)) || (!!opts.app && app(opts.app)) || existsSync(file()) || (opts.dirs?.() ?? [dirname(file())]).some(existsSync),
});

const code = () => join(support(), 'Code/User/globalStorage');
const cline = () => env.CLINE_DIR ?? at('.cline');
const clineExt = () => join(code(), 'saoudrizwan.claude-dev');
const roo = () => join(code(), 'rooveterinaryinc.roo-cline');
const windsurf = () => {
  const own = at('.codeium/windsurf/mcp_config.json');
  const cascade = join(platform() === 'win32' ? support() : xdg(), 'devin/mcp_config.json');
  return existsSync(own) || !existsSync(cascade) ? own : cascade;
};
const goose = () => (env.GOOSE_PATH_ROOT ? join(env.GOOSE_PATH_ROOT, 'config') : platform() === 'win32' ? join(support(), 'Block/goose/config') : join(xdg(), 'goose'));
const zed = () => (platform() === 'win32' ? join(support(), 'Zed') : join(xdg(), 'zed'));

export const CLIENTS: Client[] = [
  { id: 'claude', label: 'Claude Code', builtin: true, file: () => loc.claudeJson(), found: () => bin('claude') || existsSync(loc.claudeJson()) },
  { id: 'codex', label: 'Codex', builtin: true, file: () => loc.codexConfig(), found: () => existsSync(loc.codexDir()) },
  { id: 'vscode', label: 'VS Code with GitHub Copilot', builtin: true, file: () => loc.copilotMcp(), found: () => existsSync(loc.vscodeUser()) },
  { id: 'opencode', label: 'OpenCode', builtin: true, file: () => loc.opencodeConfig(), found: () => existsSync(loc.opencodeDir()) },
  client('cursor', 'Cursor', () => at('.cursor/mcp.json'), { bin: 'cursor', app: 'Cursor', dirs: () => [at('.cursor')] }),
  client('windsurf', 'Windsurf', windsurf, { bin: 'windsurf', app: 'Windsurf', dirs: () => [at('.codeium/windsurf'), dirname(windsurf())] }),
  client('claude-desktop', 'Claude Desktop', () => join(support(), 'Claude/claude_desktop_config.json'), { app: 'Claude' }),
  client('gemini', 'Gemini CLI', () => join(env.GEMINI_CLI_HOME ?? H(), '.gemini/settings.json'), { bin: 'gemini' }),
  client('zed', 'Zed', () => join(zed(), 'settings.json'), { bin: 'zed', app: 'Zed', key: 'context_servers' }),
  client('cline', 'Cline', () => env.CLINE_MCP_SETTINGS_PATH ?? first(join(env.CLINE_DATA_DIR ?? join(cline(), 'data'), 'settings/cline_mcp_settings.json'), join(clineExt(), 'settings/cline_mcp_settings.json')), { bin: 'cline', dirs: () => [cline(), clineExt()] }),
  client('roo', 'Roo Code', () => join(roo(), 'settings/mcp_settings.json'), { dirs: () => [roo(), at('.roo')] }),
  client('kilo', 'Kilo Code', () => first(...['kilo.json', 'kilo.jsonc', 'config.json'].map((f) => join(xdg(), 'kilo', f))), { bin: 'kilo', key: 'mcp', shape: (command, args) => ({ type: 'local', command: [command, ...args] }) }),
  // A replay can wait at a pause for longer than Goose's default.
  client('goose', 'Goose', () => join(goose(), 'config.yaml'), { bin: 'goose', app: 'Goose', format: 'yaml', key: 'extensions', shape: (command, args) => ({ type: 'stdio', name: SERVER, enabled: true, cmd: command, args, timeout: 900 }) }),
  client('amp', 'Amp', () => first(at('.config/amp/settings.json'), at('.config/amp/settings.jsonc')), { bin: 'amp', key: 'amp.mcpServers' }),
  client('kiro', 'Kiro', () => at('.kiro/settings/mcp.json'), { bin: 'kiro-cli', app: 'Kiro', dirs: () => [at('.kiro')] }),
  client('droid', 'Factory Droid', () => at('.factory/mcp.json'), { bin: 'droid', shape: stdio }),
  client('copilot', 'GitHub Copilot CLI', () => join(env.COPILOT_HOME ?? at('.copilot'), 'mcp-config.json'), { bin: 'copilot', shape: (command, args) => ({ type: 'local', command, args, tools: ['*'] }) }),
  client('warp', 'Warp', () => at('.warp/.mcp.json'), { bin: 'warp', app: 'Warp', dirs: () => [at('.warp'), join(xdg(), 'warp-terminal')] }),
  client('lm-studio', 'LM Studio', () => at('.lmstudio/mcp.json'), { bin: 'lms', app: 'LM Studio' }),
  client('qwen-code', 'Qwen Code', () => at('.qwen/settings.json'), { bin: 'qwen' }),
  client('kimi', 'Kimi Code CLI', () => join(env.KIMI_SHARE_DIR ?? at('.kimi'), 'mcp.json'), { bin: 'kimi' }),
  client('augment', 'Augment', () => at('.augment/settings.json'), { bin: 'auggie' }),
  client('antigravity', 'Antigravity', () => at('.gemini/config/mcp_config.json'), { bin: 'agy', app: 'Antigravity', dirs: () => [at('.gemini/antigravity'), at('.gemini/antigravity-cli')] }),
  client('junie', 'Junie', () => at('.junie/mcp/mcp.json'), { bin: 'junie', dirs: () => [at('.junie')] }),
  client('codebuddy', 'CodeBuddy Code', () => first(at('.codebuddy/.mcp.json'), at('.codebuddy/mcp.json')), { bin: 'codebuddy', shape: stdio }),
  client('cortex', 'Cortex Code', () => at('.snowflake/cortex/mcp.json'), { bin: 'cortex', shape: stdio }),
  client('hermes', 'Hermes Agent', () => join(env.HERMES_HOME ?? at('.hermes'), 'config.yaml'), { bin: 'hermes', format: 'yaml', key: 'mcp_servers' }),
  client('grok', 'Grok Build', () => join(env.GROK_HOME ?? at('.grok'), 'config.toml'), { bin: 'grok', format: 'toml', key: 'mcp_servers' }),
  client('vibe', 'Mistral Vibe', () => join(env.VIBE_HOME ?? at('.vibe'), 'config.toml'), { bin: 'vibe', format: 'toml', key: 'mcp_servers', list: true, shape: (command, args) => ({ name: SERVER, transport: 'stdio', command, args }) }),
  client('qoder', 'Qoder CLI', () => at('.qoder/settings.json'), { bin: 'qoder', app: 'Qoder' }),
];

const ALIASES: Record<string, string> = {
  'claude-code': 'claude', 'gemini-cli': 'gemini', 'roo-code': 'roo', 'kilo-code': 'kilo', 'kiro-cli': 'kiro', 'factory-droid': 'droid',
  'github-copilot': 'vscode', 'copilot-cli': 'copilot', lmstudio: 'lm-studio', qwen: 'qwen-code', 'kimi-code-cli': 'kimi', 'hermes-agent': 'hermes',
  'mistral-vibe': 'vibe', 'antigravity-cli': 'antigravity',
};
export const clientById = (id: string) => CLIENTS.find((c) => c.id === (Object.hasOwn(ALIASES, id) ? ALIASES[id] : id));

/** Shell markers of the agent running us, not what is installed. A plain VS Code terminal is not its agent. */
export function callingClient(e: NodeJS.ProcessEnv = process.env): Client | undefined {
  if (e.CLAUDECODE === '1' || e.CLAUDE_CODE_ENTRYPOINT) return clientById('claude');
  if (e.CODEX_THREAD_ID) return clientById('codex');
  if (e.CURSOR_AGENT) return clientById('cursor');
  if (e.AI_AGENT === 'github_copilot_vscode_agent' || (e.COPILOT_AGENT === '1' && e.TERM_PROGRAM === 'vscode')) return clientById('vscode');
  if (e.GEMINI_CLI === '1') return clientById('gemini');
  if (e.AMP_CURRENT_THREAD_ID) return clientById('amp');
  if (e.COPILOT_CLI === '1') return clientById('copilot');
  const named = clientById(e.AI_AGENT?.split('@')[0] ?? '') ?? clientById(e.AGENT ?? '');
  if (named) return named;
  if (e.OPENCODE === '1' || e.OPENCODE_SESSION_ID) return clientById('opencode');
}

export interface AgentFlags {
  named: Client[];
  unknown: string[];
  none: boolean;
  all: boolean;
  yes: boolean;
}

export function agentFlags(args: string[]): AgentFlags {
  const flags: AgentFlags = { named: [], unknown: [], none: false, all: args.includes('--all-agents'), yes: args.includes('--yes') || args.includes('-y') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-a' && args[i] !== '--agent') continue;
    if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error(`${args[i]} needs an agent name, '*' or 'none'. Agents: ${CLIENTS.map((c) => c.id).join(', ')}`);
    while (args[i + 1] && !args[i + 1].startsWith('-')) {
      const a = args[++i];
      const c = clientById(a);
      if (a === '*') flags.all = true;
      else if (a === 'none') flags.none = true;
      else if (c) flags.named.includes(c) || flags.named.push(c);
      else flags.unknown.push(a);
    }
  }
  return flags;
}

// --- what setup wrote, so that removal takes out that and nothing else ---

interface Receipt {
  file: string;
  entry: Entry;
  createdFile: boolean;
  createdKey: boolean;
}
interface Written {
  written: Record<string, Receipt>;
  last?: string[];
}
const receiptsFile = () => join(paths.root(), 'clients.json');

function readReceipts(): Written {
  try {
    return { written: {}, ...JSON.parse(readFileSync(receiptsFile(), 'utf8')) };
  } catch {
    return { written: {} };
  }
}
function writeReceipts(w: Written) {
  mkdirSync(paths.root(), { recursive: true, mode: 0o700 });
  writeFileSync(receiptsFile(), JSON.stringify(w, null, 2) + '\n');
}
export const lastPicked = () => readReceipts().last;
export function rememberPicked(ids: string[]) {
  writeReceipts({ ...readReceipts(), last: ids });
}

// --- editing a config in place ---

const same = (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Beside the target and renamed over it, so a crash leaves no half-written config. A new file is private to the person. */
function writeConfig(file: string, text: string) {
  const exists = existsSync(file);
  mkdirSync(dirname(file), { recursive: true });
  if (exists && !existsSync(file + '.agentic-routines.bak')) copyFileSync(file, file + '.agentic-routines.bak');
  const mode = exists ? statSync(file).mode & 0o777 : 0o600;
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { mode, flag: 'wx' });
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Take the server's section out of TOML text as written, comments elsewhere untouched. Null when it cannot be found as a plain section. */
export function tomlDrop(text: string, key: string, list: boolean): string | null {
  const q = SERVER.replace(/[-]/g, '\\-');
  const re = list
    ? new RegExp(`^\\[\\[${key}\\]\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, 'gm')
    : new RegExp(`^\\[${key}\\.(?:"${q}"|${q})\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, 'm');
  if (!list) {
    const m = text.match(re);
    return m ? text.replace(re, '') : null;
  }
  for (const m of text.matchAll(re)) {
    if (new RegExp(`^name\\s*=\\s*["']${q}["']`, 'm').test(m[0])) return text.slice(0, m.index) + text.slice(m.index + m[0].length);
  }
  return null;
}
/** Add the server's section at the end of TOML text. */
export function tomlAdd(text: string, key: string, list: boolean, entry: Entry): string {
  const block = stringifyToml(list ? { [key]: [entry] } : { [key]: { [SERVER]: entry } }).trimStart();
  return `${text}${text.endsWith('\n') || !text ? '' : '\n'}${text ? '\n' : ''}${block}${block.endsWith('\n') ? '' : '\n'}`;
}

interface Parsed {
  current: unknown;
  hasKey: boolean;
  /** The text with the entry set, or taken out when undefined. */
  put: (entry: Entry | undefined) => string;
  /** The text with the now empty container taken out too. */
  dropKey?: (text: string) => string;
}

function parseConfig(c: Client, text: string): Parsed {
  const key = c.key!;
  const invalid = () => new Error(`${c.file()} is not valid ${c.format}: left unchanged`);
  if (c.format === 'toml') {
    const conf = parseToml(text) as Record<string, any>;
    const box = conf[key];
    if (box !== undefined && (c.list ? !Array.isArray(box) : !isObject(box))) throw invalid();
    const current = c.list ? (box ?? []).find((s: any) => s?.name === SERVER) : box?.[SERVER];
    return {
      current,
      hasKey: box !== undefined,
      put: (entry) => {
        const without = current === undefined ? text : tomlDrop(text, key, !!c.list);
        if (without === null) throw new Error(`could not find the ${SERVER} section as written in ${c.file()}: left unchanged`);
        const after = entry ? tomlAdd(without.replace(/\n+$/, without.trim() ? '\n' : ''), key, !!c.list, entry) : without.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, without.trim() ? '\n' : '');
        // A matching line could sit inside a multiline value. Check the whole result before writing.
        const want = JSON.parse(JSON.stringify(conf));
        if (c.list) {
          want[key] = [...(want[key] ?? []).filter((s: any) => s?.name !== SERVER), ...(entry ? [entry] : [])];
          if (!want[key].length && !entry && parseToml(after)[key] === undefined) delete want[key];
        } else {
          want[key] = { ...(want[key] ?? {}) };
          if (entry) want[key][SERVER] = entry;
          else delete want[key][SERVER];
          if (!Object.keys(want[key]).length && parseToml(after)[key] === undefined) delete want[key];
        }
        if (!same(parseToml(after), want)) throw new Error(`editing ${c.file()} would change other settings: left unchanged`);
        return after;
      },
    };
  }
  if (c.format === 'yaml') {
    const doc = parseDocument(text, { merge: true });
    if (doc.errors.length || doc.warnings.length || (doc.contents !== null && !isMap(doc.contents))) throw invalid();
    const conf = (doc.toJS() ?? {}) as Record<string, any>;
    if (conf[key] !== undefined && !isMap(doc.get(key, true))) throw invalid();
    return {
      current: conf[key]?.[SERVER],
      hasKey: conf[key] !== undefined,
      put: (entry) => {
        if (entry) doc.setIn([key, SERVER], entry);
        else doc.deleteIn([key, SERVER]);
        const after = doc.toString();
        // A shared anchor can make one edit show up elsewhere. Refuse rather than change another entry.
        const want = JSON.parse(JSON.stringify(conf));
        want[key] = { ...(want[key] ?? {}) };
        if (entry) want[key][SERVER] = entry;
        else delete want[key][SERVER];
        const got = parseDocument(after, { merge: true }).toJS() ?? {};
        if (!same(got, want)) throw new Error(`editing ${c.file()} would change other settings: left unchanged`);
        return after;
      },
      dropKey: (t) => {
        const d = parseDocument(t, { merge: true });
        d.deleteIn([key]);
        return isMap(d.contents) && !d.contents.items.length ? '' : d.toString();
      },
    };
  }
  const errors: ParseError[] = [];
  const conf = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length || (conf !== undefined && !isObject(conf))) throw invalid();
  const box = (conf as any)?.[key];
  if (box !== undefined && !isObject(box)) throw invalid();
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  return {
    current: box?.[SERVER],
    hasKey: box !== undefined,
    put: (entry) => applyEdits(text, modify(text, [key, SERVER], entry, fmt)),
    dropKey: (t) => applyEdits(t, modify(t, [key], undefined, fmt)),
  };
}

const empty = (c: Client, text: string): boolean => {
  if (!text.trim()) return true;
  if (c.format === 'toml') return !Object.keys(parseToml(text)).length;
  if (c.format === 'yaml') {
    const v = parseDocument(text).toJS();
    return v === null || (isObject(v) && !Object.keys(v).length);
  }
  const v = parseJsonc(text);
  return isObject(v) && !Object.keys(v).length;
};
const containerEmpty = (c: Client, text: string): boolean => {
  if (c.format === 'toml') {
    const box = (parseToml(text) as any)[c.key!];
    return box === undefined ? false : c.list ? !box.length : !Object.keys(box).length;
  }
  const v = (c.format === 'yaml' ? parseDocument(text, { merge: true }).toJS() : parseJsonc(text)) as any;
  const box = v?.[c.key!];
  return isObject(box) && !Object.keys(box).length;
};

export type Outcome = 'added' | 'updated' | 'unchanged' | 'conflict';

/** Put our entry into one client's config. Someone else's entry under our name is left alone. */
export function addClient(c: Client, cmd: string[], dry: boolean): Outcome {
  const file = c.file();
  const exists = existsSync(file);
  const before = exists ? readFileSync(file, 'utf8') : c.format === 'json' ? '{}\n' : '';
  const parsed = parseConfig(c, before);
  const entry = c.shape!(cmd[0], cmd.slice(1));
  const receipts = readReceipts();
  const mine = receipts.written[c.id];
  if (parsed.current !== undefined && same(parsed.current, entry)) return 'unchanged';
  if (parsed.current !== undefined && !(mine && same(parsed.current, mine.entry))) return 'conflict';
  const after = parsed.put(entry);
  if (dry) return parsed.current === undefined ? 'added' : 'updated';
  writeConfig(file, after);
  receipts.written[c.id] = mine ? { ...mine, file, entry } : { file, entry, createdFile: !exists, createdKey: !parsed.hasKey };
  writeReceipts(receipts);
  return mine && parsed.current !== undefined ? 'updated' : 'added';
}

export type Removal = 'removed' | 'edited' | 'absent';

/** Take out what setup wrote. An entry changed since then is the person's now, and stays. */
export function removeClient(c: Client, dry: boolean): Removal {
  const receipts = readReceipts();
  const mine = receipts.written[c.id];
  if (!mine) return 'absent';
  const forget = () => {
    if (dry) return;
    delete receipts.written[c.id];
    writeReceipts(receipts);
  };
  if (!existsSync(mine.file)) {
    forget();
    return 'absent';
  }
  const before = readFileSync(mine.file, 'utf8');
  const parsed = parseConfig({ ...c, file: () => mine.file }, before);
  if (parsed.current === undefined) {
    forget();
    return 'absent';
  }
  if (!same(parsed.current, mine.entry)) {
    forget();
    return 'edited';
  }
  let after = parsed.put(undefined);
  if (mine.createdKey && parsed.dropKey && containerEmpty(c, after)) after = parsed.dropKey(after);
  if (!dry) {
    const bak = mine.file + '.agentic-routines.bak';
    if (mine.createdFile && empty(c, after)) {
      rmSync(mine.file, { force: true });
      rmSync(bak, { force: true });
    } else {
      writeConfig(mine.file, after);
      // The copy from before we touched it is the same as what is there now: no need to keep it.
      if (existsSync(bak) && same(parseConfig(c, readFileSync(bak, 'utf8')).current ?? null, null) && readFileSync(bak, 'utf8').trim() === after.trim()) rmSync(bak, { force: true });
    }
  }
  forget();
  return 'removed';
}

/** Every client setup wrote to and everything found that it did not, for `doctor`. */
export function clientStatus(): { ok: boolean; name: string; detail: string; optional?: boolean }[] {
  const receipts = readReceipts();
  const lines: { ok: boolean; name: string; detail: string; optional?: boolean }[] = [];
  const others: string[] = [];
  for (const c of CLIENTS) {
    if (c.builtin) continue;
    const mine = receipts.written[c.id];
    if (!mine) {
      if (c.found()) others.push(c.id);
      continue;
    }
    try {
      const there = existsSync(mine.file) && parseConfig({ ...c, file: () => mine.file }, readFileSync(mine.file, 'utf8')).current !== undefined;
      lines.push(there ? { ok: true, name: c.label, detail: 'tool server added' } : { ok: false, name: c.label, detail: `tool server missing. Run: npx agentic-routines setup --agent ${c.id}` });
    } catch (e) {
      lines.push({ ok: false, name: c.label, detail: (e as Error).message });
    }
  }
  if (others.length) lines.push({ ok: true, name: 'More agents found', detail: `Add with: npx agentic-routines setup --agent ${others.join(' ')}`, optional: true });
  return lines;
}

/** What to add by hand for a client setup does not know. */
export function entryByHand(cmd: string[]): string {
  return JSON.stringify({ mcpServers: { [SERVER]: { command: cmd[0], args: cmd.slice(1) } } }, null, 2);
}

// --- the picker ---

/** Type to filter, up and down to move, Space to tick, Enter to confirm, Esc to cancel. Null when cancelled. */
export function pickClients(preset: string[]): Promise<Client[] | null> {
  const { stdin, stdout } = process;
  const on = new Set(preset);
  const found = new Set(CLIENTS.filter((c) => c.found()).map((c) => c.id));
  const all = [...CLIENTS].sort((a, b) => Number(found.has(b.id)) - Number(found.has(a.id)));
  let filter = '';
  let at_ = 0;
  let drawn = 0;
  const ROWS = 12;
  const shown = () => all.filter((c) => !filter || c.id.includes(filter.toLowerCase()) || c.label.toLowerCase().includes(filter.toLowerCase()));
  const draw = () => {
    const list = shown();
    at_ = Math.min(at_, Math.max(0, list.length - 1));
    const top = Math.max(0, Math.min(at_ - Math.floor(ROWS / 2), list.length - ROWS));
    const rows = list.slice(top, top + ROWS).map((c) => {
      const i = list.indexOf(c);
      return `${i === at_ ? '❯' : ' '} ${on.has(c.id) ? '◼' : '◻'} ${c.label}${found.has(c.id) ? '' : ' (not found)'}`;
    });
    const text = [`Which agents should get the browser tools? Space ticks, Enter confirms. Filter: ${filter}`, ...(rows.length ? rows : ['  Nothing matches'])];
    if (drawn) stdout.write(`\x1b[${drawn}A`);
    stdout.write(text.map((l) => `\x1b[2K${l}`).join('\n') + '\n\x1b[J');
    drawn = text.length;
  };
  return new Promise((resolve) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    const done = (v: Client[] | null) => {
      stdin.off('keypress', key);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(v);
    };
    const key = (s: string | undefined, k: { name?: string; ctrl?: boolean }) => {
      if (k.name === 'escape' || (k.ctrl && k.name === 'c')) return done(null);
      if (k.name === 'return') return done(CLIENTS.filter((c) => on.has(c.id)));
      if (k.name === 'up') at_ = Math.max(0, at_ - 1);
      else if (k.name === 'down') at_ = Math.min(shown().length - 1, at_ + 1);
      else if (k.name === 'space') {
        const c = shown()[at_];
        if (c) on.has(c.id) ? on.delete(c.id) : on.add(c.id);
      } else if (k.name === 'backspace') filter = filter.slice(0, -1);
      else if (s && s.length === 1 && s >= ' ' && !k.ctrl) filter += s;
      draw();
    };
    stdin.on('keypress', key);
    draw();
  });
}
