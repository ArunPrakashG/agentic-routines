# Development

Browser Routines is a pnpm monorepo. The code is on [GitHub](https://github.com/ArunPrakashG/browser-routines).

## Layout

| Path | What it is |
|---|---|
| `packages/extension` | The browser extension (WXT, Preact). One codebase for Chrome, Edge and Firefox. |
| `packages/cli` | The `browser-routines` npm package: `setup`, `doctor`, `mcp` and the native `host`. |
| `packages/core` | Routine format, compiler and locator matching, shared by both. |
| `packages/browsers` | Every supported browser in one table: where it keeps native host manifests and which extension ids it accepts. |
| `apps/api` | Accounts and the directory. A Go service on Postgres and Redis. |
| `apps/site` | This website, built with Astro. |
| `releases/` | Release scripts, store listing text and every released version. |
| `docs/` | These pages, the architecture notes and the privacy page. |
| `dev/` | The local environment, end-to-end tests and the benchmark. |

## Parts

```text
 Claude Code / Codex / Copilot / OpenCode
        │ stdio (MCP)
        ▼
 browser-routines mcp  ◄── unix socket / named pipe ──►  browser-routines host
 tools, routine index                                    native messaging, one per browser
        │ reads and writes                                      │
        ▼                                                       ▼
 ~/.browser-routines/routines/                          Extension (Chrome, Edge, Firefox)
                                                        recorder, replayer, checks, side panel
```

The MCP server and the native host are the same package in two modes. They talk over a socket in `~/.browser-routines`. The extension holds the Google session, so the tool server has no sign-in of its own. When the extension is signed out, local routines still work.

## Run it

```bash
pnpm install
pnpm typecheck
pnpm e2e        # browser end to end, no model calls
pnpm e2e:api    # the API, on throwaway Postgres and Redis (Docker)
```

`pnpm dev:up` starts a real Chromium with the extension, the native host and Claude Code against a small test site, all under `.dev/`. Your own browser profile, routines and agent configs are not touched. `dev/README.md` has the walkthrough.

## Adding a browser

Add an entry to `packages/browsers/src/index.ts`. If the browser is not Chromium or Gecko, add a file next to `packages/extension/lib/platform/chromium.ts` and pick it in `index.ts` there.

## Releasing

`releases/README.md` has how a release is made, and `releases/store/listing.md` has the text each store asks for. The API and the site each deploy with a script: `apps/api/deploy/deploy.sh` and `apps/site/deploy/deploy.sh`.

## More

- [Architecture notes](https://github.com/ArunPrakashG/browser-routines/blob/main/docs/architecture.md): the design behind the routine format, replay checks, accounts and the directory.
- [Directory guidelines](/guidelines) and [privacy](/privacy).
