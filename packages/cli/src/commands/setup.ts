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
import { addClient, agentFlags, callingClient, CLIENTS, entryByHand, lastPicked, pickClients, rememberPicked, removeClient, tomlAdd, tomlDrop, type Client } from './clients.ts';

// `npx agentic-routines setup`: register the native host with every browser found, add the MCP server to the agents
// picked (or named with --agent, or all found with --yes), and tell each agent to use it. `--exclusive` also switches
// the other browser tools off, `--remove` takes it all back out.

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

/** Codex's config as text with our section replaced, so its comments stay. If the section is not plainly written, the whole file is rewritten. */
function codexText(before: string, want: Record<string, any>, entry: Record<string, unknown> | null): string {
  const legacy = LEGACY_SERVER.replace(/-/g, '\\-');
  const noLegacy = before.replace(new RegExp(`^\\[mcp_servers\\.(?:"${legacy}"|${legacy})\\]\\n(?:(?!\\[)[^\\n]*\\n?)*`, 'm'), '');
  const dropped = tomlDrop(noLegacy, 'mcp_servers', false) ?? noLegacy;
  const trimmed = dropped.replace(/\n{3,}/g, '\n\n').replace(/\n+$/, dropped.trim() ? '\n' : '');
  const text = entry ? tomlAdd(trimmed, 'mcp_servers', false, entry) : trimmed;
  try {
    if (JSON.stringify(sorted(parseToml(text))) === JSON.stringify(sorted(want))) return text;
  } catch {
    // Falls through to the rewrite.
  }
  return stringifyToml(want) + '\n';
}
const sorted = (v: any): any => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);

