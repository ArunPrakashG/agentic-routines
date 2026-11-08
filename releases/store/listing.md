# Store listing

The text each store asks for. Keep it true to what the build does; `releases/store/permissions.json` is checked against the manifest on every release.

## Name

Agentic Routines

## Short description (132 characters or fewer)

A cache for your agent's long browser chores. Repeat tasks replay as one tool call, with no model.

## Single purpose

Caches the browser work of a coding agent, so a task the agent has done before replays as one tool call.

## Description

Coding agents such as Claude Code drive the browser one step at a time: read the page, think, act, repeat. Every step costs tokens and seconds, and the next run pays all of it again.

Agentic Routines is the cache for that work. It sits behind your agent's browser tools and records what the agent does. The agent keeps the tasks that will come back. Next time it calls one tool, the steps replay with no model, and the result is a few lines of text instead of page after page of snapshots.

It is made for agents, not people. You do not record or manage anything: your agent decides which tasks are worth keeping, tidies them (a direct address instead of a click-through, typed values as parameters) and looks for a saved routine before it does a task by hand.

- Works with Claude Code, Codex, GitHub Copilot, OpenCode, Cursor, Windsurf, Gemini CLI, Zed and other MCP clients.
- Made for long chores you repeat on sites with no API: releases, long forms, admin portals. A quick lookup is not worth saving, and your agent leaves it alone.
- Runs the same steps for every value in a list or every row on a page.
- Install routines other people maintain, so your agent skips the recording.
- Checks the page before each step. If a step clearly changed, your agent fixes just that step.
- Pauses before steps that cannot be undone, such as submit, publish, pay or delete.
- Keeps no secrets unless you save one yourself, on your computer, for a single site. Agents only see its name. Recordings stay on your computer, or on the one running your agent if you connect to it.
- Your agent can run on another computer of yours. That computer needs your agent, and this one only the extension. You connect them in Settings, with an address and a one-time code.
- Free and open source.

Needs one free command to connect your browser and your agent: `npx agentic-routines setup`.

## Category

Developer Tools

## Privacy practices (Chrome Web Store form)

- Collects, only if the user signs in with Google or publishes a routine: personally identifiable information (email, name, picture, account id), authentication information (a session token, stored as a hash) and website content (the steps and pages of a routine the user chooses to publish).
- Website content and user activity (pages, addresses, what is typed, clicks) leave the device only if the user connects the extension to another computer of their own, by entering its address and a one-time code. They go to that computer only, with no server of ours in the middle, and we never receive them.
- Does not collect: health, financial, personal communications or location. We do not receive user activity. Recordings stay on the user's device unless the user publishes, or connects to another computer, where they are kept.
- All three certifications apply: not sold, not used outside the single purpose, not used for credit or lending.
- Remote code: none. Everything runs from the package. The store build has no eval and no hook sandbox.
- Privacy policy: https://agenticroutines.arunprakashg.com/privacy

## For reviewers

The extension needs its companion program to do anything useful, and that is what a coding agent talks to.

1. `npx agentic-routines setup` registers the companion for every browser found.
2. Open the Agentic Routines side panel from the toolbar button. It shows "Connected" once the companion is running.
3. To see it work without an agent, press Alt+Shift+R on any page, click and type, press it again, then save the run in the panel and replay it. This is only for trying it out: in use, the agent records and saves.

Permissions: see `permissions.json`. The `debugger` permission is the one that needs the longest justification, so it is spelled out there.

## Assets still to make

- Screenshots, 1280x800: library, recording, replay with a pause, save view.
- Small promo tile, 440x280 (Chrome) and a 1400x560 marquee if wanted.
- A demo video, 30 to 60 seconds.
