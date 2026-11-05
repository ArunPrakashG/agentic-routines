# Design: how routines are made, shared and extended

Draft, written before the build. Three parts, one pull request each. Where the build changed a decision, this file says so.

## What exists today

- Every browser tool call an agent makes is recorded by the extension (`lib/agent/runs.ts`) as a `RecordedEvent`: action, page URL, locator, typed value, crop hash, and the URL it navigated to.
- `routine_save` (`packages/cli/src/mcp/server.ts`) calls `compileRun` (`packages/core/src/compile.ts`). It silently drops every navigation step before the first real action and starts the routine at that page ("replaced by a direct URL"). Everything else is kept as recorded, minus steps the agent names in `leave_out`.
- Saved routines are `ROUTINE.md` plus `steps.json`, written by the host (`packages/cli/src/store/routines.ts`). The extension replays them (`lib/replay/replay.ts`) with a page check, an element check and a crop check before each step, and stops at pauses.
- Git sources are one file per routine under `routines/` (`core/src/sources.ts`), installed after the person clicks Install in the side panel (`lib/remote/git.ts`).
- The directory API (`apps/api/routines.go`) re-validates every published routine field by field.

## Part A: the agent refines, nothing is rewritten silently

The loop an agent follows: do the task, judge whether it is worth keeping, `routine_propose`, `routine_edit` until the steps are right, `routine_test`, `routine_save`.

**Draft.** `routine_propose` turns a run into a *draft*: one step per recorded event, numbered, nothing dropped. The draft lives in the extension (`storage.local`), not in the model's context, and every edit is checked there. The same code can be given a saved routine (`from_routine`) to refine it.

**What the agent sees.** For each step: number, page, action, target, value and the effect (“navigated to /apps”, “page changed”, “nothing visible”). Then hints. A hint is a suggestion with the exact edit that would apply it, never an edit that was made:

- *Navigation only.* A run of steps whose only effect was moving between pages, followed by a step that happens at a known URL. Suggest `navigate <that URL>` over the range. This is the old automatic prefix drop, now at any position and visible.
- *Interstitial or modal.* A click inside a dialog that only answers it (“Go to overview”, “Not now”, “Close”). The locator now records the dialog it sat in (`modal`), so this does not rely on the label alone.
- *Retries.* A value typed into the same field twice, the same click twice in a row.
- *Side effects.* Steps that submit, publish, pay or delete. These keep their pause.
- *Ids.* A URL that carries an id is classified before it is suggested.

**Edits** (`routine_edit`, a list applied all or nothing, with undo and reset): `remove`, `navigate` (replace a range with a URL, or open a page before a step), `param` (make a typed value a parameter, or declare one for use in a URL as `{{name}}`), `fixed`, `pause`, `note`, `first_in_list`, `describe`, `undo`, `reset`.

**Rules the extension enforces, not the model:**

1. A step that submits, publishes, pays or deletes cannot be removed, replaced or have its pause switched off. Removing steps around it is fine.
2. `navigate` stays on the routine's site: the host is the routine's site or a subdomain of it, the registrable domain is one of the recorded pages', and the scheme is https (http only where the recorded page of that host was http, which is how local development sites work).
3. A URL cannot carry a per-session value. Long random strings, UUIDs and keys like `sid`, `token`, `state` are refused unless written as `{{param}}`. A numeric item id is allowed but said out loud, as the routine is then pinned to that item; the agent can make it a parameter.
4. The result is checked against the same rules the API applies at publish, so a routine that would be rejected there fails here, with the reason.

**Test and keep.** `routine_test` replays the draft on the live site and stops at the first pause without approving it, so nothing irreversible runs. It returns what happened per step. A draft that refines a saved routine can only be saved after a test of its latest edit passed. A new routine can be saved without one but the result says it was not tested.

Human recordings saved from the side panel keep the compile step, because the person sees the result and approves it there.

## Part B: free marketplace, defined routine repositories

The directory stays: free to publish and install, reviewed for safety. Every trace of paid plans, pricing, team plans or a paid library goes from the site, docs, store copy, README and the design boards. The text says plainly that the project is open source and free.

**`config.routine`** in the repository root, YAML, declares the repo and every routine in it:

```yaml
version: 1
name: acme-console-routines
description: Routines for the Acme Console.
instructions: |
  Read the notes of a routine before running it.
routines:
  - name: acme-release
    description: Upload a bundle and start the rollout. Use when ...
    path: routines/acme-release.md
    sites: [console.acme.test]
    instructions: Check the version name matches the changelog.
    params: ...
    hooks: ...
```

