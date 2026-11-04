import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { HOST_NAME, paths } from './paths.ts';

// `npx browser-routines setup`: register the native host with every browser
// found, and add the MCP server to every agent found.

export const EXTENSION_IDS = {
  // Pinned by the public key in the extension manifest; store ids are added at release.
  chrome: ['fafmcnlaedchfncjiimcndjlfphdfkdo'],
  firefox: ['browser-routines@browser-routines.dev'],
};

const SERVER = 'browser-routines';
const H = homedir();
const tilde = (p: string) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);

function mcpCommand(): string[] {
  const script = realpathSync(process.argv[1]);
  if (script.includes(`${'_npx'}`)) return ['npx', '-y', 'browser-routines', 'mcp'];
  return [process.execPath, script, 'mcp'];
}

function hostCommand(): string[] {
  return [process.execPath, realpathSync(process.argv[1]), 'host'];
}

interface Line {
  ok: boolean;
  name: string;
  detail: string;
}

async function writeHostWrapper(): Promise<string> {
  await mkdir(paths.bin(), { recursive: true, mode: 0o700 });
  const [node, script] = hostCommand();
  if (platform() === 'win32') {
    const p = join(paths.bin(), 'host.bat');
    await writeFile(p, `@echo off\r\n"${node}" "${script}" host %*\r\n`);
    return p;
  }
  const p = join(paths.bin(), 'host');
  await writeFile(p, `#!/bin/sh\nexec "${node}" "${script}" host "$@"\n`);
  await chmod(p, 0o755);
  return p;
}

function browserDirs(): { name: string; dir: string; firefox?: boolean }[] {
  const mac = platform() === 'darwin';
  const base = mac ? join(H, 'Library/Application Support') : join(H, '.config');
  const chromium: [string, string][] = mac
    ? [
        ['Chrome', 'Google/Chrome'],
        ['Chromium', 'Chromium'],
        ['Edge', 'Microsoft Edge'],
        ['Brave', 'BraveSoftware/Brave-Browser'],
        ['Vivaldi', 'Vivaldi'],
        ['Arc', 'Arc/User Data'],
      ]
    : [
        ['Chrome', 'google-chrome'],
        ['Chromium', 'chromium'],
        ['Edge', 'microsoft-edge'],
        ['Brave', 'BraveSoftware/Brave-Browser'],
        ['Vivaldi', 'vivaldi'],
      ];
  const out = chromium.map(([name, d]) => ({ name, dir: join(base, d) }));
  out.push({ name: 'Firefox', dir: mac ? join(base, 'Mozilla') : join(H, '.mozilla'), firefox: true } as any);
  return out;
}

async function registerHost(dry: boolean): Promise<Line[]> {
  if (platform() === 'win32') return [{ ok: false, name: 'Browsers', detail: 'Windows needs registry entries; not supported by setup yet' }];
  const wrapper = dry ? join(paths.bin(), 'host') : await writeHostWrapper();
  const lines: Line[] = [];
  for (const b of browserDirs()) {
    if (!existsSync(b.dir)) continue;
    const target = join(b.dir, b.firefox ? 'native-messaging-hosts' : 'NativeMessagingHosts', `${HOST_NAME}.json`);
    const manifest = {
      name: HOST_NAME,
      description: 'Browser Routines',
      path: wrapper,
      type: 'stdio',
      ...(b.firefox ? { allowed_extensions: EXTENSION_IDS.firefox } : { allowed_origins: EXTENSION_IDS.chrome.map((id) => `chrome-extension://${id}/`) }),
    };
    if (!dry) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(manifest, null, 2) + '\n');
    }
    lines.push({ ok: true, name: b.name, detail: tilde(target) });
  }
  if (!lines.length) lines.push({ ok: false, name: 'Browsers', detail: 'No Chrome, Edge, Brave or Firefox profile found' });
  return lines;
}

