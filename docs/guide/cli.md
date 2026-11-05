# Command line

```bash
npx agentic-routines <command>
```

| Command | What it does |
|---|---|
| `setup [--dry-run]` | Connects your browsers and agents: Claude Code, Codex, GitHub Copilot and OpenCode. `--dry-run` shows the changes without writing them. |
| `doctor` | Checks what is connected and what is not. |
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
