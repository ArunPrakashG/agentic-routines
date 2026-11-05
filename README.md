# Browser Routines

An agent records a browser task once. You save it as a routine and replay it later without the model.

```
npx browser-routines setup
```

## Layout

| Path | What it is |
|---|---|
| `packages/extension` | The browser extension (WXT, Preact). One codebase for Chrome, Edge and Firefox |
| `packages/cli` | The `browser-routines` npm package: `setup`, `doctor`, `mcp` and the native `host` |
| `packages/core` | Routine format, compiler and locator matching, shared by both |
| `packages/browsers` | Every supported browser in one table: where it keeps native host manifests, which ids it accepts |
| `apps/api` | Accounts API in Go, on Postgres and Redis |
| `releases/` | Release scripts, store listing text and every released version |
| `docs/` | Architecture and privacy |
| `design/` | Approved mockups and tokens |
| `dev/` | Local environment, end-to-end tests and the benchmark |

## Work on it

```
pnpm install
pnpm typecheck
pnpm e2e        # browser end to end, no model calls
pnpm e2e:api    # the API, on throwaway Postgres and Redis (Docker)
```

`dev/README.md` has the local environment. `releases/README.md` has how a release is made.

## Adding a browser

Add an entry to `packages/browsers/src/index.ts`. If the browser is not Chromium or Gecko, add a file next to `packages/extension/lib/platform/chromium.ts` and pick it in `index.ts` there.
