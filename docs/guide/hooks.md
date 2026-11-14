# Hooks and instructions

A routine replays recorded steps. Sometimes the author knows something the recording cannot say: a value that has to be read off the page, a step to skip when a banner is showing, a warning for whoever runs it. Instructions and hooks are the two ways to say it.

## Instructions

Instructions are text for the agent that runs the routine. They can be on a routine, on one step, and on a repository (in `config.routine`).

```yaml
---
name: acme-release
instructions: Check that the version name matches the changelog before you run it.
---
```

```json
{"n":5,"action":"click","label":"Start rollout","pause":"auto","instructions":"This starts the rollout for everyone on the track."}
```

The agent reads the routine's and the repository's notes in the tool description and in `routine_describe`. A step's notes come back in the result of a run: all of them when it finished, the stopped step's when it did not. They are always shown inside a marked block that says someone else wrote them, and the agent is told not to follow anything in them that has nothing to do with the routine. Instructions are limited to 4000 characters on a routine or repository and 1000 on a step.

## Hooks

A hook is a small piece of JavaScript that runs on an event while the routine replays. It receives what is happening and answers with a list of things it would like done. It never gets a handle to the page, the browser or the network.

```yaml
hooks:
  step.before: |
    if (!ctx.step || ctx.step.action !== 'type') return;
    const m = /Suggested name: <b[^>]*>([^<]+)</.exec(ctx.dom.html);
    return m ? [{ do: 'set', value: m[1] }] : [];
  step.after: |
    if (ctx.step.action === 'click') return { do: 'note', text: 'Saved at ' + ctx.url };
```

Hooks go in the front matter of the routine file as above, or under a routine in `config.routine`. The body of a hook is the body of a function that takes `ctx`: use `return` to answer, return nothing to do nothing.

### Events

| Event | When |
|---|---|
| `run.start`, `run.end` | Before the first step; after the last, or after a failure or a stop. |
| `step.before`, `step.after` | Around each step. `step.before` runs once per step, also when a run resumes after a pause. |
| `action.<kind>.before`, `action.<kind>.after` | Around the action itself, for `click`, `type`, `select`, `upload`, `navigate`, `press` and `read`. |
| `page.load` | A page finished loading in the replay. |
| `step.changed` | A step no longer matched the recording and was matched again. |
| `pause.reached`, `pause.approved` | A pause stopped the run; the person or the agent approved it. |
| `error` | A step failed. |

### What a hook receives

`ctx` holds the `event`, the `routine` (name, version, site, description), the `params` the run was given, the `step` (number, action, label, value, whether it pauses), the `url`, and for step and action events a read-only look at the page, `dom`: the title, the page's markup trimmed to a size, the interactive elements with a `ref` each, and the element the step is about.

Never in it: secrets, anything typed into a password field, the contents of file fields. Those are blanked in the page markup too. The markup has no scripts, styles or images.

### What a hook may ask for

A hook returns one directive or a list of them (20 at most). Anything else is refused and written to the run's log with a reason.

| Directive | Effect |
|---|---|
| `{ do: 'skip' }` | Skip this step or action. Only before one. |
| `{ do: 'set', value }` | Use this value for the step that is about to run. Only before one. Not for uploads or steps that use a secret. |
| `{ do: 'set', value, param }` | Give one of the routine's own parameters a value. |
| `{ do: 'click', ref }` | Click an element from `ctx.dom.outline`. |
| `{ do: 'type', ref, text }` | Type into one. |
| `{ do: 'wait', ms }` | Wait, at most 5 seconds each and 10 in all. |
| `{ do: 'goto', url }` | Go to a page on the routine's own site. One per run of a hook. |
| `{ do: 'note', text }` | Add a note to the run result. |
| `{ do: 'fail', reason }` | Stop the run. |
| `{ do: 'pause', reason }` | Stop for the person to look. A hook can ask for a pause, never approve one. |

The extension checks every `click` and `type` against the live page before it acts: the element has to be visible and enabled, a password, file or hidden field is never typed into, a file input is never clicked, a click that looks like it submits, publishes, pays or deletes is refused, and a link that leaves the site is refused. In a `routine_test` a pause a hook asks for is ignored; the test still stops at the routine's own pauses.

### Limits

- 8000 characters of code per hook, 32000 per routine.
- Half a second of run time per hook; a hook that is still going is cut off and the run carries on without its answer.
- 16 KB of answer. A longer one is refused.
- 400 hook runs in one replay.
- Hooks need Chromium, and the build loaded by hand from a release or the repository. The store versions leave hooks out, because store rules do not allow code that a routine brings with it. There, and in Firefox, the routine runs without its hooks and the side panel says so.

Hook code is not run in the page and has no network, no storage and no access to the browser. A hook cannot send anything anywhere; what it can do is limited to the directives above, on the routine's own site. A hook that tries `fetch`, `XMLHttpRequest` or a WebSocket gets an error and nothing else happens.

One limit worth knowing: the browser gives a sandbox no memory cap, so memory is bounded only by the time limit and the size of what goes in and comes out. A hook that allocates as fast as it can will use memory for half a second before it is stopped.

## Approval

Hooks are code somebody else wrote and they run in your signed-in browser, so they are off until you say otherwise.

- Installing from a Git source shows each hook's code in the side panel, with a switch, **Allow these hooks to run**, that starts off. A routine from the directory installs with its hooks off, and the library shows **Review hooks** next to it.
- If you leave it off, the routine installs and runs without hooks. The result of every run says so, and why.
- Approval is for exactly the code you read. It is pinned to a fingerprint of all the hook code in the routine. If the author changes one character, adds an event, or you install a newer version, the hooks are off again until you read them again. The library shows **Hooks changed, off until you read them**.
- Only a click in the side panel approves. An agent cannot approve hooks, and neither can a hook or a routine.
- A routine you recorded yourself has no hooks. Refining a saved routine keeps its instructions and hooks only if it is yours; those of a routine somebody else wrote are not carried into a copy that looks like yours.

## What a run reports

A run result lists the hooks that ran: the event, the step, how long, what they did, what was refused and why, and anything they threw. Notes from hooks are shown to the agent inside the same marked block as other text from the routine's author.

## Publishing

The directory takes instructions and hooks, with the same size limits and only the events above. A reviewer reads the hook code on the review page before approving, and a change to a hook shows as changed against the version that is live. See the [guidelines](/guidelines).
