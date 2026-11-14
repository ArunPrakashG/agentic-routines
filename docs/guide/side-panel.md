# The side panel

The extension's side panel is where you see what agents do, save and run routines yourself, and decide what an agent may not decide alone. Open it from the toolbar button.

## First start

The panel shows **Connect your agent** with the command to run once in a terminal, `npx agentic-routines setup`, and a Copy button. Below it, each agent setup found shows as Connected or Waiting. **Done** turns on once the extension reaches the program on your computer. If your agent runs on another computer, open **My agent is on another computer** ([A browser on another computer](remote.md)).

## Your routines

The main screen lists your routines. Each row shows:

- the name, who it is by, and **Not reviewed** when it came from a repository or a folder rather than the directory
- the site, the version, which agent drafted it, and when it last ran
- what it has saved you, and which steps changed on the last run
- **Turned off** with the reason, when a source was blocked or the routine was turned off

The buttons on a row are **Run**, **Share** (save it into the project an agent is working in, see [Project routines](project.md)), **Submit** to the directory (or **Sign in to submit**), and **Turn on** for one that is off. A routine with [hooks](hooks.md) links to them.

Runs an agent finished but did not save are listed too, each with **Save**. **This week** adds up what routines saved, and **How this is worked out** shows the sums. A build loaded by hand shows when a new version is out, with a link to what changed.

## Record a demo

Do a task yourself and save it the same way an agent's run is saved. Press **Record a demo**, or `R` in the panel, or `Alt+Shift+R` anywhere in the browser (change it on the browser's keyboard shortcuts page). The toolbar button says REC while it records. Press it again to stop. Passwords you type are never recorded.

## Save a routine

- **Name**: lowercase letters, numbers and dashes. It becomes the tool `rt_<name>`.
- **When to use**: what it does, then "Use when …" in the words a person would say, at least 20 characters. Agents choose by this.
- **Asked each run**: the values that become parameters, with the example seen while recording. The cross next to one keeps the recorded value instead.
- The steps, with **direct URL** on a click-through that became an address, and which steps pause first.
- **Submit to the directory for review**, if you are signed in.
- **Discard** throws the run away.

## Run a routine

**Run** asks for each value the routine needs, a file as a path on this computer, and each secret as a password field that is not saved. A routine that needs nothing starts at once.

While it runs the panel shows the steps, the time, how long it has gone with no model calls, and any step that changed and was fixed. **Stop**, or `Esc`, ends it.

At a pause the panel shows what the next step does. **Approve**, or `Ctrl+Enter` (`Cmd+Enter` on a Mac), goes on; `Esc` says no. A pause an agent asked about can also be answered in the agent's own window.

## Tabs lent to agents

Lend a tab of yours with the toolbar button. It shows ON, and an agent can work in it. **Lent to agents** in the panel lists those tabs, each with **Take back**.

## Hand-overs

When an agent needs you for a sign-in, a code or a payment, it hands you the tab. A card on the page says who asks and why, the toolbar button says WAIT, and a desktop notification says the agent needs you (turn that off in Settings). Click Done on the card or the toolbar button to give the tab back.

## The toolbar badge

| Badge | Means |
|---|---|
| REC | Recording a demo. |
| WAIT | An agent handed you this tab. |
| ON | This tab is lent to agents. |
| 1 | Something waits for you: a paused run, a publish to approve, or an install to read. |

## Account menu

Signing in is optional. Recording, running and editing routines never need an account. You need one to publish to the directory.

- **Sign in** with Google, GitHub or Microsoft, or with an email address and a password. For email, the panel mails a 6-digit code to show the address is yours, then you choose a password of at least 10 characters. **New here, or forgot your password?** does the same for a new account or a forgotten password. Too many wrong passwords locks sign-in for 15 minutes.
- **Sources**: where routines come from. Turn the directory on or off, and each repository or folder. Open one to see its routines, any problems in its `config.routine`, and **Review** for each routine before you install it. **Remove this source** takes it away. Add a GitHub repository or a folder on this computer. A project's own folder shows as Project. See [Routine repositories](repositories.md).
- **Settings**: where agent tabs open, tab groups, when an agent's untouched tab closes, the agent's cursor, hand-over notifications and input at a person's pace ([Settings and status](tools.md#settings-and-status)). Pairing with [a browser on another computer](remote.md) is here too.
- **Your submissions**: what you sent to the directory and where each stands ([Sharing and publishing](sharing.md)).
- **Sign out**.

## Approvals

Some things wait for you in the panel whatever an agent says:

- publishing a routine, with the list of values that become public
- installing a routine from the directory, a repository or a folder, after you read its steps
- allowing a routine's hooks, after you read the code
- a step that looks irreversible in someone else's routine
