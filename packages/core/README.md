# @agentic-routines/core

The routine format and the logic around it, shared by the extension and the CLI. Private to the workspace: it is bundled into both, not published on its own.

| Area | What it holds |
|---|---|
| `routine-md.ts`, `types.ts` | The `ROUTINE.md` file: front matter (parameters, pauses, secrets) and the steps behind it |
| `compile.ts`, `draft.ts` | Turning a recorded run into a draft routine, and the edits an agent can apply to a draft |
| `match.ts` | Locating an element on a page: structure first, then the element itself, then a screenshot crop |
| `sources.ts`, `config-routine.ts` | Where routines come from (directory, Git repository, folder) and the `config.routine` file of a repository |
| `hooks.ts` | Hooks a routine can declare |
| `envelope.ts` | The message shape the extension and the native host exchange |

The formats are described in [docs/guide/routines.md](../../docs/guide/routines.md) and [docs/guide/repositories.md](../../docs/guide/repositories.md).

```bash
pnpm --filter @agentic-routines/core typecheck
```

There is no build step. Other packages import the TypeScript source directly.
