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

The tab's title says who has it: `🟣 Claude Code · Page title`. The mark stays while that agent holds the tab, and a page that changes its own title keeps it. A title belongs to the page, so a page that puts its own back every time wins after a few rounds, and the mark is dropped for that page. Where the browser has tab groups, the held tab is also put in a group named for its agent, which a page cannot change; a tab that is alone in its window or already in one of your groups is left out of that. Two sessions of one agent are told apart by a number.

### Several agents at once

Each agent session works in a tab of its own and holds it, so two agents never click in the same page. A lone agent works in the tab you are looking at. When a second one starts, it gets a window of its own rather than yours or the first agent's. A tab one agent holds is locked to the others: they get an error that names who has it, and `tabs` lists each tab's holder. A tab is let go when its agent disconnects, or after 15 minutes without a call. The same routine runs once at a time, so a second call waits for the first and gives up after two minutes, saying who has it. Pictures for the checks are taken one at a time, whichever session asks.

## Pauses

A replay always stops before a step you can't undo: publishing, paying, deleting. It waits for you, or for your agent to approve with `routine_resume`. A routine author can add pauses. A routine can never remove one that was detected.

## Secrets

A value typed into a password field is never saved. It becomes a placeholder, and the browser's existing sign-in does the work. Most runs need no secret at all.

## What stays on your computer

Routines, recordings and screenshot crops live in `~/.agentic-routines` on your machine. Crops are never published. See the [privacy page](/privacy) for the full list of what is sent when you sign in or publish.

## Window size

A routine records the size of the page it was recorded on (width, height and pixel ratio). A replay compares it with the page it finds.

- In the same responsive band (phone, tablet, laptop, desktop, wide) nothing changes and nothing is said.
- One band over and close in width, the replay goes on as usual.
- Very different, say a phone-sized window for a routine recorded on a desktop: the layout can differ, so the result and the side panel say so, the picture check is switched off for that run, and the page structure and the element decide. The stored picture is not rewritten, so a later run at the right size still uses it.

`routine_run` with `match_viewport: true` resizes the window to the recorded size first, when it is a normal window, and puts it back when the run ends. Routines saved before this was added have no size and replay as before.
