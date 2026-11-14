# Sharing and publishing

There are two ways to share a routine with other people. Both are free: Agentic Routines is open source, with no paid tier, and publishing and installing cost nothing.

## The directory

The [directory](/directory) is a list of routines that Agentic Routines has reviewed.

1. Save the routine, then ask your agent to publish it, or use the side panel. An agent can't publish on its own: the panel shows exactly what becomes public and you approve there.
2. What is sent is a submission. Crops, and any typed value that is not a parameter, stay on your machine.
3. A person reads every submission against the [guidelines](/guidelines) before it is listed. An update to a listed routine waits for review too, and the approved version stays live meanwhile.
4. A rejection names the guideline and says what to change. `routine_submissions` and the side panel show where each one stands.

To use one, ask your agent to search the directory, or copy the `routine_install("owner/name")` line from its page and give it to your agent. The side panel shows every step before it installs. Installed routines are checked again on your side, and a step that looks irreversible in someone else's routine always waits for you.

You need an account to publish: sign in from the side panel with Google, GitHub, Microsoft, or an email address and a password. Installing needs no account.

### Your directory name

The first time you publish, the panel asks for the name your routines are listed under, such as `acme` in `acme/play-release`. It is 3 to 30 lowercase letters, digits and dashes, and it is set once.

### What the publish card shows

Before you approve, the card lists every value that would become public: text typed into a field that is not a parameter, and addresses with details in them. If there are none, it says so. Example values you gave for parameters stay on your computer.

### Limits

A routine can have up to 300 steps. You can have up to 100 routines listed, 10 submissions waiting for review, and 30 submissions a day.

### Where a submission stands

`routine_submissions` and **Your submissions** in the side panel's account menu show each one:

| State | What you can do |
|---|---|
| Waiting for review | **Withdraw** it. An update waiting for review leaves the listed version live. |
| Rejected | Read the guideline it broke and the reviewer's note, then **Fix and resubmit**. |
| Live | Shows how many people installed it. |
| Turned off | Shows why. **Fix and resubmit** puts it back in review. |

### The directory pages

[/directory](/directory) searches by site or task; a search that looks like a site name, such as `play.google.com`, lists that site's routines. Most installed comes first. Each routine has a page with its notes, numbered steps, where it pauses, the values it asks for and its Playwright code. Each publisher has a page listing their routines and installs.

The publisher's extension sends the routine's Playwright code with it. The directory shows it and the reviewer sees it. It is only for reading. Nothing ever runs the uploaded copy, and an install does not keep it: a fast run compiles its own from the steps installed on that machine. Running code from an upload would mean running someone else's code in a signed-in browser, past review, and the steps are what is reviewed. Nothing checks that the uploaded code matches the steps either, so the steps are what to judge a routine by.

## A GitHub repository

Put routines in a repository and describe them in a `config.routine` file in its root, or as single files under `routines/`. See [Routine repositories](/docs/repositories) for the file and a full example. Anyone can add it with `npx agentic-routines sources add github.com/owner/repository` and install from it in the side panel.

Routines from a repository are not reviewed by Agentic Routines. A source can also be a folder on your computer: `sources add` and the side panel take a path as well as a repository. The extension says so, shows every step and the author's notes before installing, and pins the commit it read, so a later commit changes nothing until you look again.

See [Routine format](/docs/routines) for how to export a routine as a file.

## Taking something down

You can withdraw a submission while it waits for review. A live routine has no button to take it down yet: open an issue on GitHub and it is turned off. Anyone who installed it keeps their local copy. Agentic Routines can turn off a listed routine or block a publisher, and always says why. The block list is public, and installs from a blocked source are turned off with a note.
