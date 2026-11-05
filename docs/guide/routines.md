# Routine format

A routine is a skill for the browser: a folder with notes that tell an agent when to use it, and steps that the extension replays without a model.

```text
~/.agentic-routines/routines/<owner>/<name>/
  ROUTINE.md     what it is and when to use it
  steps.json     compiled steps, read only by the replayer
```

Your own routines live under a local owner. Installed ones live under their owner's handle, or `gh_<owner>` when they came from a Git repository.

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
| `params` | The values asked for on each run. Types are `string` and `file`. |
| `pauses` | Step numbers where the replay stops before going on. |
| `returns` | What the routine gives back. |
| `instructions` | Notes for the agent that runs it, up to 4000 characters. See [Hooks and instructions](/docs/hooks). |
| `hooks` | Code on events, one function per event. Off until the person allows it. See [Hooks and instructions](/docs/hooks). |
| `version` | Goes up with every save. A fixed step is saved as the next version. |

Agents see only `name`, `description` and `params` up front. The body comes back from `routine_describe`, and the steps never reach the agent, apart from the notes an author wrote on a step, which come back in a run's result inside a marked block.

## Steps

Steps are declarative: navigate, click, type, select, upload, wait and read. A step is never a script. Code can only come in as [hooks](/docs/hooks), which run in a sandbox with no network, return a short list of requests the extension checks, and stay off until the person reads and allows them. Each step carries the locators the replayer checks and a label for people to read.

## Share a routine through Git

A routine can live in a GitHub repository as one file: the notes first, then the steps in a fenced `steps` block. A `config.routine` in the repository root lists the files and says what each is for ([Routine repositories](/docs/repositories)); without one, the files go under `routines/`. Export one from your machine:

```bash
npx agentic-routines export play-release > routines/play-release.md
```

The same checks that people run on install run here first, so a problem is found before you commit. See [Sharing](/docs/sharing).
