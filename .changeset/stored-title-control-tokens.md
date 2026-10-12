---
"@opengeni/contracts": patch
"@opengeni/db": patch
---

Session reads no longer return model control tokens such as `<|fim_suffix|>` in automatic titles stored before write-time stripping existed. The API, MCP session detail, search, mobile and rename prompts now show the clean title. Human renames are returned unchanged, and the stored row is not rewritten. `cleanStoredSessionTitle` is exported from contracts for clients that read raw titles.
