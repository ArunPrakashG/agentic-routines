# 0.3.2

## Asking you in your agent's window
- A paused replay is put to you as Allow or Stop in the agent's own window when the agent can ask (Claude Code can). Your answer goes straight to the extension, not through the model.
- A pause on someone else's routine that looks irreversible comes back to the agent too, so it can be answered there, instead of waiting only in the side panel.

## Updates
- An extension loaded by hand checks GitHub once a day for a newer release and says so in the side panel. Store copies update through their store and skip the check.

## Signing in
- Sign in with GitHub, Microsoft, or an email and password, as well as Google. Signing in stays optional.

## Project routines
- `agentic-routines project add` keeps a routine in a project's own repository. An agent started in that repository finds it, and you install it from the side panel once. A Share button in the side panel does the same.

## Earlier in 0.3.x
- `routine_edit` can read an element's text into the run result and change what a step looks for.
- `read_page` waits for a busy page; routine tools ask the client to load them at start.
