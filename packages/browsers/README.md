# @agentic-routines/browsers

Every browser Agentic Routines can connect to, in one table (`src/index.ts`). For each browser it records its engine (Chromium or Gecko), where it keeps its profile and its native messaging manifests on macOS, Linux and Windows, and where its extension is installed from.

`agentic-routines setup` reads the table to register the native host with every browser it finds, and the release scripts read it to know what to build. Adding a browser is one entry. If it is neither Chromium nor Gecko, the extension also needs a platform file, see [docs/guide/development.md](../../docs/guide/development.md#adding-a-browser).

```bash
pnpm --filter @agentic-routines/browsers typecheck
```

Private to the workspace, with no build step.
