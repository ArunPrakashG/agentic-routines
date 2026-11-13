# 0.3.3

## Scripts
- An agent's script runs straight away. It no longer waits for a yes in the side panel, which failed after two minutes when the panel was closed. A script still cannot read cookies, does not run in a tab where a secret was typed, and has values that look like credentials hidden from its result.

## Security
- The accounts service is built with Go 1.27.4, which fixes a flaw in Go's HTTP library (GO-2026-6859).
