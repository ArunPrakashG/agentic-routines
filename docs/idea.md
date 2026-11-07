# Agentic Routines: Record Once, Replay Without the LLM

**Status:** idea (logged 2026-11-05)
**Type:** Free, open-source client + free shared routine directory

## Origin
- Coding agents (Claude Code, Codex) repeat the same browser chores step by step every time: drafting a Play Console release, console admin, portal downloads. Each run costs the same tokens and time as the first.
- Wanted: the agent learns that a navigation chain can be skipped and goes straight to the URL next time, and replays an old run with small changes (new version name, new notes).

## Insight
- Most of the cost is the model deciding each step, not the clicks. Caching single tool calls saves little; collapsing a whole run into one tool call saves most of it.
- A routine broken by a site change is fixed once and the fix is useful to everyone who runs the same routine. That shared upkeep is the part a single user or a model company won't do for long-tail sites.

## Product
A custom MCP server plus a Chrome extension.
1. **MCP server (stdio, works with Claude Code and Codex):** basic browser tools, all recorded, plus `routines_list`, `routine_run(name, params)`, `routine_propose` / `routine_edit` / `routine_save`.
2. **Chrome extension (MV3):** actions through `chrome.debugger`, a11y snapshots, one tab group per agent session, native messaging to the server.
3. **Compile on save:** drop navigation that a direct URL load reproduces (checked against the recorded snapshot), turn changing values into params, add pre/post checks per step.
4. **Replay with no LLM.** On a failed step, hand the current page back to the agent, then save the fixed run as a new version.
5. **Safety:** pause before irreversible steps (submit, publish, pay); secrets stored only as `{{secret:name}}` placeholders.
6. **Human demos:** record yourself doing a task once from the side panel; it becomes the first version of the routine.

## Cost
- The whole project is open source and free: the client, the directory of shared routines, publishing and installing. Nothing is sold and there are no plans or tiers.
- The directory is reviewed for safety, and routines for common sites (Play Console, App Store Connect, cloud consoles, bank statement downloads) are shared by the people who make them.

## Landscape (checked 2026-11-05)
- Browser Use cloud "cache script": first run is a full agent run, later runs replay a script, self-heals once on failure.
- Stagehand v3 (Browserbase): action cache keyed on instruction, URL and variables, updates selectors when pages change.
- Qodex, Bug0: cached replay for QA testing.
- workflow-use, muscle-mem: record/replay with agent fallback (not re-checked).
- Claude in Chrome: saved shortcuts.

Gap: none is a drop-in layer for Claude Code and Codex, and none maintains a shared routine library across users.

## MVP (a few weeks)
- Extension and server over native messaging, basic tools working from Claude Code
- Auto-record, `routine_propose` → `routine_edit` → `routine_save`, `routine_run`, multi-locator element lookup, pre/post checks
- Navigation skipping, params, pause before irreversible steps
- Side-panel demo recording
- Ship as a Claude Code plugin plus a Codex config snippet

## Risks
- **Platform risk:** Anthropic, OpenAI or Google can add record and replay to their own agents.
- **Reach:** developers expect local tools to be free and open, so the project is both and has to earn its place by working well.
- **Not a consumer product** unless it pivots to "teach your browser once" for non-developers, where it meets Claude in Chrome, Atlas and Gemini in Chrome head on.
- **Upkeep:** a shared library is only worth using if routines keep working; unmaintained routines are worse than none.
- Plan: build open source and use it first; grow the directory if others ask for routines.
