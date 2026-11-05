# Local test environment

Runs the whole product on this machine against a small test site: a real Chromium with the extension, the native host, and Claude Code with the MCP server. Everything lives in `.dev/`. Your own browser profile, routines and agent configs are not touched.

```bash
pnpm dev:up
```

| tmux session | What it is |
|---|---|
| `br-claude` | Claude Code, using your login, with only this MCP server and none of your user settings or hooks |
| `br-chrome` | Chromium from Playwright with the unpacked extension, debugging port 9333, or `BR_CDP_PORT` |
| `br-site` | The test site on http://127.0.0.1:8765 |

```bash
tmux attach -t br-claude
```

The fixtures are copied into Claude's working folder. Wait a few seconds after it opens, so the MCP server has connected before your first message.

Try this:

1. Click the extension icon in Chromium to open the side panel. It is under the puzzle piece until you pin it.
2. Ask Claude: `Open http://127.0.0.1:8765/ and release kavyam-2.14.0.aab to internal testing for the Kavyam app. Release name 2.14.0 (214), notes: Faster search. Start the rollout. Then save it as a routine.`
3. Ask for `kavyam-2.15.0.aab` the same way and approve the pause in the panel. Leave it for 90 seconds instead and Claude gets the pause back.
4. To see a changed step, run `localStorage.variant = 'b'` in the page's console. It renames Next to Review release. `delete localStorage.variant` undoes it.

Other options:

- `pnpm dev:down` stops it all. Routines stay, so `rm -rf .dev` is the clean start.
- A new build gets a new browser profile, because Chromium keeps the old background script in a reused one. The panel's onboarding and the page's `localStorage` start over.
- `dev/up.sh --no-build` skips the build. `--headless` and `--no-claude` do what they say.
- `BR_MODEL=haiku dev/up.sh` picks the model. `BR_DEV_DIR` moves the state folder. `BR_CHROME` picks the browser.
- `pnpm e2e` is the scripted check: a fresh headless browser and store, with no model calls. It replaces a running environment. Add `--shots` to save panel screenshots to `.dev/e2e-*/shots`.
