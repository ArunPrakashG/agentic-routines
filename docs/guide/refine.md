# Refine a routine

An agent does not save every run. After it finishes a browser task it decides, on its own and without asking the person, whether the task is likely to repeat and worth keeping, and if so it turns the run into a routine in four steps. Nothing is saved or rewritten until the agent says so.

1. **`routine_propose`** with a name and a description. It returns a draft: every recorded step, numbered, with the page it happened on, the action, the target, and what happened after it ("navigated to /apps", "new on the page: “Release published”").
2. **`routine_edit`** changes the draft.
3. **`routine_test`** replays the draft on the live site.
4. **`routine_save`** saves it.

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

## Edits

`routine_edit` takes a list of edits. They apply in order, all or none, and the numbered draft comes back.

| Edit | Does |
|---|---|
| `remove` | Drop steps, by number or range such as `"3-5"`. |
| `navigate` | Replace steps `from` to `to` with one step that opens an address. |
| `open` | Add a step that opens an address before step N. |
| `param` | Make a typed value a parameter, by `step` or by `value`. Without either, declare a parameter to use as `{{name}}` in an address. |
| `fixed` | Keep the recorded value instead of asking for it. |
| `pause` | Add a pause before a step, or take away one you added. |
| `note` | Text for the agent that runs the routine: what to check at this step. |
| `first_in_list` | A click that takes whatever is first in the list next time. |
| `describe` | Change the name, description or "do not use for". |
| `undo`, `reset` | Back one edit, or back to the proposal. |

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
