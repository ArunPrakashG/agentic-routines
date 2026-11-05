# Browser Routines architecture

Status: draft for review, 2026-11-05. Builds on [browser-routines.md](../browser-routines.md) and the mockups in [design/](../design/README.md).

## The idea in one line

A routine is a skill for the browser. It is a folder with a `ROUTINE.md` that tells an agent when to use it, plus compiled steps that the extension replays without a model.

## Parts

```
 Claude Code / Codex / Copilot / OpenCode
        │ stdio (MCP)
        ▼
 ┌─────────────────────────┐   unix socket / named pipe   ┌──────────────────────┐
 │ browser-routines mcp    │◄────────────────────────────►│ browser-routines host │
 │ tools, routine index    │        (~/.browser-routines)  │ native messaging      │
 └───────────┬─────────────┘                               └──────────┬───────────┘
             │ reads/writes                                           │ one per browser
             ▼                                                        ▼
   ~/.browser-routines/routines/                        Extension (Chrome, Edge, Firefox)
   <owner>/<name>/ROUTINE.md, steps.json                 recorder · replayer · checks · side panel
             ▲                                                        │
             └──────────── sync (signed-in user) ─────── Directory API ◄── site + directory pages
```

| Part | Job | Stack |
|---|---|---|
| Extension | Drives the browser for agents, records every run, replays routines, runs the page checks, side panel UI, Google sign-in | TypeScript, WXT (one codebase, builds MV3 for Chrome/Edge and Firefox), Preact |
| `browser-routines` npm package | `mcp` mode for agents, `host` mode for native messaging, `setup` to write agent configs and register the host with each browser | TypeScript, Node 20, `@modelcontextprotocol/sdk` |
| `core` package | Routine format, compiler (drop navigation, find params, mark pauses), locator matching, shared by extension and package | TypeScript |
| Directory API | Accounts, sync, publish, versions, search, install counts, reports | Go service on Postgres and Redis, behind Caddy and Cloudflare |
| Site and directory pages | Marketing page, routine directory, user profiles, privacy page | Astro on Cloudflare Pages, reading the same API |

Everything above runs on free tiers to start.

## Routine format: a skill for the browser

The routine is a folder, the same shape as an agent skill.

```
play-release/
  ROUTINE.md     what it is and when to use it (read by agents and people)
  steps.json     compiled steps (read only by the replayer)
  crops/         screenshot crops per step (local only, never published)
```

`ROUTINE.md`:

```markdown
---
name: play-release
owner: arunprakashg
version: 4
site: play.google.com
description: >
  Upload an Android App Bundle to a Google Play Console testing track and
  start the rollout. Use when the user asks to ship, release or upload an
  Android build to internal, closed or open testing on Google Play.
params:
  version_name: { type: string, description: "Release name, e.g. 2.15.0 (215)" }
  release_notes: { type: string, description: "What's new text, en-US" }
  bundle: { type: file, accept: ".aab", description: "Path to the .aab on this machine" }
secrets: []
pauses: [20]
requires:
  signed_in: play.google.com
returns: Release name, version code and rollout status.
---

## Before running
The app must already exist in Play Console and the bundle must be signed.

## Do not use for
Production releases. This routine only covers testing tracks.
```

Rules, borrowed from how skills work:

- **`description` is the trigger.** It says what the routine does and when to use it, in the user's words ("ship", "release", "upload a build"). It is required, at most 1024 characters, and must contain a "Use when" clause. The directory rejects a publish without one.
- **"Do not use for"** keeps similar routines from being picked by mistake (testing track vs production).
- **Progressive disclosure.** Agents see only `name`, `description` and `params` up front. The body of `ROUTINE.md` comes back from `routine_describe` when the agent wants it. `steps.json` never reaches the agent at all.
- **Who writes the description.** On `routine_save` from an agent run, the agent writes it, because it knows what the user asked for. On a human demo, the side panel drafts one from the steps through the connected agent and the user edits it. The Save screen gets a "When to use" field (mockup change, below).

## How an agent finds and runs a routine

