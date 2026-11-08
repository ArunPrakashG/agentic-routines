# Wiki

The wiki is built from `docs/`, so the pages are written once. `node dev/wiki/build.mjs` writes them to `.dev/wiki`.

To publish (the repository must allow a wiki, which a private one needs a paid plan for, and the first page has to be made once in the web UI so the wiki's git repository exists):

```bash
node dev/wiki/build.mjs
git clone https://github.com/ArunPrakashG/agentic-routines.wiki.git .dev/wiki-repo
cp .dev/wiki/*.md .dev/wiki-repo/
git -C .dev/wiki-repo add -A && git -C .dev/wiki-repo commit -m "Update the wiki" && git -C .dev/wiki-repo push
```
