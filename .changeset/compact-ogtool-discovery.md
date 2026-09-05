---
"@opengeni/ogtool": patch
---

Make CLI catalog discovery compact by default, showing callable paths and short
Unicode-safe descriptions. Add compact `list --json`, retain the previous full
catalog output under `list --full`, and add bounded single-tool `show` details and
schemas. Compact pages default to 50 tools, accept literal `--query` filtering and
`--limit`/`--offset`, and cap complete stdout at 16 KiB with truthful continuation
metadata. Existing scripts parsing full catalog JSON must opt into `--full`.
Escape terminal control characters in compact text descriptions only, counting
rendered escape bytes toward the page cap without rewriting catalog or JSON content.
Mirror discovery behavior in the Connected Machine native Codemode CLI.