import { runDoctor } from './commands/doctor.ts';
import { runHost } from './host/host.ts';
import { runMcp } from './mcp/server.ts';
import { runSetup } from './commands/setup.ts';
import { runExport, runSources } from './commands/sources.ts';

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
} else if (cmd === 'sources' || cmd === 'export') {
  (cmd === 'sources' ? runSources(args) : runExport(args)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'doctor') {
  runDoctor();
} else {
  console.log(`agentic-routines

  setup [--dry-run]   Connect your browsers and agents (Claude Code, Codex, Copilot, OpenCode)
  doctor              Check what is connected and what is not
  sources             List, add, remove, turn on or off the places routines can come from; "sources check <folder>" checks a repository
  export <routine>    Print a routine as one file to put in a Git repository's routines folder
  mcp                 Run the MCP server (agents start this)
  host                Run the native host (browsers start this)`);
}
