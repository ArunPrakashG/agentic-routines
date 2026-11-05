# Routine repositories

A Git repository can hold routines for other people to install. Put a `config.routine` file in its root and it says what the repository is, what each routine is for, and what your agent should keep in mind. Agentic Routines is free and open source, and so is sharing this way: nothing here costs anything or needs an account.

Routines from a repository are not reviewed by Agentic Routines. The side panel says so, shows every step and any notes before anyone installs, and pins the commit it read.

## The file

`config.routine` is YAML. It sits in the root of the repository.

```yaml
version: 1
name: acme-console-routines
description: Routines for the Acme Console, kept by the Acme release team.
instructions: |
  These routines run in the user's signed-in browser. Ask the user which build to release
  before you run any of them, and never type a password.

routines:
  - name: acme-release
    description: >-
      Start a rollout of a build to internal testing on the Acme Console.
      Use when the user asks to release, roll out or ship a build to testers.
    path: routines/acme-release.md
    sites: [console.acme.test]
    instructions: Check that the version name matches the changelog before you run it.
    params:
      version_name: The version to release, like 2.14.0.
      release_notes:
        description: What changed, in a sentence.
        type: string

  - name: acme-export-history
    description: Export the release history as a CSV. Use when the user wants the list of past releases.
    path: routines/acme-export-history.md
    sites: [console.acme.test]
```

The same repository is in the project as `dev/fixtures/routine-repo`, and the tests install it.

### Repository fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. |
| `name` | yes | Lowercase letters, digits and dashes. |
| `description` | yes | What the repository is for, up to 500 characters. |
| `instructions` | no | Notes for the agent about the repository as a whole, up to 4000 characters. |
| `routines` | yes | The list below, 1 to 50 routines. |

### Routine fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Must match the `name` in the routine file. |
| `description` | yes | What it does, then “Use when” and the words a person would say. Up to 1024 characters. It replaces the file's own description when the routine is installed, so what a person reads in the panel is what the agent reads. |
| `path` | yes | The routine file, relative to the repository root, ending in `.md`. No `..`. |
| `instructions` | no | Notes for the agent about this routine, up to 4000 characters. |
| `sites` | no | The hosts the routine works on. If set, the routine file's site must be one of them or under one, or the routine is left out. |
| `urls` | no | The pages the routine applies to, as globs like `console.acme.test/releases/*`. Replaces the pages in the routine file, which are otherwise worked out from its steps. See [Routine format](/docs/routines). |
| `params` | no | What each value is for, as a short text or a set with `description` and `type` (`string` or `file`). The routine file decides which values exist. |
| `hooks` | no | Code to run on events, one function per event. Off until the person has read it and allowed it in the side panel. See [Hooks and instructions](/docs/hooks). |

Unknown fields are an error, so a typo does not go unnoticed.

## The routine files

Each `path` points at a routine file, the same file `npx agentic-routines export <routine>` prints: the notes first, then the steps in a fenced `steps` block. See [Routine format](/docs/routines).

## Without a config.routine

A repository without one still works the way it did:

- `routines/<name>.md`, one file per routine, with the file named after the routine.
- A single `ROUTINE.md` in the root, for a repository that holds one routine.

If `config.routine` is there but wrong, the repository is not read as either of those. That would hide the mistake. The panel and `sources add` say what is wrong instead.

## Check it before you push

```bash
npx agentic-routines sources check .
```

It reads the folder the way a source would and prints every problem with the file, the line and the field:

```text
bad config.routine:12 routines[0].sites[0]: Must be a host name like console.acme.test, with no https:// and no path.
bad config.routine:8 routines[1] (routines/acme-export-history.md): the file is named “acme-history”, not “acme-export-history”.
```

## What the agent sees

Notes in `instructions` are meant for the agent, and the agent is told they were written by someone else. They appear:

- in the tool description of the installed routine,
- in `routine_describe`,
- in `routines_search`, once for a repository,
- after a replay finishes.

Each time they are wrapped in a marked block with a boundary the text could not have known, and the block says it is not from the user. The side panel shows the same notes to the person before they install.

Write notes about the routine, not about the agent. Anything that asks the agent to do something unrelated to the routine is a reason to not install it.

## Taking it further

- Add the repository: `npx agentic-routines sources add github.com/owner/repository`, then install from the side panel.
- To list a routine in the reviewed [directory](/directory) as well, publish it from the side panel. The directory is free to publish to and install from.
