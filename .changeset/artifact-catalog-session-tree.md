---
"@opengeni/contracts": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
---

An open chat's artifact list no longer reads the catalog once per sub-session. `GET /v1/workspaces/:workspaceId/artifact-catalog` takes `includeSubSessions=true` with `sourceSessionId`. The server then lists that chat and the sub-sessions its lineage lists (depth 5, 200 at most) in one keyset-paged query. It authorizes those sessions in one batch and skips any the caller may not read, and each item keeps its own `sourceSessionId`. The session dock now makes two paged reads per refresh (active, then archived) however many sub-agents the chat started, with no lineage read or per-sub-session cache. It keeps at most one refresh in flight and runs one more afterwards if new tool output arrived meanwhile. Before, a chat with about 50 running sub-agents re-read up to about 100 catalog pages on every turn end and overlapped those reads on a busy chat. Rolling migration 0991 lets the published-file listing routine accept a bounded `sourceSessionIds` list. The previous release's single `sourceSessionId` keeps its meaning.
