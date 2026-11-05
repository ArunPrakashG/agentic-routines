# How agents choose routines

Connecting an agent only gives it the tools. `setup` also tells it how to use them, so it reaches for a saved routine before it opens a page, and uses no other browser.

## What the agent is told

Every agent gets the same text:

1. For any task that needs a browser, use the Agentic Routines tools. Do not use another browser tool, and do not fetch a signed-in page with a script.
2. Before opening anything, look for a routine: `routines_list` for what is installed, `routines_search` for the directory and your sources, and the `rt_<name>` tools.
3. Choose by the routine's "Use when" text first, then by whether its address matches the page, then by cost. A routine that replays with no model calls beats one that needs the agent, fewer steps beat more, and one that has finished cleanly before beats one that has failed.
4. Run it. If none fits, or it fails, do the task by hand with the browser tools and say so.
5. Afterwards, decide whether the run is worth keeping. If it is a chore you will repeat, call `routine_propose`, refine it, test it and save it. See [Refine a routine](/docs/refine).

The text lives in one file in the repository, `plugins/agentic-routines/skills/agentic-routines/SKILL.md`. The Claude Code skill and every other agent's copy are built from it, so they cannot drift.

## Where it goes

| Agent | What `setup` writes |
|---|---|
| Claude Code | A plugin, `agentic-routines@agentic-routines`, installed for your user. It has a skill, a hook that puts the same text in front of the agent when a session starts, and a hook that blocks other browser tools when exclusive mode is on. |
| Codex | A block in `~/.codex/AGENTS.md`. |
| GitHub Copilot | `prompts/agentic-routines.instructions.md` in your VS Code user folder, applied to every chat. |
| OpenCode | A block in `~/.config/opencode/AGENTS.md`. |

A block starts with `<!-- agentic-routines:start -->` and ends with `<!-- agentic-routines:end -->`. Nothing outside it is touched, and running `setup` again replaces what is inside. Before the first change to a file, `setup` saves a copy next to it ending in `.agentic-routines.bak`.

Prefer to install the Claude Code plugin yourself?

```text
/plugin install agentic-routines --marketplace ArunPrakashG/agentic-routines
```

## Make an agent exclusive

By default other browser tools stay available, and the agent is only asked not to use them. To switch them off:

```bash
npx agentic-routines setup --exclusive
```

In a terminal, `setup` asks once. Scripts never get the question.

| Agent | What exclusive does |
|---|---|
| Claude Code | The plugin's hook refuses tools from Claude in Chrome, Playwright, Puppeteer, Chrome DevTools, Browserbase and similar servers, and tells the agent to use Agentic Routines instead. It never looks at tools that are not browsers: Bash, file tools, web fetch and other servers are untouched. |
| Codex | Browser servers in `config.toml` get `enabled = false`. |
| OpenCode | Browser servers in `opencode.json` get `enabled: false`. |
| GitHub Copilot | Nothing. VS Code has no off switch for a server in `mcp.json`, so turn the other browser tools off in the Chat tools picker. `doctor` says so. |

`setup` remembers which servers it turned off, in `agents.json` in the Agentic Routines folder, and turns on only those again. To go back:

```bash
npx agentic-routines setup --no-exclusive
```

## Check it

```bash
npx agentic-routines doctor
```

For each agent it says whether the tool server, the guidance and exclusive mode are in place, and what to run if one is not. Exclusive mode off is not a fault.

## Take it all out

```bash
npx agentic-routines setup --remove
```

This removes the tool server, the guidance blocks, the plugin and its hooks, any browser servers it switched off (turned back on), and the browser connection. Your saved routines stay where they are.
