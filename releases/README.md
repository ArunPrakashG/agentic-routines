# Releases

Each folder here is one released version: the packages that were shipped, their checksums, and the notes.

```
releases/
  scripts/        how a release is made
  store/          store listing text and the reason for every permission
  v0.2.0/
    extensions/   agentic-routines-0.2.0-chrome.zip, -firefox.zip, -sources.zip
    cli/          agentic-routines-0.2.0.tgz (the npm package)
    NOTES.md, SHA256SUMS, RELEASE.json
  v0.1.0/         the first release, with its files side by side
```

The Chrome zip also goes to Edge Add-ons. The sources zip goes to Firefox Add-ons with the Firefox zip, as it asks for the source of anything bundled.

## Make a release

1. Merge what ships into `main` and pull it.
2. `pnpm release:version 0.2.0` sets the version everywhere. Commit it.
3. `pnpm release` builds into `releases/v0.2.0`. It refuses to run with uncommitted changes, and runs the store checks on the result.
4. Edit `releases/v0.2.0/NOTES.md`, commit the folder, tag `v0.2.0`.
5. Upload the zips to each store (`store/listing.md` has the text), publish the npm package with `npm publish releases/v0.2.0/cli/agentic-routines-0.2.0.tgz`, and attach the files to the GitHub release.

6. `pnpm release:bundle` builds what the install script downloads into `.dev/bundles/v0.2.0`, too big to commit: for each platform a Node runtime and the CLI, with `manifest.json` and `manifest.sig`. Upload every file there to the GitHub release of the tag, and mark it as the latest.

The first time only, `node releases/scripts/signing-key.mjs` makes the key that signs the manifest. Commit `releases/update-key.pub`, and keep `.keys/update-signing.pem` somewhere safe: without it, installed copies never update again. On a machine without the file, put it in `AR_UPDATE_SIGNING_KEY`.

While the repo is private, `pnpm release:private 0.3.1` publishes the CLI package to GitHub Packages as `@arunprakashg/agentic-routines` (needs `gh` with the `write:packages` scope). Installing it takes `@arunprakashg:registry=https://npm.pkg.github.com` and a token with `read:packages` in `~/.npmrc`.

`dev/e2e/e2e-install.sh` tries the install script and an update on this machine, using a throwaway key.

`pnpm check:store <dir>` runs the store checks alone on a build folder.

## What the checks catch

Manifest version, name and description length, the icons, a version number the stores accept, no dev key in a store build, a reason for every permission and none left over, the Firefox data collection declaration, and no remote or string-built code in the bundle.

## Extension ids

Unpacked builds keep one id because the manifest carries a key. Store builds do not carry it, so each store assigns its own id. Add each id to `EXTENSION_IDS` in `packages/browsers/src/index.ts` after the first upload, or the browser will refuse to start the companion.

## Hooks in store builds

The hook sandbox needs eval, which the stores' remote-code rules do not allow, so store builds (`AR_STORE=1`) leave out the sandbox and offscreen pages and the `offscreen` permission. Hooks run in the unpacked build only.
