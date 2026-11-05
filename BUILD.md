# Building the extension from source

For store reviewers. Needs Node 20 or newer and pnpm 10.

```
pnpm install --frozen-lockfile
AR_STORE=1 pnpm -C packages/extension exec wxt build -b firefox --mv3
```

The result is in `packages/extension/.output/firefox-mv3`. Drop `-b firefox --mv3` for the Chrome build in `chrome-mv3`.

Everything the extension runs is in `packages/extension` and `packages/core`. Nothing is downloaded or built from strings at run time.
