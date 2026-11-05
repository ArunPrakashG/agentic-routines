import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { BROWSERS, hostManifest, type Browser, type OS } from '@agentic-routines/browsers';
import { HOST_NAME, LEGACY_HOST_NAME, paths } from '../paths.ts';
import { claudeGuidance, claudeRemove, codexGuidance, codexRemove, copilotGuidance, copilotRemove, loc, onPath, opencodeGuidance, opencodeRemove, readState, save, type Line, type Mode } from './agents.ts';

// `npx agentic-routines setup`: register the native host with every browser found, add the MCP server to every
// agent found, and tell each agent to use it. `--exclusive` also switches the other browser tools off,
// `--remove` takes it all back out.

const SERVER = 'agentic-routines';
// What the project was called before; removed so an agent does not end up with two copies.
const LEGACY_SERVER = 'browser-routines';
const H = homedir();
const tilde = (p: string) => (p.startsWith(H) ? '~' + p.slice(H.length) : p);

function mcpCommand(): string[] {
  const script = realpathSync(process.argv[1]);
  if (script.includes(`${'_npx'}`)) return ['npx', '-y', 'agentic-routines', 'mcp'];
  return [process.execPath, script, 'mcp'];
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
        if (!done.has(b.registry)) {
          try {
            execFileSync('reg', ['delete', `HKCU\\${b.registry}\\${LEGACY_HOST_NAME}`, '/f'], { stdio: 'ignore' });
          } catch {
            // Not registered.
          }
        }
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
      await rm(join(H, hosts, `${LEGACY_HOST_NAME}.json`), { force: true });
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
  if (!dry && after !== before) save(file, after);
}

/** Drop the entry an earlier name left behind. */
async function dropJson(file: string, path: (string | number)[], dry: boolean) {
  if (!existsSync(file)) return;
  const before = await readFile(file, 'utf8');
  const after = applyEdits(before, modify(before, path, undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  if (!dry && after !== before) save(file, after);
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
      try {
        execFileSync('claude', ['mcp', 'remove', '--scope', 'user', LEGACY_SERVER], { stdio: 'ignore' });
      } catch {
        // Never added.
      }
      execFileSync('claude', ['mcp', 'add', '--scope', 'user', SERVER, '--', ...cmd], { stdio: 'ignore' });
    }
    return { ok: true, name: 'Claude Code', detail: tilde(file) };
  }
  if (!existsSync(file)) return null;
  await dropJson(file, ['mcpServers', LEGACY_SERVER], dry);
  await editJson(file, ['mcpServers', SERVER], { type: 'stdio', command: cmd[0], args: cmd.slice(1), env: {} }, dry);
  return { ok: true, name: 'Claude Code', detail: tilde(file) };
}

async function codex(cmd: string[], dry: boolean): Promise<Line | null> {
  const dir = join(H, '.codex');
  if (!existsSync(dir)) return null;
  const file = join(dir, 'config.toml');
  const conf = existsSync(file) ? (parseToml(await readFile(file, 'utf8')) as Record<string, any>) : {};
  conf.mcp_servers ??= {};
  delete conf.mcp_servers[LEGACY_SERVER];
  // A replay can wait at a pause for longer than Codex's 60s default.
  conf.mcp_servers[SERVER] = { command: cmd[0], args: cmd.slice(1), tool_timeout_sec: 900 };
  if (!dry) save(file, stringifyToml(conf) + '\n');
  return { ok: true, name: 'Codex', detail: tilde(file) };
}

async function copilot(cmd: string[], dry: boolean): Promise<Line | null> {
  const user = loc.vscodeUser();
  if (!existsSync(user)) return null;
  const file = join(user, 'mcp.json');
  await dropJson(file, ['servers', LEGACY_SERVER], dry);
  await editJson(file, ['servers', SERVER], { type: 'stdio', command: cmd[0], args: cmd.slice(1) }, dry);
  return { ok: true, name: 'GitHub Copilot', detail: tilde(file) };
}

async function opencode(cmd: string[], dry: boolean): Promise<Line | null> {
  const dir = join(H, '.config/opencode');
  if (!existsSync(dir)) return null;
  const file = ['opencode.jsonc', 'opencode.json'].map((f) => join(dir, f)).find(existsSync) ?? join(dir, 'opencode.json');
  await dropJson(file, ['mcp', LEGACY_SERVER], dry);
  await editJson(file, ['mcp', SERVER], { type: 'local', command: cmd, enabled: true }, dry);
  return { ok: true, name: 'OpenCode', detail: tilde(file) };
}

// --- taking it back out ---

