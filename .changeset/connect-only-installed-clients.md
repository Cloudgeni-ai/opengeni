---
"opengeni": patch
---

`opengeni connect --client all` sets up only the coding agents installed on this computer, like running it without `--client`, and lists the others as skipped. Naming a client (`--client codex`) still sets it up when it isn't detected; to set up every client regardless, name them all (`--client claude,codex,cursor,vscode`). Mixing `all` with names is rejected.
