import { runDebug, runLogs } from './commands/debug.ts';
import { runDoctor } from './commands/doctor.ts';
import { runMarks } from './commands/marks.ts';
import { runProfiles } from './commands/profiles.ts';
import { runSecrets } from './commands/secrets.ts';
import { runRemote } from './commands/remote.ts';
import { runTool } from './commands/tool.ts';
import { runUpdate } from './commands/update.ts';
import { runSessions } from './commands/sessions.ts';
import { runStats } from './commands/stats.ts';
import { runHost } from './host/host.ts';
import { runMcp } from './mcp/server.ts';
import { runSetup } from './commands/setup.ts';
import { runExport, runSources } from './commands/sources.ts';
import { runProject } from './commands/project.ts';

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
} else if (cmd === 'project') {
  runProject(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'doctor') {
  runDoctor().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'stats') {
  runStats().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'profiles') {
  runProfiles(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'secrets') {
  runSecrets(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'update') {
  runUpdate(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'remote') {
  runRemote(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else if (cmd === 'session') {
  runSessions(args).catch((e) => {
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
} else if (cmd && cmd !== 'help' && !cmd.startsWith('-')) {
  // Anything else is one of the agent's tools, or nothing. The rest of the commands are above this.
  runTool(cmd, args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
} else {
  console.log(`agentic-routines

  setup [--dry-run]   Connect your browsers and agents, and tell them to use Agentic Routines for the
                      browser and to prefer a saved routine. In a terminal it asks which agents
        [--agent <name> ...]  Those agents; "none" prints the entry to add by hand
        [--all-agents]        Every agent found on this computer
        [--yes]               The same, without asking
        [--exclusive] Also turn off other browser tools in those agents (--no-exclusive turns them back on)
        [--remove]    Take it all back out: tool server, guidance, plugin, hook and host
  doctor              Check what is connected and what is not, guidance and exclusivity included
  stats               What the routines on this computer have saved, this week and per routine
  profiles            List the browser profiles that are open; "profiles name <number> <name>" names one
  secrets             Keep a password or one-time code seed for one site, for routines to use: "secrets add <name> --origin <origin>" [--totp]. Agents get the name only
  remote              A browser on another computer: "remote pair" makes an address and code to enter in its side panel
  session             List named sessions; "session allow <name> <site>" and "session write <name>" widen one
  marks [on|off]      Annotate screenshots: a numbered box and label on what the agent clicked or typed into
  debug [on|off]      Record every tool call an agent makes, with arguments, time and result (typed text and secrets left out)
  logs [-f]           Read that record: -f follows it, -n 100 shows more lines, --errors only failures, --raw is JSON
  update              Look for a new version now; "update off" stops it updating by itself, "update status" says how it stands
  tools               Every tool an agent has, each one a command too: "navigate https://example.com", "read_page", "<tool> --help"
        [--session <name>]  Tabs stay open between commands, in a session called "cli" unless you name one
  sources             List, add, remove, turn on or off the places routines can come from; "sources check <folder>" checks a repository
  export <routine>    Print a routine as one file to put in a Git repository's routines folder
  mcp                 Run the MCP server (agents start this)
  host                Run the native host (browsers start this)`);
}
