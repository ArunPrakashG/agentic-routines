# 0.3.0

A large step from 0.2.0. The agent can now do most of what a person does in a browser, and routines are easier to trust.

## Driving the page
- Real input through the browser's debugging connection: click, type, press, hover, drag, scroll, right and double click, modifiers and key combinations.
- Find elements by their words, set fields to a state, read a page's words, work inside frames and shadow roots.
- Answer alert, confirm and prompt dialogs, leave pages that ask first, and close the tabs the agent opened.
- Run a script on sites the person allows, and read the console and network.
- `batch` runs up to 20 steps in one call, and `resize_window` tests a page at a phone or any other size.
- A download held at the browser's own "where to save" box can be fetched without it.
- Input at a person's pace, off by default.

## Handing over and staying safe
- Hand a tab to the person for a login, a code, a payment or a bot check; lend a tab with the toolbar button.
- Named sessions with site limits.
- Site secrets the agent never sees; a field that would drop a secret is refused.
- Screen recording, a flight recorder and network capture.

## Routines
- Routines keep track of their runs and say when they need refining.
- They can repeat steps and take one way or another, and can be compiled to Playwright.
- The side panel shows what routines save, and says what is measured and what is estimated.
- A replay stays out of the person's way.

## Setup and reach
- One command installs it, it updates when idle, and every tool is also a command.
- Set up every MCP client, not four.
- A browser on another computer can pair with a one-time code, or connect out to an agent elsewhere.

## Fixes
- An agent always starts in a new tab, and its tabs close when its session ends.
- A signed-out side panel still shows requests meant for the person.
