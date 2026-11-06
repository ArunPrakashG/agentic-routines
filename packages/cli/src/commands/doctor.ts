import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { BROWSERS, type OS } from '@agentic-routines/browsers';
import { agentStatus } from './agents.ts';
import { debugOn } from '../debug.ts';
import { hosts, profileLabel } from '../mcp/bridge.ts';
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

  for (const l of agentStatus()) (l.ok ? ok : no)(l.name, l.detail);

  const running = existsSync(paths.hosts()) ? readdirSync(paths.hosts()).filter((f) => f.endsWith('.sock') && alive(Number(f.slice(0, -5)))) : [];
  if (running.length) ok('Extension', `${running.length} browser${running.length > 1 ? 's' : ''} talking to the host right now`);
  else no('Extension', 'no browser is talking to the host. Install the extension, then open its panel once');

  const open = await hosts();
  if (open.length > 1) lines.push(`✓ ${'Profiles'.padEnd(22)} ${(await Promise.all(open.map(profileLabel))).join(', ')}. Name them with: agentic-routines profiles`);

  // Not a problem either way, so it never fails the check.
  lines.push(`✓ ${'Debug log'.padEnd(22)} ${debugOn() ? 'on: see "agentic-routines logs"' : 'off. Turn on with: agentic-routines debug on'}`);

  console.log(lines.join('\n'));
  process.exit(lines.some((l) => l.startsWith('✗')) ? 1 : 0);
}