1. **Enabled routines become MCP tools.** Each one is registered as a tool named `rt_<name>`, with the routine's `description` as the tool description and `params` as its JSON schema. The agent picks it the way it picks any tool or skill. When routines change, the server sends `tools/list_changed`. Clients that only read tools at startup pick up new routines on restart, and `routine_run(name, params)` works without a restart.
2. **Cap on tools.** At most 30 routine tools are exposed (VS Code warns past 128 tools in total). The rest are reachable through `routines_list` and `routine_run`.
3. **Site hints.** When the agent drives the browser by hand with our basic tools and navigates to a site that has routines, the result of `navigate` includes one line per matching routine: name and description. This catches the case where the agent didn't think to look.
4. **Directory search.** `routines_search(query, site?)` does a semantic search over published descriptions. `routine_install(owner/name)` adds one, and it then shows up as a tool.
5. **Optional skill export.** `setup --skills` can also write a small `SKILL.md` per routine into clients that support agent skills, pointing at `routine_run`. This is off by default until each client's support is checked.

### Tools

| Tool | Panel equivalent |
|---|---|
| `navigate`, `click`, `type`, `read_page`, `screenshot`, `tabs` | none (agent driving, always recorded) |
| `rt_<name>(params)` / `routine_run(name, params)` | Run |
| `routine_resume(run_id, approve \| choice)` | Start rollout / Stop at a pause, or pick the changed element |
| `routine_save(run_id, name, description, do_not_use_for?)` | Save routine |
| `routine_describe(name)` | Routine detail |
| `routines_list()` | Routines list |
| `routines_search(query, site?)` | Directory search |
| `routine_install(owner/name)` | Add to my routines |
| `routine_publish(name)` | Share on the directory |

Results are short text: steps run, model calls, pauses, time. No page snapshots come back from a replay.

