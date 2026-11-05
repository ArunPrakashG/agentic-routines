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
| `description` | What it does, then a "Use when" clause in the words a person would say. Required, at most 1024 characters. This is what an agent reads to choose it. |
| `params` | The values asked for on each run. Types are `string` and `file`. |
| `pauses` | Step numbers where the replay stops before going on. |
| `returns` | What the routine gives back. |
| `version` | Goes up with every save. A fixed step is saved as the next version. |

Agents see only `name`, `description` and `params` up front. The body comes back from `routine_describe`, and the steps never reach the agent.

## Steps

Steps are declarative: navigate, click, type, select, upload, wait and read. A routine cannot contain a script. Each step carries the locators the replayer checks and a label for people to read.

## Share a routine through Git

A routine can live in a GitHub repository as one file: the notes first, then the steps in a fenced `steps` block. A `config.routine` in the repository root lists the files and says what each is for ([Routine repositories](/docs/repositories)); without one, the files go under `routines/`. Export one from your machine:

```bash
npx agentic-routines export play-release > routines/play-release.md
```

The same checks that people run on install run here first, so a problem is found before you commit. See [Sharing](/docs/sharing).
