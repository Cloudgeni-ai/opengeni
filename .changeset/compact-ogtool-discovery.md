---
"@opengeni/ogtool": patch
---

Make CLI catalog discovery compact by default, showing callable paths and short
Unicode-safe descriptions. Add compact `list --json`, retain the previous full
catalog output under `list --full`, and add bounded single-tool `show` details and
schemas. Default text and compact JSON list all authorized catalog entries without
an aggregate byte cap or default pagination. Accept literal `--query` filtering and
strictly opt-in `--limit`/`--offset` compatibility slices with continuation metadata.
Existing scripts parsing full catalog JSON must opt into `--full`.
Escape terminal control characters in compact text descriptions only without
rewriting catalog or JSON content or dropping rows after escape expansion.
Mirror discovery behavior in the Connected Machine native Codemode CLI.