**Directory tools.** `routines_search` and `routine_install` read the public directory and need no account; install writes the routine under its owner and checks it again on this side (description, every step on the routine's own site) whatever the directory said. `routine_publish` only asks: the side panel shows what becomes public, including typed values and addresses with details, and the person approves there. An agent cannot publish on its own. The session lives in the extension, so publishing always goes through it.

## Replay and the page checks

For each step, the replayer checks in order and stops at the first one that settles it:

1. **Page structure.** URL pattern plus a hash of landmarks (headings, form labels, main regions). It is cheap and catches "wrong page" early.
2. **Element.** A locator bundle: role and accessible name, visible text, stable attributes, CSS path, position relative to landmarks. The element must resolve to exactly one match.
3. **Screenshot crop.** A perceptual hash of the area around the element, compared to the recorded crop. Password fields are always masked.

If all three agree, it acts. If structure and element agree but the crop drifts, it acts and refreshes the crop. If the element is ambiguous or missing, the step has changed:

- The run pauses with status `needs_choice` and returns the recorded crop, the current crop and up to three candidate elements as text.
- The agent (already a model, already paid for) picks one with `routine_resume(run_id, choice)`. Clients that support MCP sampling can do this without a round trip. This is the "model called once" in the mockups, and it needs no API key of our own.
- The fixed locator is saved as the next version.
- If the agent can't pick, the replay stops and the agent finishes the task by hand with the basic tools. That run saves as the next version.

Irreversible steps (publish, pay, delete, submit, confirm) always pause, and the run returns `paused` with the step label. A step is irreversible if its label matches the deny-list, if its form posts to a payment or deletion endpoint, or if the author marked it. Publishers can add pauses but can never remove one the detector added.

Secrets: a typed value in a password field is never written to disk. It becomes `{{secret:name}}`. At run time the value comes from the user typing it at a pause, or from an environment variable on the agent's machine, which is passed to the content script and never logged. Most runs need neither, because the browser session is already signed in.

## Accounts: everything belongs to a signed-in user

- **Sign-in.** Google only. The extension uses `identity.launchWebAuthFlow` (Chrome, Edge and Firefox all have it) with PKCE. The API verifies the Google ID token and issues its own session: a 15-minute access token and a refresh token, both bound to the install. The site uses the same Google flow with an HttpOnly cookie.
- **User record.** Google `sub` as the identity key, email (never shown publicly), display name, and a handle picked at first publish (`arunprakashg`). The handle is the namespace.
- **Ownership.** Every routine has an `owner`. Local routines live under the signed-in user's namespace. Published routines are addressed as `owner/name@version` (`arunprakashg/play-release@4`). Only the owner can publish new versions, unpublish or transfer.
- **Scoping.** Every API call is authorised by the session's user id, with no exceptions:
  - Sync returns only that user's routines and installs.
  - Run outcomes are recorded against that user.
  - Reports and fix proposals carry the reporter's id.
- **The MCP server signs in through the extension.** It has no login of its own. It asks the host, and the host asks the extension, which holds the session. If the extension is signed out, routine tools still work on local routines, and directory tools return "sign in from the browser panel".
- **Deleting an account** removes the user's private routines, installs and run records, and unpublishes their directory routines. Anyone who installed one keeps their local copy.

## Routine directory

The public directory of community routines, at `/routines` on the site. The mockups call it Directory (it was Marketplace before), since nothing is sold.

| Page | URL | Shows |
|---|---|---|
| Directory | `/routines?q=&site=` | Search plus a list. Each row shows name, owner, site, description, number of people using it and step count. |
| Routine | `/routines/arunprakashg/play-release` | Description, when not to use, params, pauses, steps as labels, versions, owner, "Add to my routines", `routine_install(...)` |
| Profile | `/u/arunprakashg` | Display name and published routines |
| Site | `/sites/play.google.com` | All routines for one site |

Publishing:

1. The owner ticks "Share on the directory" on Save, or calls `routine_publish`.
2. The package strips what can't leave the machine. Crops stay local, because they can show account names. Recorded values that aren't params are removed, and no secret values exist to strip.
3. The API lints the routine: description present with a "Use when" clause, `site` set, every step's URL inside `site`, pauses present for detected irreversible steps.
4. It's published as a new immutable version. The description is indexed for search (Postgres full-text search to start).

Installing pins a version. When the owner publishes a new version, installed copies update on the next sync unless the user pinned the version.

Shared fixes ("one fix reaches everyone"):

1. When someone else's replay of a directory routine fixes a changed step, the fix goes to the owner as a proposal.
2. The owner can accept it, which publishes a new version.
3. If the owner doesn't respond in 7 days and the fix has worked for at least 3 different users, it is published automatically as a patch version credited to the fixer.

Trust and abuse:

- **Steps can't run code.** They are declarative: navigate, click, type, select, upload, wait, read. Routines can't contain scripts.
- **Navigation stays on the routine's site.** A step that leaves the declared `site` stops the replay.
- **First run is supervised.** The first run of an installed community routine steps through with the panel open, and each step needs a confirm. After that, it replays normally.
- **Visible accountability.** Every listing shows its owner's handle and a Report link. Reported routines are hidden after review.

## Sync

The local folder `~/.browser-routines/routines/<owner>/<name>/` is the source of truth on each machine. The npm package reads and writes it, and the extension keeps a cache in IndexedDB. When signed in, the folder syncs to the API per user:

- A routine's version number only goes up.
- When two machines edit the same version, the later save becomes the next version. No merge.

A project can also keep routines in `.routines/` in its repo, shared through git, the way project skills are.

## Repo layout

```
packages/core        routine format, compiler, locator matching
packages/extension   WXT extension (chrome, edge, firefox targets)
packages/cli         npm package: mcp, host, setup
apps/api             Go service: auth, sync, directory
apps/site            Astro: marketing page, directory, profiles, privacy
docs/                this file
design/              approved mockups and tokens
```

## Decisions I made

- MCP tools are the main way routines reach agents. Exporting them as skill files is opt-in.
- Changed steps are resolved by the agent that is already running, not by a model we host. This keeps it free to run.
- Crops never leave the machine. Directory routines rely on locators, and each user's first run captures their own crops.
- Google is the only sign-in. Handles are picked at first publish, not at sign-up.

## Open questions for you

1. Should routines work fully without signing in, local only, or is sign-in required to use the extension at all? The mockup requires it. This design allows local use and needs sign-in only for sync and the directory.
2. Auto-publishing a shared fix after 7 days without a reply from the owner: keep it, or always wait for the owner?
3. Teams: private namespaces shared by a group (`team/name`) fit this model. Should they be in v1 or later?

