---
"@opengeni/api-router": patch
---

The session list (`GET /v1/workspaces/:workspaceId/sessions`) and session lineage routes now read their per-session decorations at the same time instead of one after another. On the list these are background-command activity, automation targets and the effective tool policy; on lineage they are automation targets and policy. Responses, headers and errors are unchanged: when more than one read fails, the request still returns the error the old order would have returned.
