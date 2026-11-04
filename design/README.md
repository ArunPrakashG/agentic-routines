# Browser Routines design

Canvas (private): https://claude.ai/artifact/R7X8cVw5L1E7mCBjJYTtZP

Source of every board is in `mockups/project/` (publish with root `design/mockups`). `tokens.css` holds the tokens as code.

## Purpose

Record a browser task once and replay it as one tool call, without the model.

## Brand

- Mark: a fanfold. Recorded steps fold into one straight line. `M3 5.5h12L5 11h12L7 16.5h13`, stroke 2.2, round caps, `--accent-ink`.
- Voice: exact, quiet, plain.
- Signature: the fold. Steps that a direct URL replaces fold into the one row that replaces them. The same motion turns a whole run into one call.

## Tokens

- Type: Schibsted Grotesk (UI), IBM Plex Mono (steps, ids, values).
- Accent: ultramarine `#3530E0` light, `#9D99FF` dark. Used for primary action and progress only.
- Warn means "changed, model called" or "paused before an irreversible step". Danger means "broken, handed to the agent".
- Light is the default. Dark follows the browser.
- The Google button follows Google's sign-in branding (Roboto 500, official G mark). It is the only place Roboto appears.

## Motion

| Token | Value |
|---|---|
| instant / fast / base / slow / fold | 90 / 160 / 240 / 420 / 640 ms |
| stagger | 50 ms |
| ease-out | cubic-bezier(.2,.8,.2,1) |
| ease-in-out | cubic-bezier(.65,0,.35,1) |
| ease-settle | cubic-bezier(.34,1.32,.64,1) |

Transform and opacity only. Reduced motion shows the final frame.

## Boards

| File | What it shows |
|---|---|
| Foundations | Tokens, components (StepRow, CheckPips, Button, ParamField, PauseCard, Tag), agent parity |
| Main | 14 s hero loop: record 25 steps, fold to 20, replay as one call |
| Library | Side panel, routines list (dark) |
| Save | Save routine, fold of navigation steps (8 s loop) |
| Replay | Step 9 changed, paused before Start rollout (7 s loop) |
| Agent | Terminal view of one `routine_run` call (12 s loop) |
| States | Empty, and broken handed back to the agent |
| Onboarding | Google sign-in, then `npx browser-routines setup` connecting each agent |
| Site | Marketing page, desktop: hero loop, checks, safety, directory, install |
| SiteMobile | Same page at 375 px |
| Directory | Published routines by owner, with a detail pane showing When to use and `routine_install` |
| Profile | Signed-in owner view: a fix proposal waiting for review, published routines |

## Surfaces

- Extension for Chrome (also Brave, Arc, Opera), Edge and Firefox. Same side panel everywhere. Google sign-in syncs routines across browsers.
- One MCP server for Claude Code, Codex, GitHub Copilot and OpenCode. `npx browser-routines setup` writes each agent's config and links the browsers.
- Marketing site with a routine directory. Every routine has an owner (`owner/name`). Fixes from other people's runs go to the owner as proposals. Publishing is a checkbox on Save, or `routine_publish`.
- Each routine has a When to use text, drafted by the agent on Save. Agents see it as the routine's tool description. See [docs/architecture.md](../docs/architecture.md).

## Agent parity

`routines_list()`, `routine_save(name, run_id)`, `routine_run(name, params)`, `routine_resume(run_id, approve)`, `routines_search(query)`, `routine_install(id)`, `routine_publish(name)`. Every panel action has one. Secrets appear only as `{{secret:name}}`.

Token, cost and time numbers in the mockups are estimates, not measurements.
