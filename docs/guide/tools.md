# Agent tools

The `agentic-routines mcp` command is a Model Context Protocol server that your agent starts over stdio. `setup` writes the config for each agent so you never run it yourself.

## Browser tools

Your agent works in its own tab unless told otherwise. Everything it does with these is recorded.

| Tool | What it does |
|---|---|
| `tabs` | List open tabs: id, title and address. |
| `navigate` | Open an address in the agent tab. Lists saved routines for the site, if any. |
| `read_page` | The page as an outline of roles and names. Interactive elements get a ref such as `ref_12`. |
| `click` | Click an element by ref. |
| `type` | Type into a field by ref. Replaces what is there. `submit` presses Enter after. |
| `select` | Pick an option in a select, by label or value. |
| `upload` | Attach a file from this machine to a file input. |
| `press` | Press a key in the focused element: Enter, Escape, Tab, ArrowDown. |
| `screenshot` | The area around the last element, or the whole tab with `full: true`. `read_page` costs less. |

## Routine tools

| Tool | What it does |
|---|---|
| `rt_<name>` | One tool per saved routine, with its parameters. Replays without a model. |
| `routine_run` | The same, by name, for clients that read tools only at startup. |
| `routine_resume` | Continue a paused replay. `approve` goes past a pause or stops. `choice` picks the element for a changed step. |
| `routines_list` | Saved routines and what each is for. |
| `routine_describe` | The full notes: when to use it, when not to, values it asks for, where it pauses. |
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
| `routines_search` | Search the public directory by words, or by the site a person is on. No account needed. |
| `routine_install` | Install `owner/name` from the directory. It is checked again on this side. |
| `routine_install_from_git` | Ask to install from a GitHub repository. The side panel shows every step, and Install is the person's click. |
| `routine_publish` | Ask to send a routine for review. The person approves in the side panel. An agent can't publish by itself. |
| `routine_submissions` | Where each submission stands: waiting, rejected with the guideline, live or turned off. Read only. |

## A replay that stops

A replay returns one of these:

- **Done.** The result text lists the steps run and the time.
- **Paused.** The next step can't be undone. Call `routine_resume` with `approve: true` to go on, or `false` to stop.
- **Needs a choice.** A step changed. The result shows the recorded and current crops as text and up to three candidate elements. Call `routine_resume` with the `ref` of the right one.
