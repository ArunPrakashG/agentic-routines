import { runDoctor } from './doctor.ts';
import { runHost } from './host.ts';
import { runMcp } from './mcp.ts';
import { runSetup } from './setup.ts';

const [cmd, ...args] = process.argv.slice(2);

// Browsers start the host with the extension origin as the first argument.
if (cmd?.startsWith('chrome-extension://') || cmd?.endsWith('.json') || cmd === 'host') {
  runHost();
} else if (cmd === 'mcp') {
  runMcp().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (cmd === 'setup') {
  runSetup(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'doctor') {
  runDoctor();
} else {
  console.log(`browser-routines

  setup [--dry-run]   Connect your browsers and agents (Claude Code, Codex, Copilot, OpenCode)
  doctor              Check what is connected and what is not
  mcp                 Run the MCP server (agents start this)
  host                Run the native host (browsers start this)`);
}
