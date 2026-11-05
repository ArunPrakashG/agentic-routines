# Agent tools

The `agentic-routines mcp` command is a Model Context Protocol server that your agent starts over stdio. `setup` writes the config for each agent so you never run it yourself.

## Browser tools

Your agent works in its own tab unless told otherwise. Everything it does with these is recorded.

| Tool | What it does |
|---|---|
| `tabs` | List open tabs: id, title and address. |
| `navigate` | Open an address in the agent tab. Lists saved routines for the site, if any. |
| `read_page` | The page as an outline of roles and names. Interactive elements get a ref such as `ref_12`. Text a person can't see is left out. The result is wrapped as [untrusted data](/docs/safety). |
| `page_llm_content` | The text the site publishes for models, when it has any: a Markdown version of this page, else `/llms.txt` or `/llms-full.txt`. Costs far less than `read_page`. See below. |
| `click` | Click an element by ref. |
| `type` | Type into a field by ref. Replaces what is there. `submit` presses Enter after. |
| `select` | Pick an option in a select, by label or value. |
| `upload` | Attach files from this machine. Pass the `ref` of the file input, or of the button, label or drop zone in front of it, and an absolute `path` (or `paths` for several). See below. |
| `press` | Press a key in the focused element: Enter, Escape, Tab, ArrowDown. |
| `screenshot` | The area around the last element, or the whole tab with `full: true`. `read_page` costs less. |

Everything these tools return that came from a page is [untrusted data](/docs/safety): wrapped between `BEGIN` and `END UNTRUSTED DATA` lines with a boundary that is new for each call, never instructions.

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

## Routine tools

| Tool | What it does |
|---|---|
| `rt_<name>` | One tool per saved routine, with its parameters. Replays without a model. |
| `routine_run` | The same, by name, for clients that read tools only at startup. `match_viewport: true` resizes the window to the size the routine was recorded at and puts it back afterwards. |
| `routine_resume` | Continue a paused replay. `approve` goes past a pause or stops. `choice` picks the element for a changed step. |
| `routines_list` | Saved routines and what each is for. |
| `routine_describe` | The full notes: when to use it, when not to, values it asks for, where it pauses. For a routine someone else wrote, the text is shown as [untrusted data](/docs/safety). |
| `run_steps` | The numbered steps of a recorded run, to choose what to leave out when saving. |
| `routine_save` | Save a recorded run as a routine. Write the description as what it does, then "Use when ...". |

At most 30 routine tools are exposed at once. The rest are reached with `routines_list` and `routine_run`.

## Directory tools

| Tool | What it does |
|---|---|
| `routines_search` | Search the public directory by words, or by the site a person is on. No account needed. |
| `routine_install` | Install `owner/name` from the directory. It is checked again on this side. |
| `routine_install_from_git` | Ask to install from a GitHub repository. The side panel shows every step, and Install is the person's click. |
| `routine_publish` | Ask to send a routine for review. The person approves in the side panel. An agent can't publish by itself. |
| `routine_submissions` | Where each submission stands: waiting, rejected with the guideline, live or turned off. Read only. |

## A replay that stops

A replay returns one of these:

- **Done.** The result text lists the steps run and the time. It adds a note when the window was a very different size from the one the routine was recorded at (see [Viewport](/docs/how-it-works#window-size)).
- **Paused.** The next step can't be undone. Call `routine_resume` with `approve: true` to go on, or `false` to stop.
- **Needs a choice.** A step changed. The result shows the recorded and current crops as text and up to three candidate elements. Call `routine_resume` with the `ref` of the right one.
- **Failed.** The result says which step and why. A step that would leave the routine's site always fails here.

A routine written by someone else also pauses before any step that looks irreversible, even if its author didn't mark one, and only the person can approve that pause, in the side panel. [Untrusted content](/docs/safety) covers why.
