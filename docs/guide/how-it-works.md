# How it works

## Record

The extension gives your agent a small set of browser tools: open a page, read it, click, type, select, upload and press a key. While your agent uses them, every step is recorded. Nothing leaves your computer.

## Save

After a task, your agent decides whether it is worth keeping, without asking you: a task that will likely repeat and would save real work on replay is, a one-off lookup is not. If it is, the run becomes a draft that the agent refines before anything is saved. See [Refine a routine](/docs/refine).

- **The agent edits, nothing is rewritten silently.** The draft numbers every recorded step and hints at what could go: retries, clicks that only navigated, a dialog that was answered. The agent applies the edits it agrees with.
- **Typed values become choices.** Each value typed can become a parameter that the routine asks for each run, such as a version name or release notes. Everything else stays as recorded.
- **Risky steps get a pause.** Steps that publish, pay, delete, submit or confirm are marked, so a replay stops before them. The extension does not let an edit remove one.

When the agent does the same steps a second time, the result of the step that completes the repeat says so, in one line, and the agent takes that as its cue to save. Steps count as the same by site, kind of step and the field or kind of element they touch, so different values still match; a retry does not break a match. It needs at least five steps, two of them more than just opening a page. It says nothing if a routine you have on that site already covers more than half of those steps. It compares runs recorded on your computer, up to the last 20, and nothing else. A pass that took a really different path, or that works on pages whose addresses differ by more than an id, is not noticed.

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

The tab's title says who has it: `🟣 Claude Code · Page title`. The mark stays while that agent holds the tab, and a page that changes its own title keeps it. A title belongs to the page, so a page that puts its own back every time wins after a few rounds, and the mark is dropped for that page. Where the browser has tab groups, the held tab is also put in a group named for its agent, which a page cannot change; a tab that is alone in its window or already in one of your groups is left out of that. Two sessions of one agent are told apart by a number. When the agent is done (its session ends), the tabs it opened are closed and its group goes with them. A tab of yours that the agent was pointed at is never closed, and neither is a tab you are looking at.

### Real input

In Chromium browsers clicks, typing and keys go through the browser's debugging connection, so a site sees them the way it sees a person's. This is why the browser shows a bar saying Agentic Routines is debugging it, while a tab is being driven and for a minute after. Pressing Cancel on that bar is respected for ten minutes: clicks and typing fall back to DOM events, which some sites ignore. Firefox has no such connection and always uses DOM events.

After a click the extension checks it reached the element. If something is drawn on top, the agent is told what, since a person could not have clicked it either.

### Behind your tabs

A replay runs in the agent's own tab, opened behind what you are looking at, or in a window of its own when another agent is working. It does not switch your tab, take your focus or use your keyboard. A pause waits in the side panel and puts a badge on the toolbar icon; the page does not come forward. Input goes through the browser's debugging connection, so pages get it without being in front.

Some pages only finish drawing or loading in front. If a step does not match while its tab is behind another, the result says so, and the agent can ask you to bring it forward. The picture check needs the tab in front, so behind another tab the page structure and the element decide. In a browser without a debugging connection, input is less reliable behind another tab.

### Several agents at once

Each agent session works in a tab of its own and holds it, so two agents never click in the same page. A lone agent works in the tab you are looking at. When a second one starts, it gets a window of its own rather than yours or the first agent's. A tab one agent holds is locked to the others: they get an error that names who has it, and `tabs` lists each tab's holder. A tab is let go when its agent disconnects, or after 15 minutes without a call. The same routine runs once at a time, so a second call waits for the first and gives up after two minutes, saying who has it. Pictures for the checks are taken one at a time, whichever session asks.

### Several browser profiles

Each browser profile with the extension (a work and a personal Chrome profile, say, which may be signed in to the same account or to different ones) runs on its own and shows up to the agent as a separate browser. Routines are shared by all of them, since they live in one folder on your computer. Tabs, locks and recorded runs belong to a profile.

An agent works in the profile you used last, and the first answer it gets says so when more than one is open. It can list them and switch with `browser_profile`, or start in one with `AGENTIC_ROUTINES_PROFILE` (a name, an account email or an id). Switch before a task rather than in the middle of one: a run being recorded stays in the profile it started in. Two agents in different profiles can run the same routine only one after the other, because the routine often acts on the same account: the second waits, then says who has it. Give a profile a name you will recognise with `agentic-routines profiles name <number> <name>`; without one it is shown by the account it is signed in to.

## Pauses

A replay always stops before a step you can't undo: publishing, paying, deleting. It waits for you, or for your agent to approve with `routine_resume`. A routine author can add pauses. A routine can never remove one that was detected.

## Secrets

A value typed into a password field is never saved. It becomes a placeholder, and the browser's existing sign-in does the work. Most runs need no secret at all.

## What it saves

The side panel and `agentic-routines stats` show what your routines saved, this week and per routine.

The replays are measured: how many ran, how long they took and the model calls they needed. What they replaced is estimated. A replay saves about 24k tokens for each step it does in place of the model, less 45k for the replay itself, and saving a routine costs about 625k once, for proposing, editing and testing it. Those come from benchmarks of ten tasks on real sites with Sonnet, reproduced by `dev/bench/calibrate.mjs`. They count every token the model processed, including cached context, which is billed at a fraction of the price. So a short routine can show a loss, and a new one shows as not paid back until it has run enough. A stopped run counts against the total.

Your own numbers will differ. Only the agent's runs count, not the ones you start in the panel.

## What stays on your computer

Routines, recordings and screenshot crops live in `~/.agentic-routines` on your machine. Crops are never published. See the [privacy page](/privacy) for the full list of what is sent when you sign in or publish.

## Window size

A routine records the size of the page it was recorded on (width, height and pixel ratio). A replay compares it with the page it finds.

- In the same responsive band (phone, tablet, laptop, desktop, wide) nothing changes and nothing is said.
- One band over and close in width, the replay goes on as usual.
- Very different, say a phone-sized window for a routine recorded on a desktop: the layout can differ, so the result and the side panel say so, the picture check is switched off for that run, and the page structure and the element decide. The stored picture is not rewritten, so a later run at the right size still uses it.

`routine_run` with `match_viewport: true` resizes the window to the recorded size first, when it is a normal window, and puts it back when the run ends. It leaves the window alone when other tabs are in it, and says so. Routines saved before this was added have no size and replay as before.
