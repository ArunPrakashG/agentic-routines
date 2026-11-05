# Agentic Routines

Your agent does a browser task once. Agentic Routines records it, and next time replays it without asking the model again.

Repeat chores run up to 3.5 times faster and cost up to 83% less, and your agent's context stays free of page snapshots. It works with Claude Code, Codex, GitHub Copilot and OpenCode, in Chrome, Edge and Firefox.

Agentic Routines is free and open source (MIT). There is no paid tier, and the directory of shared routines is free to publish to and install from.

Website and docs: <https://agenticroutines.arunprakashg.com>

## Install

1. Add the extension from the store for your browser: Chrome, Edge or Firefox. Brave, Arc and Opera use the Chrome version.
2. Connect your agents:

```bash
npx agentic-routines setup
```

Then restart your agent and check everything is connected with `npx agentic-routines doctor`.

Or paste this into your agent and let it do the work:

```text
Set up Agentic Routines on this machine.
1. Run "npx agentic-routines setup". If I use pnpm, bun or yarn, run it with "pnpm dlx", "bunx" or "yarn dlx" instead.
2. Run "npx agentic-routines doctor" and tell me which agents and browsers are connected and what is still missing.
3. If my browser has no extension yet, tell me which store page to open. Do not install anything else.
4. Tell me to restart this agent so it loads the browser tools.
```

## How it works

- **Record.** Every run your agent makes in the browser is recorded, on your computer.
- **Save.** Save a run as a routine. Typed values become parameters you fill in each time, navigation a direct address can replace is dropped, and steps that can't be undone get a pause.
- **Replay.** The routine is one tool call. Before each step it checks the page structure, then the element, then a screenshot crop. Your agent is called only for a step that clearly changed.
- **Stay safe.** It pauses before anything irreversible and never saves a password.

You can also record a demo by doing the task yourself, and share routines through the reviewed directory or a GitHub repository.

Read more in the [docs](https://agenticroutines.arunprakashg.com/docs), or the [architecture notes](docs/architecture.md).

## Repository

| Path | What it is |
|---|---|
| `packages/extension` | The browser extension (WXT, Preact). One codebase for Chrome, Edge and Firefox |
| `packages/cli` | The `agentic-routines` npm package: `setup`, `doctor`, `mcp` and the native `host` |
| `packages/core` | Routine format, compiler and locator matching, shared by both |
| `packages/browsers` | Every supported browser in one table: where it keeps native host manifests, which ids it accepts |
| `apps/api` | Accounts and the directory. A Go service on Postgres and Redis |
| `apps/site` | The website and docs, built with Astro |
| `docs/` | The documentation pages (`guide/`), architecture, directory guidelines and privacy |
| `releases/` | Release scripts, store listing text and every released version |
| `design/` | Approved mockups and tokens |
| `dev/` | Local environment, end-to-end tests and the benchmark |

## Work on it

```bash
pnpm install
pnpm typecheck
pnpm e2e        # browser end to end, no model calls
pnpm e2e:api    # the API, on throwaway Postgres and Redis (Docker)
pnpm dev:up     # a real Chromium with the extension, the native host and Claude Code
```

`dev/README.md` has the local environment, `releases/README.md` has how a release is made, and `apps/api/README.md` and `apps/site/README.md` cover the two deployed apps.

### Adding a browser

Add an entry to `packages/browsers/src/index.ts`. If the browser is not Chromium or Gecko, add a file next to `packages/extension/lib/platform/chromium.ts` and pick it in `index.ts` there.

### Adding to the docs

The docs are Markdown in `docs/guide/`. Add a page there and list it in `apps/site/src/lib/docs.ts`; the site picks it up on the next build.

## Privacy

Routines and recordings stay on your computer. Nothing is sent unless you sign in and choose to publish. See [docs/privacy.md](docs/privacy.md).

## License

MIT. See [LICENSE](LICENSE).
