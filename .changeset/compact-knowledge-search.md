---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
"@opengeni/worker-bundle": minor
---

Make Knowledge search eager for new configured sessions where search is already
available, without changing existing sessions' saved tool selections. Reduce
search schema overhead and default MCP searches to five results instead of 20.
Model callers receive discovery cards with short snippets; use knowledge_get
for full text, citation revision IDs and update versions. Codemode retains the
complete result shape, HTTP list defaults are unchanged, and previously stored
model results are never re-rendered. Existing explicitly eager search tools can
incur a one-time schema-prefix cache miss after upgrade.
