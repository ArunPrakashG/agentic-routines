# Command line

```bash
npx agentic-routines <command>
```

| Command | What it does |
|---|---|
| `setup [--dry-run]` | Connects your browsers and agents: Claude Code, Codex, GitHub Copilot and OpenCode. It also tells each agent to use Agentic Routines for the browser and to prefer a saved routine (see [How agents choose](/docs/agents)). `--dry-run` shows the changes without writing them. |
| `setup --exclusive` | The same, and turns off other browser tools in those agents. `--no-exclusive` turns them back on. |
| `setup --remove` | Takes it all back out: tool server, guidance, plugin, hooks and the browser connection. Saved routines stay. |
| `doctor` | Checks what is connected and what is not, including the guidance and exclusive mode. |
| `debug on` / `debug off` | Turns the action log on or off. While it is on, every tool call an agent makes is written to `~/.agentic-routines/logs/actions.jsonl`: the agent, the tool, its arguments, how long it took, whether it worked and what came back (cut short). Text typed into a field and any argument that looks like a secret are never written, only their length. It takes effect on the next call, with no restart. `AGENTIC_ROUTINES_DEBUG=1` in an agent's environment does the same for that agent. |
| `logs [-f]` | Reads the action log. `-f` follows it, `-n 100` shows more lines, `--errors` shows only failures and `--raw` prints the JSON. Each tool call is followed by the calls it made to the browser, so a failure can be traced to the step. |
| `sources` | Lists the places routines can come from. |
| `sources add <address>` | Adds a GitHub repository, such as `github.com/owner/repository`. Nothing is installed until you click Install in the side panel. |
| `sources check <folder>` | Reads a folder the way a source would and prints every problem in its `config.routine`, with the file, line and field. Run it before you push a [routine repository](/docs/repositories). |
| `sources remove <address>` | Removes a source. |
| `sources on <address>` / `off <address>` | Turns a source on or off. |
| `export <routine>` | Prints a routine as one file, ready to commit under a repository's `routines/` folder. |
| `mcp` | Runs the tool server. Your agent starts this. |
| `host` | Runs the native host. Your browser starts this. |

## When something is missing

Run `doctor`. It lists each agent and browser with a tick when it is connected. Fix the missing ones by running `setup` again, then restart the agent so it loads the tools.

Firefox needs the Firefox extension from its own store. The Chrome version is used by Chromium browsers such as Brave, Arc and Opera.
