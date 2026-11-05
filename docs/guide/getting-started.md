# Getting started

Browser Routines records what your agent does in the browser. You save it as a routine, with the values you fill in each time. Next time, the routine replays as one tool call, with no model doing the steps.

It has two parts: a browser extension, and one command that connects your agents to it.

## 1. Add the extension

Install it from the store for your browser: Chrome, Edge or Firefox. Brave, Arc and Opera use the Chrome version. Signing in with Google is optional. You need it only to publish routines to the directory.

## 2. Connect your agent

```bash
npx browser-routines setup
```

Use `pnpm dlx`, `bunx` or `yarn dlx` in place of `npx` if you prefer. The command finds Claude Code, Codex, GitHub Copilot in VS Code and OpenCode, adds the Browser Routines tool server to each one's config, and registers the native host with every browser it finds. Run it with `--dry-run` first to see what it would write.

Restart your agent afterwards so it loads the new tools. Then check everything is connected:

```bash
npx browser-routines doctor
```

### Or let your agent do it

Paste this into Claude Code, Codex, OpenCode or any agent chat:

```text
Set up Browser Routines on this machine.
1. Run "npx browser-routines setup". If I use pnpm, bun or yarn, run it with "pnpm dlx", "bunx" or "yarn dlx" instead.
2. Run "npx browser-routines doctor" and tell me which agents and browsers are connected and what is still missing.
3. If my browser has no extension yet, tell me which store page to open. Do not install anything else.
4. Tell me to restart this agent so it loads the browser tools.
```

## 3. Record your first routine

Ask your agent to do a browser task the way you normally would. Every agent run is recorded. When it finishes, ask it to save the run as a routine, or save it from the extension's side panel.

The next time you ask for the same thing, the agent calls the routine instead of driving the page. See [How it works](/docs/how-it-works) for what happens during a replay.

You can also record a demo by doing the task yourself with the side panel open.
