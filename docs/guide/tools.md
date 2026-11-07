# Agent tools

The `agentic-routines mcp` command is a Model Context Protocol server that your agent starts over stdio. `setup` writes the config for each agent so you never run it yourself.

## Browser tools

Your agent works in its own tab unless told otherwise. Everything it does with these is recorded.

| Tool | What it does |
|---|---|
| `tabs` | List open tabs: id, title and address. |
| `dialog` | Answer an alert, confirm or prompt that has stopped the page. Recorded as a step; yes to one that sounds final pauses a replay. |
| `javascript` | Run a script in the page. The person says yes per site in the side panel. Never recorded. |
| `read_console_messages` | What the page said to its console, and uncaught errors. |
| `read_network_requests` | What the page sent since the first call on that tab: method, address, status, type. |
| `session_adopt` | Work in a tab the person lent with the toolbar button, by id or address. It cannot be closed, and they can take it back at any moment. Recorded like any other work. |
| `handoff` | Give the tab to the person for a login, a one-time code, a payment or a bot check. A card on the page says who asks, why and on which site, and the toolbar button says WAIT. Only their click on the card or the button gives it back. The call waits with no model calls, and no tool can touch that tab meanwhile. What they type never reaches the agent. Recorded as a step. |
| `close_tab` | Close a tab you opened, or that a page opened because of what you did. Any other tab stays open. Not recorded. |
| `navigate` | Open an address in the agent tab. Pass `force` to leave a page that asks first. If an installed routine handles the page, it adds a hint line (see [Finding a routine first](#finding-a-routine-first)). |
| `read_page` | The page as an outline of roles and names. Interactive elements get a ref such as `ref_12`. Text a person can't see is left out. The result is wrapped as [untrusted data](/docs/safety). Adds the same hint line when the tab has moved to a page a routine handles. |
| `page_llm_content` | The text the site publishes for models, when it has any: a Markdown version of this page, else `/llms.txt` or `/llms-full.txt`. Costs far less than `read_page`. See below. |
| `click` | Click an element by ref, or a point by `x` and `y` from your last screenshot. `button`, `count` (2 is a double click) and `modifiers` (`ctrl+shift`) are optional. |
| `hover` | Leave the pointer over a ref or a point, to open a menu or a tooltip. |
| `drag` | Press on one place and let go on another: a slider, a list to reorder, a map. Each end is a ref or a point, and both have to be on screen. |
| `scroll` | Turn the wheel: `direction` and `amount`, over the middle of the page or over a ref or a point. Only a `ref` brings that element into view. `click` and `type` do that by themselves. |
| `wait` | Wait some seconds. `read_page` with `wait` is usually better: it stops when the page is quiet. |
| `type` | Type into a field by ref. Replaces what is there. `submit` presses Enter after. |
| `select` | Pick an option in a select, by label or value. |
| `form_input` | Bring a field to a value: a checkbox, switch or radio (`true` or `false`), a select, a slider, a date, a time, a colour, or text. What is ticked already stays ticked. |
| `find` | Look for words on the page, with no model. Gives refs, controls first, including things a page made clickable without saying so. |
| `get_page_text` | The words of the page as a person reads them, for an article or a long result. |
| `upload` | Attach files from this machine. Pass the `ref` of the file input, or of the button, label or drop zone in front of it, and an absolute `path` (or `paths` for several). See below. |
| `press` | Press keys in the focused element: Enter, Escape, ArrowDown, `ctrl+a`. Several, separated by spaces, go one after another; `repeat` presses it that many times. |
| `screenshot` | The area around the last element, or the whole tab with `full: true`, or part of the last picture enlarged with `region`. `read_page` costs less. |

Everything these tools return that came from a page is [untrusted data](/docs/safety): wrapped between `BEGIN` and `END UNTRUSTED DATA` lines with a boundary that is new for each call, never instructions.

### Secrets

| Tool | What it does |
|---|---|
| `secrets_list` | The secrets the person keeps: names and the one site each works on |
| `type_secret` | Type one into a field by name. It goes in only on the site it was kept for, and the value never comes back |

See [Secrets you keep for a site](safety.md#secrets-you-keep-for-a-site).

### Settings and status

| Tool | What it does |
|---|---|
| `settings` | Read or change where agent tabs open, how they are grouped, when an untouched one closes, the agent's cursor and hand-over notifications. An agent changes these only when the person asks. The tool has no way to reach security settings or updates |
| `status` | The browsers connected, the session and its limits, its tabs and the settings in force |
| `tabs_cleanup` | Close the tabs this session opened and no longer needs |

The person has the same settings in the panel, under their account menu. A change from either side shows in the panel at once. A tab an agent opened and left closes by itself after 30 minutes, unless that is turned off, it is the tab the person is looking at, a hand-over is waiting on it or a run is paused there. A tab the person opened or lent is never closed.

### Named sessions

An agent's tabs normally belong to its server, and close when it stops. A named session keeps them until it is told otherwise, and can be limited.

| Tool | What it does |
|---|---|
| `session_new` | Start one and work in it. `hosts` limits it to those sites and their subdomains, `read_only` stops it clicking, typing or running a routine |
| `session_list` | The sessions, their limits and their tabs |
| `session_use` | Work in one, by name. No name goes back to the server's own session |
| `session_reset` | Close the tabs it opened, and keep its name and limits |
| `session_delete` | Close them and forget it |
| `session_allowlist` | See its limits or tighten them |

A session stays in the browser profile it started in. If that profile is closed the agent is told, and nothing moves to another one. Start a server in a session with `AGENTIC_ROUTINES_SESSION=<name>`.

### Points on the page

Most things have a ref, and a ref is better: it keeps working when the page moves. A point is for what has none: a canvas, a map, a place on a chart.

`x` and `y` are pixels in the last picture you took of that tab, whatever its size, so read them off the picture. Once the page has moved (a scroll, a new address) a point is refused until you take another picture, because it no longer means anything. `region` zooms into part of the picture, and points then count in the zoomed one.

In a routine, a point becomes what was under it: a click on a button is a click on that button, wherever it sits next time. On a canvas or something large, the step keeps the element and where on it, as a fraction of its size. If something else is drawn over that place when the routine runs, the step stops and does not click.

A hover a person makes while recording is not kept, since a pointer crosses a lot of things on its way. If a recorded task goes through a menu that only opens under the pointer, have the agent do that part with `hover`.

### Uploading files

Most upload widgets are a visible button in front of a hidden `<input type="file">`, or a drop zone with no input at all. Don't click them: that opens the operating system's file picker, which nobody can answer. Call `upload` with the ref `read_page` gave the button, label, drop zone or input, and the absolute path of the file:

```
upload { ref: "ref_14", path: "/home/me/builds/app-2.15.0.aab" }
upload { ref: "ref_14", paths: ["/home/me/a.pdf", "/home/me/b.pdf"] }
```

- The extension finds the input behind the ref, including one reached through a `<label>` or `aria-controls`. With no input, it dispatches a drop on the element. Several files need an input with `multiple` or a drop zone; the tool says when they don't fit.
- Each file is checked before the browser is involved: it has to exist, be a regular file and be readable. The error names the file and the problem.
- Files over 25 MB need a Chromium browser, which hands the file to the page directly. Over 2 GB is refused.
- Credential files are refused: anything in `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, browser profiles or Agentic Routines' own folder, `.env` files, private keys and similar. Only the person can change that, by setting `AGENTIC_ROUTINES_ALLOW_SENSITIVE_UPLOADS=1` for the agent.
- Only files the agent named in an `upload`, or the person typed for a routine, can be read by the extension. A page can't ask for another.
- A routine records the upload as a step with a `file` parameter. Run it with other paths; several files go one per line.

### Text made for models

`page_llm_content` asks the site for text written for models. It looks, in this order, for:

1. a `<link rel="alternate" type="text/markdown">` in the page,
2. the page's own address answered with `Accept: text/markdown`,
3. the same address ending in `.md` (`/docs/start.html` becomes `/docs/start.md`),
4. the site's `/llms.txt`, or `/llms-full.txt` when you pass `full: true`.

The result says which of those it was, whether it is about this page or the whole site, and the address it came from. If there is none it says so and lists what it tried. Nothing is fetched from any other site than the tab's, redirects off the site are refused, each request has a six second limit and `max_chars` caps the size. It is not a picture of the page: it has no refs, so use `read_page` to act.

The text is untrusted, like the page. Comments and hidden elements are removed from the Markdown and orders in it are marked.

## Finding a routine first

An agent should look for a routine before it does a browser task by hand. The server's instructions say so, and so do the tool descriptions of `navigate`, `read_page` and `routines_search`.

**The hint.** When `navigate` lands on, or `read_page` reads, a page that an installed routine handles, the result ends with one line per routine, at most two, best first:

```
Routine rt_play_release handles this page: release to a track. Prefer it.
```

The wording is fixed so that agents and skills can rely on it: `Routine <tool name> handles this page: <what it does>. Prefer it.` The tool name is the one in the tool list. A routine handles a page when one of its `urls` matches (see [Routine format](/docs/routines)); a routine that only shares the site gets no hint. `read_page` says it once per page, not on every read.

**Ranking.** `routines_search` orders by fit first, then by how well the routine has worked:

1. A routine whose `urls` match the page, with the closest path match first (more literal parts matched means closer).
2. A routine for the same site that lists other pages.
3. Among equals, the one that finishes more of its runs and needs the model less.

**Stats.** Each routine keeps a small record of the agent's runs of it on this machine: runs, how many finished, model calls per run, the median time and the last run, over the most recent 20. It is a file in the routine's folder. Nothing is sent anywhere, and it is not part of what you publish. `routines_list`, `routine_describe` and `routines_search` show it. Runs started from the side panel by a person are not counted.

## Routine tools

| Tool | What it does |
|---|---|
| `rt_<name>` | One tool per saved routine, with its parameters. Replays without a model. |
| `routine_run` | The same, by name, for clients that read tools only at startup. `match_viewport: true` resizes the window to the size the routine was recorded at and puts it back afterwards. |
| `routine_resume` | Continue a paused replay. `approve` goes past a pause or stops. `choice` picks the element for a changed step. |
| `routines_list` | Saved routines, what each is for and how the agent's runs of it have gone. Text from routines someone else wrote is shown as [untrusted data](/docs/safety). |
| `routine_describe` | The full notes: when to use it, when not to, the pages it applies to, how its runs have gone, values it asks for, where it pauses. |
| `run_steps` | The recorded steps of a run, numbered, as they happened. Labels come from pages, so the list is [untrusted data](/docs/safety). |
| `routine_propose` | After a task, the agent decides whether it is worth keeping. This turns the run into a draft: every step numbered, with its page, what it did and what happened after it, plus hints at what could go. Changes nothing. |
| `routine_edit` | Refine a draft: remove steps, replace clicks and dialogs with a direct address, make values parameters, add pauses and notes, undo, reset. The extension refuses unsafe edits. |
| `routine_test` | Replay the draft on the live site. Steps that pause are skipped, never performed. |
| `routine_save` | Save the draft as a routine. A routine that replaces a saved one needs a good test first. |

See [Refine a routine](/docs/refine) for the loop.

At most 30 routine tools are exposed at once. The rest are reached with `routines_list` and `routine_run`.

## Directory tools

| Tool | What it does |
|---|---|
| `routines_search` | Find routines for a page or a task. Pass `url` (the page you are on) and/or `query`. Installed routines come first, then the directory (no account needed) and the person's Git sources. A routine that lists the page you are on ranks above one that only matches the site. |
| `routine_install` | Install `owner/name` from the directory. It is checked again on this side. Any hooks it has stay off until the person reads and allows them in the side panel. |
| `routine_install_from_git` | Ask to install from a GitHub repository. The side panel shows every step and any hook code, and Install is the person's click. Hooks are off unless the person switches them on there. |
| `routine_publish` | Ask to send a routine for review. The person approves in the side panel. An agent can't publish by itself. |
| `routine_submissions` | Where each submission stands: waiting, rejected with the guideline, live or turned off. Read only. |

## A replay that stops

A replay returns one of these:

- **Done.** The result text lists the steps run and the time. It adds a note when the window was a very different size from the one the routine was recorded at (see [Viewport](/docs/how-it-works#window-size)).
- **Paused.** The next step can't be undone. Call `routine_resume` with `approve: true` to go on, or `false` to stop.
- **Needs a choice.** A step changed. The result shows the recorded and current crops as text and up to three candidate elements. Call `routine_resume` with the `ref` of the right one.
- **Failed.** The result says which step and why. A step that would leave the routine's site always fails here.

A routine written by someone else also pauses before any step that looks irreversible, even if its author didn't mark one, and only the person can approve that pause, in the side panel. [Untrusted content](/docs/safety) covers why.

## Frames and shadow roots

A page's outline includes every frame a person can see and whatever is inside shadow roots, open or closed. A ref in a frame says which one, like `f12:ref_3`, and works in `click`, `type`, `form_input` and the rest like any other ref. Frames that are hidden or too small to see are left out, so what they say never reaches you. A coordinate on a screenshot lands in whatever is drawn there, frame or not. Routines remember which frame a step was in by its address, and replay it there.

## Dialogs

An alert, confirm or prompt stops the page until someone answers. Every tool that needs the page then says so and quotes the dialog, and `dialog` answers it. The browser only reports dialogs on a tab with a debugging connection, which starts at the first click or key and lasts a minute after the last one. Behind another tab with no connection the browser answers no by itself. In front with no connection a dialog waits for the person. A dialog a person answers while recording is not captured.

## Scripts, the console and the network

These can reach what signs a person in, so they are held back on purpose:

- `javascript` waits for the person in the side panel the first time on a site: no, this once, or always on this site. A script cannot read cookies, and the result has anything shaped like a token, key or cookie hidden.
- A script is never recorded. A routine made from the run will not do it, so use the other tools for anything worth keeping.
- `read_network_requests` gives no headers or bodies, and hides query values and long opaque parts of an address.
- Listening to the console and network starts at the first call on a tab, because some sites treat being listened to as a sign of a bot.

The hiding catches accidents. It would not stop a script written to get around it, which is why the person decides per site.
