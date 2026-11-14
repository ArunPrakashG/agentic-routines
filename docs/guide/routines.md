# Routine format

A routine is a skill for the browser: a folder with notes that tell an agent when to use it, and steps that the extension replays without a model.

```text
~/.agentic-routines/routines/<owner>/<name>/
  ROUTINE.md     what it is and when to use it
  steps.json     compiled steps, read only by the replayer
```

Your own routines live under a local owner. Installed ones live under their owner's handle, or `gh_<owner>` when they came from a Git repository.

A routine can also live in a project's own repository, in `.agentic-routines/routines/`, so Git tracks it and the team reviews it in pull requests. `npx agentic-routines project add <routine>` copies one there. See [Project routines](project.md).

## ROUTINE.md

The front matter is the routine's contract. The body is for people and for your agent when it asks for the full notes.

```markdown
---
name: play-release
owner: arunprakashg
version: 4
site: play.google.com
urls:
  - play.google.com/console/u/*/developers/*/app/*/tracks/*
description: >
  Upload an Android App Bundle to a Google Play Console testing track and
  start the rollout. Use when the user asks to ship, release or upload an
  Android build to internal, closed or open testing on Google Play.
params:
  version_name: { type: string, description: "Release name, e.g. 2.15.0 (215)" }
  release_notes: { type: string, description: "What's new text, en-US" }
  bundle: { type: file, accept: ".aab", description: "Path to the .aab on this machine" }
pauses: [20]
returns: Release name, version code and rollout status.
---

## Before running
The app must already exist in Play Console and the bundle must be signed.

## Do not use for
Production releases. This routine only covers testing tracks.
```

| Field | Meaning |
|---|---|
| `name` | Lower case letters, digits and dashes. Becomes the tool name `rt_<name>`. |
| `site` | The one site the routine works on. A step that leaves it stops the replay. |
| `urls` | The pages the routine applies to, as globs: a host on `site` and a path, with `*` for one part (an id, a number) and a closing `**` for the rest. No `https://`, no query. At most 8. Left out, they are worked out from the recorded pages. `navigate`, `read_page` and `routines_search` match the page an agent is on against them. |
| `surface` | Where the routine acts. `browser` (the default, and the only one that runs today). `desktop` is reserved so desktop steps can come later without a format change; a routine that says it is read, listed as not supported yet, and not run or published. |
| `description` | What it does, then a "Use when" clause in the words a person would say. Required, at most 1024 characters. This is what an agent reads to choose it. |
| `params` | The values asked for on each run. Types are `string` and `file`. A `file` param can say which files it takes with `accept`, such as `".aab"`. `example` is the value seen when it was recorded; it is shown as a hint, kept on this computer and never published. |
| `secrets` | The names of the [secrets](/docs/safety#secrets-you-keep-for-a-site) the routine types, as `{{secret:name}}` in its steps. The value is never in the file. |
| `pauses` | Step numbers where the replay stops before going on. |
| `returns` | What the routine gives back. |
| `expect` | How the page looks when the task worked: `text` the page shows and part of the `url`, each at most 300 characters and able to use `{{params}}`. Every step can run and the task still not happen; this is how a run tells. See [Refine a routine](/docs/refine). |
| `viewport` | The window size when it was recorded: `w`, `h` and `dpr`. See [Window size](/docs/how-it-works#window-size). |
| `drafted_by` | The agent that wrote the description, such as `claude-code`. The side panel shows it. |
| `repo` | Set when installed from a repository: its name and what its `config.routine` tells the agent. |
| `instructions` | Notes for the agent that runs it, up to 4000 characters. See [Hooks and instructions](/docs/hooks). |
| `hooks` | Code on events, one function per event. Off until the person allows it. See [Hooks and instructions](/docs/hooks). |
| `version` | Goes up with every save. A fixed step is saved as the next version. |

Agents see only `name`, `description` and `params` up front. The body comes back from `routine_describe`, and the steps never reach the agent, apart from the notes an author wrote on a step, which come back in a run's result inside a marked block.

## Steps

Steps are declarative. Each one is one of these:

| Step | What it does |
|---|---|
| `navigate` | Goes to an address. |
| `click`, `hover` | Clicks or points at an element. A click can be a right or middle click, a double click, with keys held, or on one spot of the element (a canvas, a map, a slider). |
| `type`, `clear` | Types into a field, or empties it. The value can be text, `{{param}}` or `{{secret:name}}`. |
| `select`, `set` | Picks an option, or puts a field, checkbox or list into a state (what `form_input` records). |
| `upload` | Gives a file to a file input, from a `file` param. |
| `press` | Presses keys, such as `Enter` or `ctrl+a`. |
| `drag`, `scroll` | Drags an element to another, or scrolls by a distance. |
| `wait`, `read` | Waits for the page, or reads text from it for the result. |
| `dialog` | Answers a browser dialog yes or no, with text when it asks for some. |
| `handoff` | Asks the person to do something, such as a sign-in, and waits for them. |
| `each`, `if` | Repeat the steps after them, or only run them sometimes ([Loops and branches](/docs/refine#loops-and-branches)). |

A step can also pause before it runs (`pause`: `auto` when it looked irreversible, `author` when someone asked for it), and a click can pick whatever is first in a list now instead of the item recorded (`pick: first`), or the item a loop is on (`pick: each`). A step is never a script. Code can only come in as [hooks](/docs/hooks), which run in a sandbox with no network, return a short list of requests the extension checks, and stay off until the person reads and allows them. Each step carries the locators the replayer checks and a label for people to read.

## As Playwright code

A routine's steps compile to a Playwright script, with its parameters, loops and branches. It is worked out from the steps with no model, so it costs nothing to make and cannot drift from them. `routine_playwright` gives it to an agent, and `agentic-routines export <routine> --playwright` prints it. Secrets stay placeholders: the script reads them from the environment when it runs, and they are never written into it.

`routine_run` with `fast: true` runs a routine through that code. It stops at every pause, and leaves steps that use a stored secret, hand over to a person, say yes to a dialog or only the replay can do to the replay. On any failure it carries on step by step from that step, with the usual checks. A routine with hooks always goes step by step.

Fast run saves time, not tokens. A normal replay already calls no model. Whether it becomes the default depends on `dev/bench/fast.mjs`, which compares the two on the same routine. It stays off unless asked for, and it has not been measured yet.

Agents should not reach for Playwright on a page they have not seen. It needs to know the page in advance, and a failure tells it little. The step tools tell an agent what each step did.

## Share a routine through Git

A routine can live in a GitHub repository as one file: the notes first, then the steps in a fenced `steps` block. A `config.routine` in the repository root lists the files and says what each is for ([Routine repositories](/docs/repositories)); without one, the files go under `routines/`. Export one from your machine:

```bash
npx agentic-routines export play-release > routines/play-release.md
```

The same checks that people run on install run here first, so a problem is found before you commit. See [Sharing](/docs/sharing).
