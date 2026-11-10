# Project routines

Keep a project's routines in its own repository. Git tracks them, the team reviews them in pull requests, and an agent started in the repository finds them.

## Share a routine

Run this inside the repository:

```bash
npx agentic-routines project add deploy-staging
```

It copies the routine to `.agentic-routines/routines/deploy-staging.md` and adds a short `README.md` beside it. Review the file and commit it. Running the command again after you improve the routine writes a new version; if nothing changed, it says so.

Example values you typed while recording stay out of the file. Add `--examples` to keep them.

The routine must pass the same checks as one from a Git source. It is refused if it holds something that looks like a secret.

To take one back out, run `npx agentic-routines project remove deploy-staging` and commit the deletion. Copies already installed on other computers stay until their owners remove them.

## Use the team's routines

Start an agent in the repository, as usual. The Agentic Routines server notices the `.agentic-routines` folder and:

1. lists it as a source (shown as "Project" in the side panel), and
2. tells the agent which routines the project has and which are not installed on your computer yet.

Nothing is installed by this. A routine from a repository is text somebody else wrote, and it acts in your signed-in browser. So you read its steps in the side panel and click Install, once per routine. When the file changes after you installed it, the routine shows as changed and needs a new install. `npx agentic-routines project` shows the state of each one:

| State | Meaning |
|---|---|
| not installed | Listed, but you have not installed it. |
| installed | The installed copy matches the file. |
| changed | The file changed after you installed it. Read it and install again. |

If you remove the project from the side panel, it is not added again.

## Layout

```
.agentic-routines/
  README.md
  routines/
    deploy-staging.md
```

The folder works like any other [routine repository](repositories.md), so a `config.routine` file in it can add notes for the agent and list the pages each routine is for.
