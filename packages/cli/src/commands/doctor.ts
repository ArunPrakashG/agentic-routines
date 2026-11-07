import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { BROWSERS, type OS } from '@agentic-routines/browsers';
import { agentStatus } from './agents.ts';
import { clientStatus } from './clients.ts';
import { debugOn } from '../debug.ts';
import { connectRemote, listenConfig, pairedClients, remoteBrowsers } from '../host/remote.ts';
import { hosts, profileLabel } from '../mcp/bridge.ts';
import { autoOn, hasKey, launcher, updateState, version } from '../update.ts';
import { connected } from './tool.ts';
import { HOST_NAME, paths } from '../paths.ts';

// `npx agentic-routines doctor`: says what is connected and what to do about what is not.

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor() {
  const H = homedir();
  const lines: string[] = [];
  const ok = (name: string, detail: string) => lines.push(`✓ ${name.padEnd(22)} ${detail}`);
  const no = (name: string, detail: string) => lines.push(`✗ ${name.padEnd(22)} ${detail}`);

  const host = join(paths.bin(), platform() === 'win32' ? 'host.bat' : 'host');
  if (existsSync(host)) ok('Host', 'installed');
  else no('Host', 'not installed. Run: npx agentic-routines setup');

  if (platform() !== 'win32') {
    for (const b of BROWSERS) {
      const dir = b.hosts[platform() as 'darwin' | 'linux'];
      if (!dir || !existsSync(join(H, b.profile[platform() as OS] ?? '/nonexistent'))) continue;
      if (existsSync(join(H, dir, `${HOST_NAME}.json`))) ok(b.name, 'connected to the host');
      else no(b.name, 'found, but not connected. Run: npx agentic-routines setup');
    }
  }

  for (const l of [...agentStatus(), ...clientStatus()]) (l.ok ? ok : no)(l.name, l.detail);

  const running = existsSync(paths.hosts()) ? readdirSync(paths.hosts()).filter((f) => f.endsWith('.sock') && alive(Number(f.slice(0, -5)))) : [];
  if (running.length) ok('Extension', `${running.length} browser${running.length > 1 ? 's' : ''} talking to the host right now`);
  else no('Extension', 'no browser is talking to the host. Install the extension, then open its panel once');

  const open = await hosts();

  const app = launcher();
  ok('This copy', `${version()}, ${app ? 'from the install script' : 'not from the install script'}`);
  if (app) {
    const u = updateState();
    if (u.error) no('Updates', `the last try failed: ${u.error}`);
    else ok('Updates', !hasKey() ? 'none: this build has no release key' : autoOn() ? `by itself when idle${u.checkedAt ? `, last looked ${new Date(u.checkedAt).toISOString().slice(0, 16)}` : ''}` : 'turned off');
  }

  // What fast runs, execute and the DevTools address stand on.
  const playwright = await import('playwright-core').then(() => true, () => false);
  (playwright ? ok : no)('Playwright', playwright ? 'there, for fast runs and execute' : 'missing, so fast runs fall back to a replay and execute fails. Install again');
  if (!existsSync(new URL('./execute-worker.js', import.meta.url))) no('Execute', 'its worker is missing. Install again');

  const listen = listenConfig();
  if (listen) {
    const on = open.filter((h) => h.listening);
    (on.length || !open.length ? ok : no)('Listening', `${on.length ? on.map((h) => `${h.listening!.address}:${h.listening!.port}`).join(', ') : `set to ${listen.address}:${listen.port}, once a browser opens`}. Not encrypted, so keep it on Tailscale, WireGuard or a network you trust. ${Object.keys(pairedClients()).length} paired`);
  }
  for (const b of remoteBrowsers()) {
    const up = await connectRemote(b).then((s) => (s.destroy(), true), () => false);
    // Not a failure: a laptop that is closed is just closed.
    lines.push(`${up ? '✓' : '·'} ${`Remote: ${b.name}`.padEnd(22)} ${b.browser} at ${b.address}:${b.port}${up ? ' answers and holds the key' : ' does not answer now'}`);
  }

  try {
    const client = await connected(false);
    const { tools } = await client.listTools();
    ok('Commands', `all ${tools.length} tools are commands too: agentic-routines tools`);
  } catch (e) {
    no('Commands', `the tools could not be listed: ${(e as Error).message}`);
  }
  if (open.length > 1) lines.push(`✓ ${'Profiles'.padEnd(22)} ${(await Promise.all(open.map(profileLabel))).join(', ')}. Name them with: agentic-routines profiles`);

  // Not a problem either way, so it never fails the check.
  lines.push(`✓ ${'Debug log'.padEnd(22)} ${debugOn() ? 'on: see "agentic-routines logs"' : 'off. Turn on with: agentic-routines debug on'}`);

  // An installed copy has its own command, and npx would fetch another copy.
  console.log(lines.join('\n').replaceAll('npx agentic-routines', app ? 'agentic-routines' : 'npx agentic-routines'));
  process.exit(lines.some((l) => l.startsWith('✗')) ? 1 : 0);
}