async function codex(cmd: string[], dry: boolean): Promise<Line | null> {
  const dir = join(H, '.codex');
  if (!existsSync(dir)) return null;
  const file = join(dir, 'config.toml');
  const before = existsSync(file) ? await readFile(file, 'utf8') : '';
  const conf = parseToml(before) as Record<string, any>;
  conf.mcp_servers ??= {};
  delete conf.mcp_servers[LEGACY_SERVER];
  // A replay can wait at a pause for longer than Codex's 60s default.
  conf.mcp_servers[SERVER] = { command: cmd[0], args: cmd.slice(1), tool_timeout_sec: 900 };
  if (!dry) save(file, codexText(before, conf, conf.mcp_servers[SERVER]));
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

async function removeMcp(dry: boolean, only?: Set<string>): Promise<Line[]> {
  const out: Line[] = [];
  const done = (name: string, file: string) => out.push({ ok: true, name, detail: `removed from ${tilde(file)}` });
  const want = (id: string) => !only || only.has(id);
  for (const c of CLIENTS) {
    if (c.builtin || !want(c.id)) continue;
    try {
      const r = removeClient(c, dry);
      if (r === 'removed') done(c.label, c.file());
      else if (r === 'edited') out.push({ ok: false, name: c.label, detail: `left in ${tilde(c.file())}: it has been changed since setup wrote it` });
    } catch (e) {
      out.push({ ok: false, name: c.label, detail: (e as Error).message });
    }
  }
  if (!want('claude')) {
    // Asked about other agents only.
  } else if (onPath('claude')) {
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
  if (want('codex') && existsSync(loc.codexConfig())) {
    const conf = parseToml(await readFile(loc.codexConfig(), 'utf8')) as Record<string, any>;
    if (conf.mcp_servers) {
      delete conf.mcp_servers[SERVER];
      delete conf.mcp_servers[LEGACY_SERVER];
      if (!Object.keys(conf.mcp_servers).length) delete conf.mcp_servers;
      if (!dry) save(loc.codexConfig(), codexText(await readFile(loc.codexConfig(), 'utf8'), conf, null));
    }
    done('Codex', loc.codexConfig());
  }
  if (want('vscode') && existsSync(loc.copilotMcp())) {
    for (const n of [SERVER, LEGACY_SERVER]) await dropJson(loc.copilotMcp(), ['servers', n], dry);
    done('GitHub Copilot', loc.copilotMcp());
  }
  if (want('opencode') && existsSync(loc.opencodeDir())) {
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

/** Which agents this run connects. Null: none, the person cancelled or nothing says which agent asked. */
async function chooseClients(flags: ReturnType<typeof agentFlags>, cmd: string[]): Promise<Client[] | null> {
  const found = CLIENTS.filter((c) => c.found());
  if (flags.all) return [...found, ...flags.named.filter((c) => !found.includes(c))];
  if (flags.named.length || flags.none || flags.unknown.length) return flags.named;
  if (flags.yes) return found;
  const caller = callingClient();
  if (caller) return [caller];
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const last = lastPicked();
    const picked = await pickClients(last?.length ? last : found.map((c) => c.id));
    if (picked) rememberPicked(picked.map((c) => c.id));
    return picked;
  }
  // No terminal and nothing says which agent asked: touch no config, and say how to go on.
  console.log(`Nothing says which agent this is for, so no agent config was changed.\n\nAdd this to your agent's MCP settings:\n${entryByHand(cmd)}\n`);
  if (found.length) console.log(`Or connect one you have:\n${found.map((c) => `  npx agentic-routines setup --agent ${c.id}`).join('\n')}\n`);
  return null;
}

async function connectClient(c: Client, cmd: string[], dry: boolean): Promise<Line> {
  const r = addClient(c, cmd, dry);
  if (r === 'conflict') return { ok: false, name: c.label, detail: `${tilde(c.file())} already has a different "${SERVER}" entry: left as it is` };
  return { ok: true, name: c.label, detail: tilde(c.file()) };
}

export async function runSetup(args: string[]): Promise<void> {
  const dry = args.includes('--dry-run');
  const out: Line[] = [];
  const flags = agentFlags(args);

  if (args.includes('--remove')) {
    // With --agent, only those agents; the browsers stay connected for the others.
    const only = flags.named.length && !flags.all ? new Set(flags.named.map((c) => c.id)) : undefined;
    out.push(...(await removeMcp(dry, only)));
    const guidance = [['claude', claudeRemove], ['codex', codexRemove], ['vscode', copilotRemove], ['opencode', opencodeRemove]] as const;
    for (const [id, fn] of guidance) {
      if (only && !only.has(id)) continue;
      try {
        out.push(...fn(dry));
      } catch (e) {
        out.push({ ok: false, name: fn.name.replace(/Remove$/, ''), detail: (e as Error).message });
      }
    }
    if (!only) out.push(...(await removeHost(dry)));
    print(out, dry, '\nRemoved. Your routines are still in ' + tilde(paths.root()) + '. Restart your agent.');
    return;
  }

  // On or off only when asked; otherwise it stays as it is, and a terminal is asked the first time.
  let exclusive: boolean | undefined = args.includes('--exclusive') ? true : args.includes('--no-exclusive') ? false : undefined;
  const cmd = mcpCommand();
  for (const name of flags.unknown) console.log(`Setup does not know "${name}". Add this to its MCP settings:\n${entryByHand(cmd)}\n`);
  if (flags.none && !flags.unknown.length) console.log(`Add this to your agent's MCP settings:\n${entryByHand(cmd)}\n`);
  const chosen = await chooseClients(flags, cmd);
  const picked = new Set((chosen ?? []).map((c) => c.id));
  if (exclusive === undefined && ['claude', 'codex', 'vscode', 'opencode'].some((id) => picked.has(id)) && !Object.values(readState()).some((v) => v?.exclusive)) exclusive = (await askExclusive()) ? true : undefined;
  const mode: Mode = { dry, exclusive };

  out.push(...(await registerHost(dry)));
  const agents = [
    ['claude', 'Claude Code', claudeCode, claudeGuidance],
    ['codex', 'Codex', codex, codexGuidance],
    ['vscode', 'GitHub Copilot', copilot, copilotGuidance],
    ['opencode', 'OpenCode', opencode, opencodeGuidance],
  ] as const;
  for (const [id, name, fn, guidance] of agents) {
    if (!picked.has(id)) continue;
    try {
      const line = (await fn(cmd, dry)) ?? { ok: false, name, detail: 'not installed' };
      out.push(line);
      if (line.ok) out.push(...guidance(mode));
    } catch (e) {
      out.push({ ok: false, name, detail: (e as Error).message });
    }
  }
  for (const c of chosen ?? []) {
    if (c.builtin) continue;
    try {
      out.push(await connectClient(c, cmd, dry));
    } catch (e) {
      out.push({ ok: false, name: c.label, detail: (e as Error).message });
    }
  }
  print(out, dry, picked.size ? '\nRestart your agent to load the browser tools.' : '');
}
