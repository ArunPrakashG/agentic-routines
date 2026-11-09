# Try it now

The store listings and the public npm package are not live yet, so this page gets you running from what is already public. It takes about five minutes. Pick one route.

## Route 1: a release, no build

1. Download the extension zip for your browser from the [latest release](https://github.com/ArunPrakashG/agentic-routines/releases/latest): `-chrome.zip` for Chrome, Edge, Brave, Arc and Opera, `-firefox.zip` for Firefox. Unzip the Chrome one.
2. Load it.
   - **Chromium browsers:** open `chrome://extensions` (`edge://extensions` in Edge), turn on Developer mode, choose Load unpacked and pick the unzipped folder.
   - **Firefox:** open `about:debugging#/runtime/this-firefox`, choose Load Temporary Add-on and pick the zip. Firefox drops a temporary add-on when it closes.
3. Connect your agents. This downloads a folder holding Node and the CLI (about 50 MB), registers the native host with your browsers and asks which agents to connect:

   ```bash
   curl -fsSL https://agenticroutines.arunprakashg.com/install | sh
   ```

   On Windows, in PowerShell: `irm https://agenticroutines.arunprakashg.com/install.ps1 | iex`
4. Restart your agent, then run `agentic-routines doctor`. It lists what is connected and what is missing.

A copy made this way updates itself. A hand-loaded extension does not: download the new zip and load it over the old folder.

## Route 2: build it from the repository

You need Node 20 or newer and [pnpm](https://pnpm.io/installation).

```bash
git clone https://github.com/ArunPrakashG/agentic-routines.git
cd agentic-routines
pnpm install
pnpm build
```

That builds the extension into `packages/extension/.output/chrome-mv3` (and `firefox-mv3`) and the command line into `packages/cli/dist`.

1. Load `packages/extension/.output/chrome-mv3` as an unpacked extension, as in route 1. Its id is fixed, which is what lets the native host accept it.
2. Connect your agents with the build you just made:

   ```bash
   node packages/cli/dist/index.js setup
   ```

   `setup --dry-run` shows what it would write first. The agent's config points at this folder, so keep the checkout where it is, or run `setup` again after you move it.
3. Restart your agent and check with `node packages/cli/dist/index.js doctor`.

To pick up a change, run `pnpm build` again and reload the extension on its extensions page.

## Check that it works

Ask your agent to do a small browser task, such as opening a page and reading its heading. The extension's side panel shows the run. When the agent finishes it decides whether the task is worth keeping as a routine. [Getting started](getting-started.md) goes on from here, and [Troubleshooting](troubleshooting.md) covers the usual causes when something is not connected.

## Taking it out

`agentic-routines setup --remove` (or `node packages/cli/dist/index.js setup --remove`) removes the tool server, guidance, plugin, hook and native host. Remove the extension from the browser's extensions page. Your routines stay in `~/.agentic-routines` until you delete that folder.
