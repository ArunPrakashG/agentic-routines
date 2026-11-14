# 0.3.5

## Installing from the directory
- `routine_install` now opens a card in the side panel with the routine's steps, its notes and who wrote it. Nothing is saved until you choose Install there. The extension fetches the routine itself, so an agent only passes its id.
- With no browser connected, `routine_install` says so instead of saving the routine unseen.

## Your account
- **Take down** in Your submissions removes a live routine from the directory, after you confirm.
- **Delete account** in the account menu deletes your account, its sign-ins and everything you published, after you confirm. Your routines on this computer stay.

## Fixes
- `setup` no longer fails when an agent's config file has no server list yet.
- The directory keeps its rate limits when its cache is down.
