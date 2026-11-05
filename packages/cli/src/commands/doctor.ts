import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { BROWSERS, type OS } from '@agentic-routines/browsers';
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

export function runDoctor() {
  const H = homedir();
  const lines: string[] = [];
  const ok = (name: string, detail: string) => lines.push(`✓ ${name.padEnd(14)} ${detail}`);
  const no = (name: string, detail: string) => lines.push(`✗ ${name.padEnd(14)} ${detail}`);

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

  const running = existsSync(paths.hosts()) ? readdirSync(paths.hosts()).filter((f) => f.endsWith('.sock') && alive(Number(f.slice(0, -5)))) : [];
  if (running.length) ok('Extension', `${running.length} browser${running.length > 1 ? 's' : ''} talking to the host right now`);
  else no('Extension', 'no browser is talking to the host. Install the extension, then open its panel once');

  console.log(lines.join('\n'));
  process.exit(lines.some((l) => l.startsWith('✗')) ? 1 : 0);
}
