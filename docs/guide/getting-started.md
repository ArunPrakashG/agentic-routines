# Getting started

Agentic Routines is a cache for your agent's browser work. Agents such as Claude Code drive the browser one step at a time, and every step costs tokens and time. Agentic Routines records what the agent does, the agent keeps the tasks that will come back as routines, and next time one tool call replays the steps with no model. You do not record or manage anything: your agent does.

It has two parts: a browser extension, and one command that connects your agents to it.

## What you need

- A Chromium browser (Chrome, Edge, Brave, Arc, Opera) or Firefox, on macOS, Linux or Windows.
- A coding agent that speaks MCP, such as Claude Code, Codex, OpenCode or VS Code with Copilot.
- Node 20 or newer for the `npx` route. The install script brings its own Node, so it needs nothing.

## 1. Add the extension

Install it from the store for your browser once its listing is live: Chrome, Edge or Firefox. Brave, Arc and Opera use the Chrome version. Signing in is optional, with Google, GitHub, Microsoft or an email address. You need it only to publish routines to the directory.

### Until the store listings are live

Every [release](https://github.com/ArunPrakashG/agentic-routines/releases) carries the extension as a zip, so you can load it yourself:

- **Chrome, Edge, Brave and other Chromium browsers:** unzip `agentic-routines-<version>-chrome.zip`, open `chrome://extensions`, turn on Developer mode, choose Load unpacked and pick the folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on and pick the zip. Firefox forgets a temporary add-on when it closes.

Then use the install script below to connect your agent: it also registers the native host with your browser.

## 2. Connect your agent

```bash
npx agentic-routines setup
```

That needs Node. Without it, or for a copy that keeps itself up to date, use the install script instead, which brings its own:

```bash
curl -fsSL https://agenticroutines.arunprakashg.com/install | sh
```

On Windows, in PowerShell:

```powershell
irm https://agenticroutines.arunprakashg.com/install.ps1 | iex
```

It checks the download against the size and checksum the release lists, puts everything in `~/.agentic-routines/app` and one command in `~/.local/bin`, then runs `setup`. It is a folder holding Node and the CLI, about 50 MB to download, not a single file. [Updates](cli.md#updates) says how it stays current.

Use `pnpm dlx`, `bunx` or `yarn dlx` in place of `npx` if you prefer. The command asks which of the agents it found to connect, from 30 it knows (Claude Code, Codex, VS Code with Copilot, OpenCode, Cursor, Windsurf, Gemini CLI, Zed and more), adds the Agentic Routines tool server to each one's config, and registers the native host with every browser it finds. It also tells each agent to use Agentic Routines for all browser work and to try a saved routine first ([how agents choose](/docs/agents)). Run it with `--dry-run` first to see what it would write.

Restart your agent afterwards so it loads the new tools. Then check everything is connected:

```bash
npx agentic-routines doctor
```

### Or let your agent do it

Paste this into Claude Code, Codex, OpenCode or any agent chat:

```text
Set up Agentic Routines on this machine.
1. Run "npx agentic-routines setup". If I use pnpm, bun or yarn, run it with "pnpm dlx", "bunx" or "yarn dlx" instead.
2. Run "npx agentic-routines doctor" and tell me which agents and browsers are connected and what is still missing.
3. If my browser has no extension yet, tell me which store page to open. Do not install anything else.
4. Tell me to restart this agent so it loads the browser tools.
```

## 3. Let your agent build the cache

Ask your agent to do a browser task the way you normally would. Every agent run is recorded. When it finishes, your agent decides on its own whether the task is likely to come back, and if so it saves it as a routine. You do not have to ask.

The next time you ask for the same thing, the agent calls the routine instead of driving the page. See [How it works](/docs/how-it-works) for what happens during a replay.

The side panel can also record a demo you do yourself. That is for trying the tool out, not how it is used.

## Keeping it up to date

A copy made by the install script updates itself. `npx agentic-routines update` looks for a new version now, and `update off` stops it from updating by itself. The extension updates through the store, or by loading the newer zip over the old folder if you installed it by hand.

## Taking it out

```bash
npx agentic-routines setup --remove
```

removes the tool server, guidance, plugin, hook and native host from every agent and browser it set up. Then remove the extension from the browser's extensions page. Your saved routines are plain files under `~/.agentic-routines`, and stay until you delete that folder.

Something not working? [Troubleshooting](/docs/troubleshooting) lists the common causes, and `npx agentic-routines doctor` says what is connected.
