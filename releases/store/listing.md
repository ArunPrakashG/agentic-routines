# Store listing

The text each store asks for. Keep it true to what the build does; `releases/store/permissions.json` is checked against the manifest on every release.

## Name

Agentic Routines

## Short description (132 characters or fewer)

Record a browser task once from your agent, replay it without the model.

## Single purpose

Lets a coding agent record a browser task and replay it later as a routine.

## Description

Your coding agent repeats the same browser chores step by step: releases, console admin work, portal downloads. Every run costs the same tokens and time as the first.

Agentic Routines records what your agent does in the browser. Save it as a routine, with the values you fill in each time. Next time the routine replays with no model, as a single tool call.

- Works with Claude Code, Codex, GitHub Copilot and OpenCode.
- Checks the page before each step. If a step clearly changed, your agent fixes just that step.
- Pauses before steps that cannot be undone.
- Never stores secrets. Recordings stay on your computer.
- Record a demo by doing the task yourself.
- Free and open source. No account fees, no paid tier.

Needs one free command to connect your browser and agent: `npx agentic-routines setup`.

## Category

Developer Tools

## Privacy practices (Chrome Web Store form)

- Collects: authentication information and personally identifiable information, only if the user chooses to sign in with Google (email, name, picture, account id).
- Does not collect: health, financial, location, web history, user activity, or website content. Recordings stay on the user's device.
- Not sold, not used for anything outside running the product, not used for credit or lending.
- Remote code: none. Everything runs from the package.
- Privacy policy: docs/privacy.md, published on the site (#10) before the first submission.

## For reviewers

The extension needs its companion program to do anything useful, and that is what a coding agent talks to.

1. `npx agentic-routines setup` registers the companion for every browser found.
2. Open the Agentic Routines side panel from the toolbar button. It shows "Connected" once the companion is running.
3. To see a recording without an agent, press Alt+Shift+R on any page, click and type, press it again, then save the run in the panel and replay it.

Permissions: see `permissions.json`. The `debugger` permission is the one that needs the longest justification, so it is spelled out there.

## Assets still to make

- Screenshots, 1280x800: library, recording, replay with a pause, save view.
- Small promo tile, 440x280 (Chrome) and a 1400x560 marquee if wanted.
- A demo video, 30 to 60 seconds.
