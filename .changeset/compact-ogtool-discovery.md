---
"@opengeni/ogtool": patch
---

Make CLI catalog discovery compact by default, showing callable paths and short
Unicode-safe descriptions. Add compact `list --json`, retain the previous full
catalog output under `list --full`, and add bounded single-tool `show` details and
schemas. Existing scripts parsing full catalog JSON must opt into `--full`.
Mirror discovery behavior in the Connected Machine native Codemode CLI.