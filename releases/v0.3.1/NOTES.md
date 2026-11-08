# 0.3.1

Small changes that make routines sturdier and easier to author.

## Routines
- `routine_edit` can add a step that reads an element's text and returns it under a name in the run result, either from an element a step already uses or from one found by its name or text.
- `routine_edit` can change what a step looks for, so a recorded name that holds changing text (a chat row with its last message) can be made stable.
- A name that starts with a stable part, such as a person and then their latest message, still matches when the rest changes.
- `match_viewport` sets the size of the tab alone, without touching the window or the person's other tabs.
- A run waiting on a pause that the agent then went past by hand, or started again, ends instead of holding the routine.

## Driving the page
- `read_page` waits up to three seconds while a page is still drawing itself. A screenshot waits briefly for it to settle.
- Routine tools ask the client to load them at start, for clients that otherwise defer tools.

## Updates
- The install bundle is signed, so installed copies can update themselves.
