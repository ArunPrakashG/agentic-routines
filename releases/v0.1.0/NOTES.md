# 0.1.0

First packaged build. Not yet in any store.

- An MCP server for Claude Code, Codex, GitHub Copilot and OpenCode that drives the browser and records every run.
- Save a run as a routine with values filled in each time. Replay it with no model, as one tool call.
- Each step is checked against the page before it runs. A changed step goes back to the agent, and the fix is saved as a new version.
- Pauses before steps that cannot be undone.
- Side panel with routines, recorded runs, replay controls and a save view. Record a demo by doing the task yourself.
- Optional Google sign-in.
- `npx browser-routines setup` connects every browser and agent it finds. `doctor` says what is connected.
- Chrome, Edge and Firefox packages, the source Firefox asks for, and the npm package.

Not in this build: sync, publishing to the directory, or the public site.
