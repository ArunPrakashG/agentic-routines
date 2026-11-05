# Sharing and publishing

There are two ways to share a routine with other people.

## The directory

The [directory](/directory) is a list of routines that Agentic Routines has reviewed.

1. Save the routine, then ask your agent to publish it, or use the side panel. An agent can't publish on its own: the panel shows exactly what becomes public and you approve there.
2. What is sent is a submission. Crops, and any typed value that is not a parameter, stay on your machine.
3. A person reads every submission against the [guidelines](/guidelines) before it is listed. An update to a listed routine waits for review too, and the approved version stays live meanwhile.
4. A rejection names the guideline and says what to change. `routine_submissions` and the side panel show where each one stands.

To use one, ask your agent to search the directory, or open its page and install it. Installed routines are checked again on your side, and the first run steps through with the panel open.

You need to sign in with Google to publish. Installing needs no account.

## A GitHub repository

Put routines in a repository as single files under `routines/`. Anyone can add it with `npx agentic-routines sources add github.com/owner/repository` and install from it in the side panel.

Routines from a repository are not reviewed by Agentic Routines. The extension says so, shows every step before installing, and pins the commit it read, so a later commit changes nothing until you look again.

See [Routine format](/docs/routines) for how to export a routine as a file.

## Taking something down

You can take a published routine down at any time. Anyone who installed it keeps their local copy. Agentic Routines can turn off a listed routine or block a publisher, and always says why. The block list is public, and installs from a blocked source are turned off with a note.
