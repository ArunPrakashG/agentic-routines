---
name: acme-release
version: 1
site: console.acme.test
description: Start a rollout of a build to internal testing. Use when the user asks to release a build.
params:
  version_name:
    type: string
  release_notes:
    type: string
secrets: []
pauses:
  - 5
---

Opens the release page, fills in the version and the notes, and pauses before the rollout starts.

```steps
[
  {"n":1,"action":"navigate","label":"Open the release page","url":"https://console.acme.test/releases/new"},
  {"n":2,"action":"type","label":"Version name","value":"{{version_name}}"},
  {"n":3,"action":"type","label":"Release notes","value":"{{release_notes}}"},
  {"n":4,"action":"click","label":"Review release"},
  {"n":5,"action":"click","label":"Start rollout","pause":"auto"}
]
```
