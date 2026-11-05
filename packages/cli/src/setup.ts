import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { BROWSERS, hostManifest, type Browser, type OS } from '@browser-routines/browsers';
import { HOST_NAME, paths } from './paths.ts';

// `npx browser-routines setup`: register the native host with every browser
// found, and add the MCP server to every agent found.

const SERVER = 'browser-routines';
const H = homedir();
const tilde = (p: string) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);

function mcpCommand(): string[] {
  const script = realpathSync(process.argv[1]);
  if (script.includes(`${'_npx'}`)) return ['npx', '-y', 'browser-routines', 'mcp'];
  return [process.execPath, script, 'mcp'];
}

interface Line {
  ok: boolean;
  name: string;
  detail: string;
}

async function writeHostWrapper(): Promise<string> {
  await mkdir(paths.bin(), { recursive: true, mode: 0o700 });
  const node = process.execPath;
  // A copy of its own, as npx can prune the cache this script runs from. Running setup again updates it.
  const script = join(paths.bin(), 'host.cjs');
  await copyFile(join(dirname(realpathSync(process.argv[1])), 'host-main.cjs'), script);
  if (platform() === 'win32') {
    const p = join(paths.bin(), 'host.bat');
    await writeFile(p, `@echo off\r\n"${node}" "${script}" %*\r\n`);
    return p;
  }
  const p = join(paths.bin(), 'host');
  await writeFile(p, `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`);
  await chmod(p, 0o755);
  return p;
}

function profileDir(b: Browser): string | undefined {
  const rel = b.profile[platform() as OS];
  if (!rel) return;
  if (platform() !== 'win32') return join(H, rel);
  const base = b.engine === 'gecko' ? (process.env.APPDATA ?? join(H, 'AppData/Roaming')) : (process.env.LOCALAPPDATA ?? join(H, 'AppData/Local'));
  return join(base, rel);
}

async function registerHost(dry: boolean): Promise<Line[]> {
  const wrapper = dry ? join(paths.bin(), platform() === 'win32' ? 'host.bat' : 'host') : await writeHostWrapper();
  const lines: Line[] = [];
  const done = new Set<string>();
  for (const b of BROWSERS) {
    const dir = profileDir(b);
    if (!dir || !existsSync(dir)) continue;
    const manifest = hostManifest(b, HOST_NAME, wrapper);
    if (platform() === 'win32') {
      // Windows finds the manifest through a registry key, and some browsers share one.
      if (!b.registry) continue;
      const file = join(paths.root(), 'manifests', `${b.engine}.json`);
      if (!dry) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
        if (!done.has(b.registry)) execFileSync('reg', ['add', `HKCU\\${b.registry}\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' });
      }
      done.add(b.registry);
      lines.push({ ok: true, name: b.name, detail: `HKCU\\${b.registry}` });
      continue;
    }
    const hosts = b.hosts[platform() as 'darwin' | 'linux'];
    if (!hosts) continue;
    const target = join(H, hosts, `${HOST_NAME}.json`);
    if (!dry) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(manifest, null, 2) + '\n');
    }
    lines.push({ ok: true, name: b.name, detail: tilde(target) });
  }
  if (!lines.length) lines.push({ ok: false, name: 'Browsers', detail: `No ${BROWSERS.map((b) => b.name).join(', ')} profile found` });
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
  // A replay can wait at a pause for longer than Codex's 60s default.
  conf.mcp_servers[SERVER] = { command: cmd[0], args: cmd.slice(1), tool_timeout_sec: 900 };
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
