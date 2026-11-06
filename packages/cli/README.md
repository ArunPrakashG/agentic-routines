# Agentic Routines

A cache for your agent's browser work. Repeat tasks replay as one tool call, with no model.

```
npx agentic-routines setup
```

That one command connects every browser and agent it finds (Claude Code, Codex, GitHub Copilot, OpenCode; Chrome, Edge, Brave, Vivaldi, Firefox). Then install the extension and open its panel.

```
npx agentic-routines doctor
```

Says what is connected and what is not.

## The directory

Your agent can look for a routine someone else already published, and send yours for review.

- `routines_search` finds routines by words or by the site you are on.
- `routine_install` saves one to your machine, under its owner's name.
- `routine_publish` asks you to approve in the side panel, where you see what becomes public, then sends it for review. Nothing is listed until a person approves it. Needs a signed-in account.
- `routine_submissions` shows where what you sent stands. It only reads: withdrawing is yours to do in the side panel.

## Other sources

Routines can also come from a GitHub repository or a folder on your computer. A routine is one `.md` file in a `routines` folder; `agentic-routines export <routine>` prints one.

```
agentic-routines sources                                  # list
agentic-routines sources add github.com/owner/repository
agentic-routines sources off github.com/owner/repository  # also: on, remove
```

- `routines_search` also looks in the sources you added, and marks those results as not reviewed.
- `routine_install_from_git` only asks. The side panel shows every step and the commit it is pinned to, and nothing is installed until you click Install. An agent cannot add a source or install from one on its own.
- The routine is checked again on this machine (every step on its own site, known actions, no secrets) and refused if it fails. A later commit is never applied by itself.
- The block list from the directory is read at least daily. Routines already installed from a blocked repository or publisher turn themselves off, with a note, and stay off.

https://github.com/ArunPrakashG/agentic-routines
