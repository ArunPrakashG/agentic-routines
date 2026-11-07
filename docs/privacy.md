# Privacy

Agentic Routines keeps your routines and recordings on your computer. Nothing is sent anywhere unless you sign in and choose to publish, or connect your browser to an agent on another computer of yours. Both are optional.

## On your computer

- Routines, recorded runs, settings and the list of recent runs are stored in the browser and in a folder in your home directory (`~/.agentic-routines`).
- A recorded run can contain what was on the page: element names, addresses and the values you or your agent typed. Values that were marked as secrets are never stored.
- The extension talks to the companion program on your computer, which your coding agent starts. Unless you connect it to another computer as described below, it does not send page content over the network.

## If you connect your browser to another computer

You can connect the extension to an agent on another computer by entering an address and a one-time code in its settings. It is off until you do, and Disconnect turns it off. We run no server in the middle and receive none of this.

- While connected, what the agent works with goes to that computer: the pages it reads, their addresses, what is typed, screenshots, recordings and network captures, and files it asks to download with your sign-ins. Routines and recordings are kept there.
- This link is not encrypted by us. Anyone on the network path can read and change what passes, unless you use something that encrypts it, such as Tailscale, WireGuard or an SSH tunnel.
- The address, the name of that computer and a key for it are kept in the browser's extension storage, and a key for the browser on that computer. They stay until you disconnect.
- That computer's owner can use your browser with your sign-ins, so connect only to a computer of your own.

## If you sign in with Google

- The extension opens Google's sign-in. Our server receives the one-time code Google returns, checks it with Google, and stores your Google account id, email address, name and picture.
- It also stores a hash of the session token and the id of the browser install the session belongs to.
- Signing out ends the session. You can delete your account in the extension; that removes these records, your sessions and everything you published.

## If you publish a routine

- Publishing sends the routine to us for review: its name, description, site, steps, the pages it was recorded on and the handle you chose. Example values you typed while recording are not sent.
- A submission is private until a person approves it. Once approved, the routine, your handle and the number of installs are public on the directory.
- We keep who submitted what, and the decision, so that a rejection can be explained and a publisher can be blocked.
- You can withdraw a submission that is waiting, or take down a routine you published, at any time.

## When you install from the directory or from Git

- Searching the directory sends the words you typed, or the site you are on, to our server. Installing a routine reports one anonymous install to the count.
- Installing from a Git repository fetches the files straight from GitHub. We are not involved, and the extension shows every step before it installs.
- The extension reads a block list from us at least once a day, so it can turn off a routine that was found to be unsafe. The request carries no account or recording.

## This website

- The directory pages read the public directory from our server in your browser. We do not set cookies and we do not run ad or tracking scripts.

## What we do not do

- We do not sell data, show ads, or use it for anything outside running the product.
- We do not load code from anywhere. Everything the extension runs ships in the package.

## Changes

This page changes when what we collect changes, and the extension says what is shared before it shares anything.

Questions: open an issue at https://github.com/ArunPrakashG/agentic-routines/issues.