async function removeHost(dry: boolean): Promise<Line[]> {
  const lines: Line[] = [];
  for (const b of BROWSERS) {
    if (platform() === 'win32') {
      if (!dry && b.registry) {
        try {
          execFileSync('reg', ['delete', `HKCU\\${b.registry}\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
        } catch {
          // Not registered.
        }
      }
      continue;
    }
    const hosts = b.hosts[platform() as 'darwin' | 'linux'];
    if (!hosts) continue;
    for (const n of [HOST_NAME, LEGACY_HOST_NAME]) {
      const f = join(H, hosts, `${n}.json`);
      if (!existsSync(f)) continue;
      if (!dry) await rm(f, { force: true });
      lines.push({ ok: true, name: b.name, detail: `removed ${tilde(f)}` });
    }
  }
  if (!dry) await rm(paths.bin(), { recursive: true, force: true });
  return lines;
}

async function removeMcp(dry: boolean): Promise<Line[]> {
  const out: Line[] = [];
  const done = (name: string, file: string) => out.push({ ok: true, name, detail: `removed from ${tilde(file)}` });
  if (onPath('claude')) {
    if (!dry) {
      for (const n of [SERVER, LEGACY_SERVER]) {
        try {
          execFileSync('claude', ['mcp', 'remove', '--scope', 'user', n], { stdio: 'ignore' });
        } catch {
          // Not added.
        }
      }
    }
    done('Claude Code', join(H, '.claude.json'));
  } else if (existsSync(join(H, '.claude.json'))) {
    for (const n of [SERVER, LEGACY_SERVER]) await dropJson(join(H, '.claude.json'), ['mcpServers', n], dry);
    done('Claude Code', join(H, '.claude.json'));
  }
  if (existsSync(loc.codexConfig())) {
    const conf = parseToml(await readFile(loc.codexConfig(), 'utf8')) as Record<string, any>;
    if (conf.mcp_servers) {
      delete conf.mcp_servers[SERVER];
      delete conf.mcp_servers[LEGACY_SERVER];
      if (!Object.keys(conf.mcp_servers).length) delete conf.mcp_servers;
      if (!dry) save(loc.codexConfig(), stringifyToml(conf) + '\n');
    }
    done('Codex', loc.codexConfig());
  }
  if (existsSync(loc.copilotMcp())) {
    for (const n of [SERVER, LEGACY_SERVER]) await dropJson(loc.copilotMcp(), ['servers', n], dry);
    done('GitHub Copilot', loc.copilotMcp());
  }
  if (existsSync(loc.opencodeDir())) {
    for (const n of [SERVER, LEGACY_SERVER]) await dropJson(loc.opencodeConfig(), ['mcp', n], dry);
    done('OpenCode', loc.opencodeConfig());
  }
  return out;
}

// --- the command ---

/** Ask once, in a terminal only. Anything scripted gets the default. */
async function askExclusive(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = await rl.question('Also turn off other browser tools (Playwright, Claude in Chrome and so on), so agents only use Agentic Routines? [y/N] ');
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

function print(out: Line[], dry: boolean, tail: string) {
  const w = Math.max(...out.map((l) => l.name.length));
  for (const l of out) console.log(`${l.ok ? '✓' : '·'} ${l.name.padEnd(w)}  ${l.detail}`);
  if (dry) console.log('\nDry run: nothing was written.');
  else console.log(tail);
}

export async function runSetup(args: string[]): Promise<void> {
  const dry = args.includes('--dry-run');
  const out: Line[] = [];

  if (args.includes('--remove')) {
    out.push(...(await removeMcp(dry)));
    for (const fn of [claudeRemove, codexRemove, copilotRemove, opencodeRemove]) {
      try {
        out.push(...fn(dry));
      } catch (e) {
        out.push({ ok: false, name: fn.name.replace(/Remove$/, ''), detail: (e as Error).message });
      }
    }
    out.push(...(await removeHost(dry)));
    print(out, dry, '\nRemoved. Your routines are still in ' + tilde(paths.root()) + '. Restart your agent.');
    return;
  }

  // On or off only when asked; otherwise it stays as it is, and a terminal is asked the first time.
  let exclusive: boolean | undefined = args.includes('--exclusive') ? true : args.includes('--no-exclusive') ? false : undefined;
  if (exclusive === undefined && !Object.values(readState()).some((v) => v?.exclusive)) exclusive = (await askExclusive()) ? true : undefined;
  const mode: Mode = { dry, exclusive };

  const cmd = mcpCommand();
  out.push(...(await registerHost(dry)));
  const agents = [
    ['Claude Code', claudeCode, claudeGuidance],
    ['Codex', codex, codexGuidance],
    ['GitHub Copilot', copilot, copilotGuidance],
    ['OpenCode', opencode, opencodeGuidance],
  ] as const;
  for (const [name, fn, guidance] of agents) {
    try {
      const line = (await fn(cmd, dry)) ?? { ok: false, name, detail: 'not installed' };
      out.push(line);
      if (line.ok) out.push(...guidance(mode));
    } catch (e) {
      out.push({ ok: false, name, detail: (e as Error).message });
    }
  }
  print(out, dry, '\nRestart your agent to load the browser tools.');
}
