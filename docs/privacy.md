# Privacy

Browser Routines keeps your routines and recordings on your computer. Nothing is sent anywhere unless you sign in, and signing in is optional.

## On your computer

- Routines, recorded runs, settings and the list of recent runs are stored in the browser and in a folder in your home directory (`~/.browser-routines`).
- A recorded run can contain what was on the page: element names, addresses and the values you or your agent typed. Values that were marked as secrets are never stored.
- The extension talks only to the companion program on your computer, which your coding agent starts. It does not send page content over the network.

## If you sign in with Google

- The extension opens Google's sign-in. Our server receives the one-time code Google returns, checks it with Google, and stores your Google account id, email address, name and picture.
- It also stores a hash of the session token and the id of the browser install the session belongs to.
- That is all it stores. Signing out ends the session. To have your account records removed, open an issue and say so.

## What we do not do

- We do not sell data, show ads, or use it for anything outside running the product.
- We do not load code from anywhere. Everything the extension runs ships in the package.

## Changes

Sync and a public directory of routines are not part of this version. This page will change before they ship, and the extension will say what is shared before it shares anything.

Questions: open an issue at https://github.com/ArunPrakashG/browser-routines/issues.
