# Agent tools

The `agentic-routines mcp` command is a Model Context Protocol server that your agent starts over stdio. `setup` writes the config for each agent so you never run it yourself.

## Browser tools

Your agent works in its own tab unless told otherwise. Everything it does with these is recorded.

| Tool | What it does |
|---|---|
| `tabs` | List open tabs: id, title and address. |
| `navigate` | Open an address in the agent tab. If an installed routine handles the page, it adds a hint line (see [Finding a routine first](#finding-a-routine-first)). |
| `read_page` | The page as an outline of roles and names. Interactive elements get a ref such as `ref_12`. Adds the same hint line when the tab has moved to a page a routine handles. |
| `click` | Click an element by ref. |
| `type` | Type into a field by ref. Replaces what is there. `submit` presses Enter after. |
| `select` | Pick an option in a select, by label or value. |
| `upload` | Attach a file from this machine to a file input. |
| `press` | Press a key in the focused element: Enter, Escape, Tab, ArrowDown. |
| `screenshot` | The area around the last element, or the whole tab with `full: true`. `read_page` costs less. |

## Finding a routine first

An agent should look for a routine before it does a browser task by hand. The server's instructions say so, and so do the tool descriptions of `navigate`, `read_page` and `routines_search`.

**The hint.** When `navigate` lands on, or `read_page` reads, a page that an installed routine handles, the result ends with one line per routine, at most two, best first:

```
Routine rt_play_release handles this page: release to a track. Prefer it.
```

The wording is fixed so that agents and skills can rely on it: `Routine <tool name> handles this page: <what it does>. Prefer it.` The tool name is the one in the tool list. A routine handles a page when one of its `urls` matches (see [Routine format](/docs/routines)); a routine that only shares the site gets no hint. `read_page` says it once per page, not on every read.

**Ranking.** `routines_search` orders by fit first, then by how well the routine has worked:

1. A routine whose `urls` match the page, with the closest path match first (more literal parts matched means closer).
2. A routine for the same site that lists other pages.
3. Among equals, the one that finishes more of its runs and needs the model less.

**Stats.** Each routine keeps a small record of the agent's runs of it on this machine: runs, how many finished, model calls per run, the median time and the last run, over the most recent 20. It is a file in the routine's folder. Nothing is sent anywhere, and it is not part of what you publish. `routines_list`, `routine_describe` and `routines_search` show it. Runs started from the side panel by a person are not counted.

## Routine tools

| Tool | What it does |
|---|---|
| `rt_<name>` | One tool per saved routine, with its parameters. Replays without a model. |
| `routine_run` | The same, by name, for clients that read tools only at startup. |
| `routine_resume` | Continue a paused replay. `approve` goes past a pause or stops. `choice` picks the element for a changed step. |
| `routines_list` | Saved routines, what each is for and how the agent's runs of it have gone. |
| `routine_describe` | The full notes: when to use it, when not to, the pages it applies to, how its runs have gone, values it asks for, where it pauses. |
| `run_steps` | The recorded steps of a run, numbered, as they happened. |
| `routine_propose` | After a task, the agent decides whether it is worth keeping. This turns the run into a draft: every step numbered, with its page, what it did and what happened after it, plus hints at what could go. Changes nothing. |
| `routine_edit` | Refine a draft: remove steps, replace clicks and dialogs with a direct address, make values parameters, add pauses and notes, undo, reset. The extension refuses unsafe edits. |
| `routine_test` | Replay the draft on the live site. Steps that pause are skipped, never performed. |
| `routine_save` | Save the draft as a routine. A routine that replaces a saved one needs a good test first. |

See [Refine a routine](/docs/refine) for the loop.

At most 30 routine tools are exposed at once. The rest are reached with `routines_list` and `routine_run`.

## Directory tools

| Tool | What it does |
|---|---|
| `routines_search` | Find routines for a page or a task. Pass `url` (the page you are on) and/or `query`. Installed routines come first, then the directory (no account needed) and the person's Git sources. A routine that lists the page you are on ranks above one that only matches the site. |
| `routine_install` | Install `owner/name` from the directory. It is checked again on this side. Any hooks it has stay off until the person reads and allows them in the side panel. |
| `routine_install_from_git` | Ask to install from a GitHub repository. The side panel shows every step and any hook code, and Install is the person's click. Hooks are off unless the person switches them on there. |
| `routine_publish` | Ask to send a routine for review. The person approves in the side panel. An agent can't publish by itself. |
| `routine_submissions` | Where each submission stands: waiting, rejected with the guideline, live or turned off. Read only. |

## A replay that stops

A replay returns one of these:

- **Done.** The result text lists the steps run and the time.
- **Paused.** The next step can't be undone. Call `routine_resume` with `approve: true` to go on, or `false` to stop.
- **Needs a choice.** A step changed. The result shows the recorded and current crops as text and up to three candidate elements. Call `routine_resume` with the `ref` of the right one.
