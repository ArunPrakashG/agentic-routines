# Troubleshooting

Start with:

```bash
npx agentic-routines doctor
```

It lists the browsers and agents that are connected, whether your agent has been told to use Agentic Routines for the browser, and what is still missing.

## The agent has no browser tools

Restart the agent after `setup`. It loads its tools when it starts. If `doctor` shows the agent as missing, run `npx agentic-routines setup` again and pick it.

## The extension is not connected

Reload the extension, then restart the browser if `doctor` still says the host is not connected. A store build has its own extension id, and the companion refuses ids it does not know, so an extension from a store that is not in this version's list will not connect: update with `npx agentic-routines update`.

## A debugging bar appears at the top of the window

Clicks, typing and key presses go through the browser's debugging connection, which is what puts the bar there. It goes about a minute after the agent stops. If you press Cancel on it, nothing attaches again for ten minutes and the tools fall back to page events, which some pages ignore.

## A page asks where to save a download

If the browser is set to ask where to save each file, that box belongs to the operating system and nothing can answer it. The download shows as `waiting_at_save_box` in the `download` list, and `download` with its id fetches the file anyway. See [Agent tools](tools.md).

## A tool says a dialog has stopped the page

An alert, confirm or prompt is open. Answer it with `dialog`. Dialogs are reported only on a tab with a debugging connection, which starts at the first click or key press.

## A replay stopped

It stops at a step that cannot be undone, and waits for you or your agent to approve it. It also stops when a step no longer matches the page: the agent is handed the step and fixes it, and the fix is saved for next time. A routine that keeps stopping says so in its tool description, and the agent refines it.

## See what an agent did

```bash
npx agentic-routines debug on     # record every tool call, without typed text or secrets
npx agentic-routines logs -f      # follow it; --errors shows only failures
```

Turn it off with `debug off`.

## Take it all back out

```bash
npx agentic-routines setup --remove
```

This removes the tool server, the guidance, the plugin, the hook and the native host. Remove the extension from the browser's extensions page. Routines you saved stay in `~/.agentic-routines` until you delete that folder.
