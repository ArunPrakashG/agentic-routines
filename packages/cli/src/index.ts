import { runDebug, runLogs } from './commands/debug.ts';
import { runDoctor } from './commands/doctor.ts';
import { runMarks } from './commands/marks.ts';
import { runProfiles } from './commands/profiles.ts';
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
  runDoctor().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'profiles') {
  runProfiles(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'marks') {
  runMarks(args);
} else if (cmd === 'debug') {
  runDebug(args);
} else if (cmd === 'logs') {
  runLogs(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.log(`agentic-routines

  setup [--dry-run]   Connect your browsers and agents (Claude Code, Codex, Copilot, OpenCode) and tell
                      them to use Agentic Routines for the browser and to prefer a saved routine
        [--exclusive] Also turn off other browser tools in those agents (--no-exclusive turns them back on)
        [--remove]    Take it all back out: tool server, guidance, plugin, hook and host
  doctor              Check what is connected and what is not, guidance and exclusivity included
  profiles            List the browser profiles that are open; "profiles name <number> <name>" names one
  marks [on|off]      Annotate screenshots: a numbered box and label on what the agent clicked or typed into
  debug [on|off]      Record every tool call an agent makes, with arguments, time and result (typed text and secrets left out)
  logs [-f]           Read that record: -f follows it, -n 100 shows more lines, --errors only failures, --raw is JSON
  sources             List, add, remove, turn on or off the places routines can come from; "sources check <folder>" checks a repository
  export <routine>    Print a routine as one file to put in a Git repository's routines folder
  mcp                 Run the MCP server (agents start this)
  host                Run the native host (browsers start this)`);
}
