# Refine a routine

An agent does not save every run. After it finishes a browser task it decides, on its own and without asking the person, whether the task is likely to repeat and worth keeping, and if so it turns the run into a routine in four steps. Nothing is saved or rewritten until the agent says so.

1. **`routine_propose`** with a name and a description, and optionally `do_not_use_for`. It drafts from the latest run unless given a `run_id`, or from a saved routine with `from_routine`. It returns a draft: every recorded step, numbered, with the page it happened on, the action, the target, and what happened after it ("navigated to /apps", "new on the page: “Release published”").
2. **`routine_edit`** changes the draft.
3. **`routine_test`** replays the draft on the live site.
4. **`routine_save`** saves it. It can still change the `name`, `description` and `do_not_use_for` as it saves.

## Hints

The draft ends with hints. A hint is a suggestion with the exact edit that would apply it. It is never applied for you.

| Hint | What it means |
|---|---|
| Navigation only | A run of steps that only got from one page to another, followed by a step at a known address. Replace them with that address. |
| Dialog | A click inside a dialog that only answered it ("Go to overview", "Not now"). The recording notes which dialog an element sat in. |
| Retry | The same field typed twice, or the same click twice in a row. |
| Side effect | A step that submits, publishes, pays or deletes. It stays and keeps its pause. |
| Off site | A step on another site. The save is refused while it is in. |

A real case: publishing to a testing track shows a dialog offering to go back to the overview. The recorded run clicks through it and then clicks its way to the page the next step needs. The hint says those clicks only get to one address, and the agent replaces them with `navigate <that address>`. The routine is shorter and does not depend on the dialog.

A run done with the [`script`](tools.md#a-whole-task-in-one-script) tool drafts the same way, and the values and checks it marked with `param` and `expect` are already applied.

## Edits

`routine_edit` takes a list of up to 40 edits. They apply in order, all or none, and the numbered draft comes back. `undo` goes back through the last 20 edits.

| Edit | Does |
|---|---|
| `remove` | Drop steps, by number or range such as `"3-5"`. |
| `navigate` | Replace steps `from` to `to` with one step that opens an address. |
| `open` | Add a step that opens an address before step N. |
| `handoff` | Add a step before step N that gives the tab to the person, for a login or a code, and waits until they give it back. A test skips it and says so. |
| `param` | Make a typed value a parameter, by `step` or by `value`. Without either, declare a parameter to use as `{{name}}` in an address. `description` says what to give, and `example` is shown as a hint and never published. |
| `fixed` | Keep the recorded value instead of asking for it. |
| `pause` | Add a pause before a step, or take away one you added. |
| `note` | Text for the agent that runs the routine: what to check at this step, up to 1000 characters. Empty clears it. |
| `first_in_list` | A click that takes whatever is first in the list next time. |
| `read` | Adds a step that reads an element's text and returns it under a name you give (`as`). Give `step` to reuse the element another step uses, or `before` with `name` or `text` (and `role`) for an element nothing clicked. `where: after` puts it after that step instead of before. The run result carries it. |
| `retarget` | Changes what a step looks for: role, accessible name, text, CSS or the nearby heading. Use it when the recorded name holds text that changes, like a chat row's last message. Steps that submit, publish, pay or delete cannot be retargeted. |
| `each` | Repeat steps `from` to `to`: for each value of a parameter (`param`), or for each element on the page like the one a step used (`step`). At most `limit` times, 25 unless you say, 100 at the most. |
| `if` | Run steps `from` to `to` only when the page shows `text` or has the element a step used (`has_step`). Steps after `to` up to `else_to` run otherwise. `not` turns it round. |
| `describe` | Change the name, description or "do not use for". |
| `expect` | What the page shows once the task has worked: `text` it shows, part of the `url`, each up to 300 characters. Can use `{{name}}`. Empty clears it. |
| `undo`, `reset` | Back one edit, or back to the proposal. |

## Loops and branches

A routine that adds one row, posts one listing or fills in one line is often a routine someone wants to run for twenty. Record it once, then wrap the steps that repeat:

```json
[{ "op": "param", "step": 2, "name": "item" }, { "op": "each", "from": 2, "to": 3, "param": "item" }]
```

Now `item` takes several values, one per line, or separated by commas when they are all on one line. Each pass has one of them as `{{item}}`. A run given more values than the limit stops before doing anything.

For a list on the page, name the step that used the first row: `{ "op": "each", "from": 2, "to": 3, "step": 2 }`. That step takes each row like it in turn, and a pass that takes its row off the list does not skip the next one. It stops at the end of the list or at its limit, and says when there may be more.

A notice that only sometimes shows is the usual branch: `{ "op": "if", "from": 2, "to": 2, "has_step": 2 }` closes it when it is there and carries on when it is not. A branch waits a moment and looks again before it decides no, because pages show notices late.

What stays the same:

- A step that submits, publishes, pays or deletes pauses on every pass. Saying yes once says yes once.
- A loop over elements stops when the row it reaches has a button that looks irreversible and was not what was recorded.
- `routine_test` runs the way the page goes today and says when the other way was not tried. Change the page and test again to try both.
- A loop cannot go inside a loop. A branch can go inside a loop, and inside another branch.

## What the extension refuses

The agent does not enforce these. The extension does, whatever the agent asks for.

- **A step that submits, publishes, pays or deletes cannot be removed or replaced, and its pause cannot be switched off.** Edit the steps around it.
- **An address stays on the routine's own site.** Its host is the site or a subdomain of it, on a registrable domain that was recorded. It must be https, except for a page that was recorded over http.
- **An address cannot carry a per-session value.** Long random strings, UUIDs and parameters such as `sid`, `token` or `state` are refused. Write the part that changes as `{{name}}` and declare a parameter, or keep the clicks. A numeric item id is allowed and said out loud: the routine then stays on that item.
- **The result must pass the rules the directory applies at publish**, so a routine that would be turned away is caught here, with the reason.

## Test, then save

`routine_test` replays the draft once, with no model, using the recorded values or the ones the agent passes. It never performs a step that pauses and never approves one, so nothing irreversible runs; steps after a skipped one are still checked. The result says what each step did and where the tab ended up.

A draft that replaces a saved routine (`from_routine`) can only be saved after its latest edit tested well. A step that fails only because it follows a skipped one does not count against it, and the result says which steps were not checked.

People who record a demo in the side panel still get the automatic compile: the Save view shows the result and they approve it.

## Did it work?

A replay checks every step, and every step can still pass without the task having happened: a form that quietly rejects a value, a list that did not take the new row. In the benchmarks this was the worst kind of failure, because the run reported success.

A routine that has an `expect` looks for it after the last step, for up to five seconds. If the page does not show it, the result says all the steps ran and this may not have worked, and tells the agent not to report success until it has looked. `routine_test` fails on it, and skips the check when it skipped a paused step, since the task has not finished then.

## Routines that tidy themselves

Each routine keeps a record of its runs on this computer, in `.stats.json` in its folder: whether it finished, which steps had to be fixed, which steps were slow. Nothing is sent anywhere. The result of a run uses it:

- A step that no longer matched and needed a choice is named, with how to refine it.
- A step that took over five seconds in each of the last three runs is named, in case a direct address can replace the way there.
- A routine whose last three runs failed or needed a fix is **stale**. `routines_list`, `routine_describe` and the result all say so, and search ranks it lower.

Saving a refined version clears the mark, because the runs before it say nothing about the routine as it is now. A refined version has to pass `routine_test` like any other.
