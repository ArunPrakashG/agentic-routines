# Extension

The browser extension: recorder, replayer, page checks and the side panel. One codebase, built with [WXT](https://wxt.dev) and Preact, for Chrome, Edge and Firefox (Manifest V3).

| Path | What it is |
|---|---|
| `entrypoints/background.ts` | The service worker. Holds recordings and runs, talks to the native host, drives replays |
| `entrypoints/content.ts` | The script in each page: reads the structure, performs steps, draws the glow, cursor and outline that show a tab is being driven |
| `entrypoints/sidepanel/` | The side panel UI: library, save, replay, pauses, publish |
| `entrypoints/admin/` | The review page for directory submissions (reviewers only) |
| `lib/` | Logic shared by the entrypoints (agent bridge, replay, page helpers, directory client). `lib/platform/` holds what differs between Chromium and Gecko |
| `public/` | Icons |
| `wxt.config.ts` | Manifest, permissions and the pinned development extension id |

```bash
pnpm --filter @agentic-routines/extension dev           # Chrome, with hot reload
pnpm --filter @agentic-routines/extension dev:firefox
pnpm --filter @agentic-routines/extension build         # Chromium and Firefox builds in .output/
pnpm --filter @agentic-routines/extension zip           # store packages
pnpm --filter @agentic-routines/extension typecheck
```

A plain build points at the deployed API. Set `WXT_API_URL` to use another one. To try it with an agent and a test site, use `pnpm dev:up` (see [dev/README.md](../../dev/README.md)). Releases are made with the scripts in [releases/](../../releases/README.md).