- Parsed in `packages/core/src/config-routine.ts` with a hand-written schema that reports file, line and field (`config.routine:14 routines[1].path: ...`). It uses the `yaml` document API for line numbers.
- Fallback: a repo without the file lists `routines/*.md` as today, and a repo with a single `ROUTINE.md` in its root is one routine.
- The listing in `core/src/sources.ts` (shared by the GitHub source and the folder source) reads the file first. Fields in `config.routine` describe and gate what is listed; the routine file stays the source of the steps. At install, the entry's `description` replaces the file's, `instructions` and the repository's name and instructions are stored with the routine (`meta.instructions`, `meta.repo`), so what the person read in the panel is what the agent reads. `sites` gates: a routine whose site is not listed is left out. A `config.routine` that is there but wrong is an error with file, line and field, never a reason to guess another layout.
- `agentic-routines sources check <folder>` runs the same reader for authors.
- Repo and routine `instructions` reach the agent in `routines_search`, in the tool description, in `routine_describe` and after a replay, always inside an envelope with a boundary the text could not have known, since they were written by someone else. `core/src/envelope.ts` is a small stand-alone version; the fuller cleaning of text from websites (another branch) can replace its body.

## Part C: hooks and instructions

**Instructions** are text for the agent on a routine and on a step. They come back in the tool description and in replay results when a step changed, inside the envelope.

**Hooks** are code on events: `run.start`, `run.end`, `step.before`, `step.after`, `action.<kind>.before|after` for click, type, select, upload, navigate, press, read; `page.load`, `step.changed`, `pause.reached`, `pause.approved`, `error`.

**Containment, by construction.** A hook is a JavaScript function that receives a serialised context and returns a list of directives. It never receives a handle to anything.

- It runs in an extension *sandbox page* (MV3 `sandbox` in the manifest, unique origin, no extension APIs, no storage). Chromium only. Firefox says hooks are not supported there and runs without them. A service worker cannot hold a frame, so the background creates an offscreen document (`offscreen` permission, reason `IFRAME_SCRIPTING`) that frames the sandbox page.
- The sandbox page's CSP is `sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'`, so `fetch`, WebSocket, images and scripts have nowhere to go. Each run gets a fresh Blob Worker that has `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` and the like removed before the hook code is read. The only channel out is `postMessage` to the extension.
- Limits: 500 ms (the sandbox page terminates the Worker; the offscreen document restarts the frame if the page itself stops answering), 120 KB of context, 16 KB of output, 20 directives. **Not enforced: a memory cap.** The platform has none for a Worker, so memory is bounded only by the time limit and the context and output caps. This is stated in the docs.
- The context carries event, step, routine data, parameters (never secrets or typed passwords), the URL, and a read-only snapshot: trimmed outerHTML of the page and the target, accessible name, rect, and the interactive outline. Password fields are blanked in the snapshot.
- The return value is validated against a fixed list of directives: `skip`, `set`, `click`, `type`, `wait`, `goto`, `note`, `fail`, `pause`. A `click` or `type` names a ref the extension resolves in the live page; `goto` must be same site; `wait` is capped; `pause` stops for the person and a hook cannot approve one. Anything else, including a function or code, is dropped and logged.
- Every hook run is logged in the run result: event, time, directives performed, directives refused.

**Approval.** Hook code is shown in the side panel on install from Git, with a switch that starts off; a routine installed from the directory starts with hooks off and the library has a Review hooks button. The approval is stored in `storage.local` with a sha256 of all the hook code in the routine (`hookApprovals`, by `owner/name`); a changed hash asks again, and the library says so. Only a click in the panel approves: the agent's tools have no way to. Refining a saved routine keeps instructions and hooks only when its owner is `local`. Without approval the routine runs with hooks off and the run and install results say so. The API validates hooks at publish: allowed events only, size caps, no oversize code; the admin review page shows the code.

## Order and what each part proves

A: e2e records a run with a modal and a click-through, proposes, applies the hint, refuses an unsafe edit, tests, saves, replays. B: the e2e installs a fixture repo with a `config.routine`, and `config.routine` errors are checked with file and line. C: the e2e runs a routine with a filling hook, a noting hook and a misbehaving hook, and walks the approval and re-prompt on change.

## Finding and preferring routines

A routine records the pages it applies to (`urls`, globs worked out from the recorded pages, or written by the author or in `config.routine`). `routines_search` takes the page the agent is on, ranks a closer path match above a bare site match and, among equals, the routine that works without the model. `navigate` and `read_page` add a fixed one-line hint when an installed routine handles the page; the CLI does the matching, so the extension only has to report the tab's address. Per-routine run stats stay in the routine's folder. `surface` (`browser`, reserved `desktop`) is validated and nothing else: desktop control is not built.