/** Edit JSON or JSONC in place, keeping comments and formatting. */
async function editJson(file: string, path: (string | number)[], value: unknown, dry: boolean) {
  const before = existsSync(file) ? await readFile(file, 'utf8') : '{}\n';
  parseJsonc(before); // Throws nothing; returns undefined on garbage, which modify handles.
  const after = applyEdits(before, modify(before, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  if (!dry && after !== before) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, after);
  }
}

function onPath(cmd: string): boolean {
  try {
    execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function claudeCode(cmd: string[], dry: boolean): Promise<Line | null> {
  const file = join(H, '.claude.json');
  if (onPath('claude')) {
    if (!dry) {
      try {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', SERVER], { stdio: 'ignore' });
      } catch {
        // Not added yet.
      }
      execFileSync('claude', ['mcp', 'add', '--scope', 'user', SERVER, '--', ...cmd], { stdio: 'ignore' });
    }
    return { ok: true, name: 'Claude Code', detail: tilde(file) };
  }
  if (!existsSync(file)) return null;
  await editJson(file, ['mcpServers', SERVER], { type: 'stdio', command: cmd[0], args: cmd.slice(1), env: {} }, dry);
  return { ok: true, name: 'Claude Code', detail: tilde(file) };
}

async function codex(cmd: string[], dry: boolean): Promise<Line | null> {
  const dir = join(H, '.codex');
  if (!existsSync(dir)) return null;
  const file = join(dir, 'config.toml');
  const conf = existsSync(file) ? (parseToml(await readFile(file, 'utf8')) as Record<string, any>) : {};
  conf.mcp_servers ??= {};
  conf.mcp_servers[SERVER] = { command: cmd[0], args: cmd.slice(1) };
  if (!dry) await writeFile(file, stringifyToml(conf) + '\n');
  return { ok: true, name: 'Codex', detail: tilde(file) };
}

async function copilot(cmd: string[], dry: boolean): Promise<Line | null> {
  const user =
    platform() === 'darwin'
      ? join(H, 'Library/Application Support/Code/User')
      : platform() === 'win32'
        ? join(process.env.APPDATA ?? H, 'Code/User')
        : join(H, '.config/Code/User');
  if (!existsSync(user)) return null;
  const file = join(user, 'mcp.json');
  await editJson(file, ['servers', SERVER], { type: 'stdio', command: cmd[0], args: cmd.slice(1) }, dry);
  return { ok: true, name: 'GitHub Copilot', detail: tilde(file) };
}

async function opencode(cmd: string[], dry: boolean): Promise<Line | null> {
  const dir = join(H, '.config/opencode');
  if (!existsSync(dir)) return null;
  const file = ['opencode.jsonc', 'opencode.json'].map((f) => join(dir, f)).find(existsSync) ?? join(dir, 'opencode.json');
  await editJson(file, ['mcp', SERVER], { type: 'local', command: cmd, enabled: true }, dry);
  return { ok: true, name: 'OpenCode', detail: tilde(file) };
}

export async function runSetup(args: string[]): Promise<void> {
  const dry = args.includes('--dry-run');
  const cmd = mcpCommand();
  const out: Line[] = [];
  out.push(...(await registerHost(dry)));
  const agents = [
    ['Claude Code', claudeCode],
    ['Codex', codex],
    ['GitHub Copilot', copilot],
    ['OpenCode', opencode],
  ] as const;
  for (const [name, fn] of agents) {
    try {
      out.push((await fn(cmd, dry)) ?? { ok: false, name, detail: 'not installed' });
    } catch (e) {
      out.push({ ok: false, name, detail: (e as Error).message });
    }
  }
  const w = Math.max(...out.map((l) => l.name.length));
  for (const l of out) console.log(`${l.ok ? '✓' : '·'} ${l.name.padEnd(w)}  ${l.detail}`);
  if (dry) console.log('\nDry run: nothing was written.');
  else console.log('\nRestart your agent to load the browser tools.');
}
