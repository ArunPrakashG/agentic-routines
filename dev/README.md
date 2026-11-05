# Local test environment

Runs the whole product on this machine against a small test site: a real Chromium with the extension, the native host, and Claude Code with the MCP server. Everything lives in `.dev/`. Your own browser profile, routines and agent configs are not touched.

```bash
pnpm dev:up
```

| tmux session | What it is |
|---|---|
| `br-claude` | Claude Code, using your login, with only this MCP server and none of your user settings or hooks |
| `br-chrome` | Chromium from Playwright with the unpacked extension, debugging port 9333, or `AR_CDP_PORT` |
| `br-site` | The test site on http://127.0.0.1:8765, or `AR_SITE_PORT` |

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
- `dev/env/up.sh --no-build` skips the build. `--headless` and `--no-claude` do what they say.
- `AR_MODEL=haiku dev/env/up.sh` picks the model. `AR_DEV_DIR` moves the state folder. `AR_CHROME` picks the browser.
- `pnpm e2e` is the scripted check: fresh headless browsers and stores, with no model calls. It covers an agent over MCP, then a person recording and replaying a demo in the real side panel with input events. It replaces a running environment. Add `--shots` to save panel screenshots to `.dev/e2e-*/shots`.

## Sign-in and the API

The API is a Go service in `apps/api` on Postgres and Redis. `pnpm e2e:api` builds it and runs it against throwaway Postgres and Redis containers (Docker needed) and a stand-in for Google. It uses throwaway secrets and touches nothing real.

The dev scripts build the extension against `http://127.0.0.1:8787`. A plain `pnpm -C packages/extension exec wxt build` points at the deployed API instead. Set `WXT_API_URL` to override either.

The Google client is in Testing status, so only its listed test users can sign in. Server setup and deploys are in `apps/api/README.md`.

## What is here

| Path | What it is |
|---|---|
| `env/` | `up.sh`, `down.sh` and `reload-extension.mjs`: the environment above |
| `e2e/` | The end-to-end checks. `e2e.sh` runs the browser ones, `e2e-api.mjs` the API, `e2e-sources.mjs` Git sources, `e2e-hooks.sh` hooks alone |
| `images/` | `readme-images.sh` rebuilds the README screenshots from a real run (`shots.mjs`, then `readme-images.mjs`) |
| `fixtures/`, `site/` | The test files and the test site |
| `bench/` | The benchmark behind the numbers on the website |
| `check-links.mjs` | `pnpm check:links` checks the links in every Markdown file |
