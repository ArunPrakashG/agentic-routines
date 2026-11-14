# 0.3.4

## A whole task in one call
- New `script` tool. An agent writes a short JavaScript program whose helpers (`open`, `click`, `type`, `fill`, `select`, `upload`, `read` and more) are the usual step tools, so a task that took a dozen calls takes one or two. Every helper is recorded, so the run saves as a routine like any other.
- `param(name, value)` and `expect(text)` in a script mark what changes each run and what the page says once it worked. Saving the run applies both.
- When a helper misses, the script stops and the reply shows the page it stopped on, so the agent can carry on without reading again.
- `read` in a script leaves out lines the last read already showed, such as a site menu, and folds long runs of rows that look alike.

## Faster steps
- A step after filling a field waits less before it goes on.

## Fixes
- The sign-in screen no longer lists syncing routines across browsers, which it does not do.
- `routine_run` described its `fast` and `flight_recorder` options the wrong way round.

## Documentation
- Every feature is now in the docs, with a new page on the side panel. Pages that still described asking before a script runs, or Google-only sign-in, are corrected.
