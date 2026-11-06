# Getting started

Agentic Routines is a cache for your agent's browser work. Agents such as Claude Code drive the browser one step at a time, and every step costs tokens and time. Agentic Routines records what the agent does, the agent keeps the tasks that will come back as routines, and next time one tool call replays the steps with no model. You do not record or manage anything: your agent does.

It has two parts: a browser extension, and one command that connects your agents to it.

## 1. Add the extension

Install it from the store for your browser: Chrome, Edge or Firefox. Brave, Arc and Opera use the Chrome version. Signing in with Google is optional. You need it only to publish routines to the directory.

## 2. Connect your agent

```bash
npx agentic-routines setup
```

Use `pnpm dlx`, `bunx` or `yarn dlx` in place of `npx` if you prefer. The command finds Claude Code, Codex, GitHub Copilot in VS Code and OpenCode, adds the Agentic Routines tool server to each one's config, and registers the native host with every browser it finds. It also tells each agent to use Agentic Routines for all browser work and to try a saved routine first ([how agents choose](/docs/agents)). Run it with `--dry-run` first to see what it would write.

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
