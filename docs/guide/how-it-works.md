# How it works

## Record

The extension gives your agent a small set of browser tools: open a page, read it, click, type, select, upload and press a key. While your agent uses them, every step is recorded. Nothing leaves your computer.

## Save

After a task, your agent decides whether it is worth keeping: a chore you will want again is, a one-off lookup is not. If it is, the run becomes a draft that the agent refines before anything is saved. See [Refine a routine](/docs/refine).

- **The agent edits, nothing is rewritten silently.** The draft numbers every recorded step and hints at what could go: retries, clicks that only navigated, a dialog that was answered. The agent applies the edits it agrees with.
- **Typed values become choices.** Each value typed can become a parameter that the routine asks for each run, such as a version name or release notes. Everything else stays as recorded.
- **Risky steps get a pause.** Steps that publish, pay, delete, submit or confirm are marked, so a replay stops before them. The extension does not let an edit remove one.

The agent also writes a description: what the routine does, and when to use it, in the words you would say. That description is how an agent decides to use it.

## Replay

A saved routine shows up as a tool named `rt_<name>`, with its parameters. Calling it replays the steps in the browser without asking a model. Replay returns a short text result: steps run, pauses, time. No page snapshots come back, so your agent's context stays small.

Before each step, the replayer checks the page, in this order, and stops at the first check that settles it:

1. **Page structure.** The address pattern and the page's headings, form labels and main regions. This catches a wrong page early.
2. **The element.** Its role and name, its visible text, stable attributes and its place on the page. It must match exactly one element.
3. **A screenshot crop.** The area around the element is compared to the one recorded. Password fields are always masked.

If they agree, the step runs. If the element is missing or matches more than one, the step has changed. The replay pauses and your agent, which is already running, picks the right element. The fix is saved for next time. If your agent can't pick, it finishes the task by hand and that run is saved as the next version.

### What you see in the tab

While a replay or your agent drives a tab, its edges glow, a cursor glides to each element with a label for the action, and the element is outlined as it is used. The glow turns amber when the replay waits for you at a pause, and it ends when the run does. It never takes mouse input, and it is hidden for every screenshot, so it never changes what the checks above see. With reduced motion turned on, the cursor jumps instead of gliding.

## Pauses

A replay always stops before a step you can't undo: publishing, paying, deleting. It waits for you, or for your agent to approve with `routine_resume`. A routine author can add pauses. A routine can never remove one that was detected.

## Secrets

A value typed into a password field is never saved. It becomes a placeholder, and the browser's existing sign-in does the work. Most runs need no secret at all.

## What stays on your computer

Routines, recordings and screenshot crops live in `~/.agentic-routines` on your machine. Crops are never published. See the [privacy page](/privacy) for the full list of what is sent when you sign in or publish.
