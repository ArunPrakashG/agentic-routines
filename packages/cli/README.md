# Browser Routines

Record a browser task once from your agent. Replay it later without the model.

```
npx browser-routines setup
```

That one command connects every browser and agent it finds (Claude Code, Codex, GitHub Copilot, OpenCode; Chrome, Edge, Brave, Vivaldi, Firefox). Then install the extension and open its panel.

```
npx browser-routines doctor
```

Says what is connected and what is not.

## The directory

Your agent can look for a routine someone else already published, and publish yours.

- `routines_search` finds routines by words or by the site you are on.
- `routine_install` saves one to your machine, under its owner's name.
- `routine_publish` asks you to approve in the side panel, where you see what becomes public. Needs a signed-in account.

https://github.com/ArunPrakashG/browser-routines
