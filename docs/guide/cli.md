# Command line

```bash
npx agentic-routines <command>
```

| Command | What it does |
|---|---|
| `setup [--dry-run]` | Connects your browsers and the agents you pick, from 30 MCP clients: Claude Code, Codex, VS Code with Copilot, OpenCode, Cursor, Windsurf, Gemini CLI, Zed, Goose and more. Each config is edited in place and what is already in it stays. Claude Code, Codex, Copilot and OpenCode also get written guidance; the others read the same advice from the server when they connect. It also tells each agent to use Agentic Routines for the browser and to prefer a saved routine (see [How agents choose](/docs/agents)). `--dry-run` shows the changes without writing them. |
| `setup --exclusive` | The same, and turns off other browser tools in those agents. `--no-exclusive` turns them back on. |
| `setup --agent <name> ...` | Those agents only, found or not. `--all-agents` or `--yes` is every agent found, without asking. Without any of these it asks in a terminal, connects the calling agent when an agent runs it, and otherwise prints the entry to add by hand. So does `--agent none`, or a name setup does not know. |
| `setup --remove` | Takes it all back out: tool server, guidance, plugin, hooks and the browser connection. Saved routines stay. |
| `update` | Looks for a new version now and installs it. `update status` says how it stands, `update off` and `update on` decide whether it does this by itself. Only a copy from the install script updates. |
| `tools` | Lists every tool an agent has. Each one is a command too, as below. |
| `doctor` | Checks what is connected and what is not, including the guidance and exclusive mode. |
| `stats` | What the routines on this computer have saved: this week, per routine and per agent. What was measured and what was estimated is labelled, and it says how the estimate is made. Reads local files only. |
| `profiles` | Lists the browser profiles with the extension that are open now, numbered. `profiles name <number> <name>` gives one a name an agent can use to pick it (`browser_profile`, or `AGENTIC_ROUTINES_PROFILE`). |
| `secrets add <name> --origin <origin> [--totp]` | Keep a password or a one-time code seed on this computer for one site, read from a hidden prompt. `secrets list` and `secrets remove <name>` |
| `remote listen`, `pair`, `connect`, `status`, `revoke`, `stop`, `forget` | [A browser on another machine](remote.md). Listening and pairing ask in a terminal. |
| `session list`, `session allow`, `session write` | Named sessions. An agent can tighten a session's limits. Widening them is here, and asks in the terminal |
| `debug on` / `debug off` | Turns the action log on or off. While it is on, every tool call an agent makes is written to `~/.agentic-routines/logs/actions.jsonl`: the agent, the tool, its arguments, how long it took, whether it worked and what came back (cut short). Text typed into a field and any argument that looks like a secret are never written, only their length. It takes effect on the next call, with no restart. `AGENTIC_ROUTINES_DEBUG=1` in an agent's environment does the same for that agent. |
| `marks on` / `marks off` | Draws what an agent just clicked or typed into on every screenshot it takes: a numbered box with a label. Handy for QA, as the picture shows what was touched. It adds no tool call and no tokens. An agent can also pass `ref` and `note` to `screenshot` to point at any element with a box, a label and an arrow, whether marks are on or not. With the action log on, pictures are also kept in `~/.agentic-routines/logs/shots`. `AGENTIC_ROUTINES_MARK=1` in an agent's environment does the same for that agent. |
| `logs [-f]` | Reads the action log. `-f` follows it, `-n 100` shows more lines, `--errors` shows only failures and `--raw` prints the JSON. Each tool call is followed by the calls it made to the browser, so a failure can be traced to the step. |
| `sources` | Lists the places routines can come from. |
| `sources add <address>` | Adds a GitHub repository, such as `github.com/owner/repository`. Nothing is installed until you click Install in the side panel. |
| `sources check <folder>` | Reads a folder the way a source would and prints every problem in its `config.routine`, with the file, line and field. Run it before you push a [routine repository](/docs/repositories). |
| `sources remove <address>` | Removes a source. |
| `sources on <address>` / `off <address>` | Turns a source on or off. |
| `export <routine>` | Prints a routine as one file, ready to commit under a repository's `routines/` folder. `--playwright` prints it as a Playwright script instead. |
| `mcp` | Runs the tool server. Your agent starts this. |
| `host` | Runs the native host. Your browser starts this. |


## Every tool is a command

Whatever an agent can do, you or a script can do from a terminal:

```bash
agentic-routines navigate https://example.com
agentic-routines read_page
agentic-routines click --ref e12
agentic-routines type --ref e14 --text "hello" --submit
agentic-routines read_page --json '{"filter": "interactive"}'
agentic-routines navigate --help
```

A value the tool needs can go without its flag, in order. Dashes and underscores both work, so `read-page` is `read_page`. An image goes to a temporary file, and the command prints where. It exits 1 when the tool failed.

Each command is its own process, so they share a named session to keep their tabs between them. It is called `cli` unless you say `--session <name>` or set `AGENTIC_ROUTINES_SESSION`. `session_delete cli` closes its tabs and forgets it.

## Updates

A copy from the install script looks for a new version about once an hour, and only while nothing has asked the browser for anything in five minutes. It installs beside the running version and switches one file, so what is running carries on with the version it started with until it restarts. It keeps the version that was running and removes the others.

It only takes a version newer than its own, from a manifest signed with the release key built into it, and each download has to match the size and checksum in that manifest. A failed try changes nothing, and `doctor` and `update status` show it. A build with no release key does not update by itself. Neither does a copy from `npx` or a checkout.

`update off` stops it, and so does setting `AGENTIC_ROUTINES_NO_UPDATE=1`. Those two commands only work in a terminal and there is no tool for them, so an agent does not decide this for you in the ordinary way. An agent with a shell could still edit the file they write, as it could any file of yours. The extension is separate, and updates through its store.

The install script itself checks the size and checksum, which catches a damaged download. The signature is only checked by the updater, so a first install trusts HTTPS and wherever you got the command from, as any `curl | sh` does.

## When something is missing

Run `doctor`. It lists each agent and browser with a tick when it is connected. Fix the missing ones by running `setup` again, then restart the agent so it loads the tools.

Firefox needs the Firefox extension from its own store. The Chrome version is used by Chromium browsers such as Brave, Arc and Opera.
