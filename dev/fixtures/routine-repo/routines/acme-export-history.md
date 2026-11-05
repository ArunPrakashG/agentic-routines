---
name: acme-export-history
version: 1
site: console.acme.test
description: Export the release history. Use when the user wants past releases.
params: {}
secrets: []
pauses: []
---

Opens the history and exports it.

```steps
[
  {"n":1,"action":"navigate","label":"Open the history","url":"https://console.acme.test/history"},
  {"n":2,"action":"click","label":"Export CSV"}
]
```
