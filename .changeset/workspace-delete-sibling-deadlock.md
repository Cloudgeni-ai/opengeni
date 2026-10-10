---
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Workspace deletion no longer deadlocks with ordinary writers in the same organization (previously a retryable 503 `DATABASE_CONTENTION`): it locks the organization row `FOR NO KEY UPDATE`, takes the target's workspace-control prefix before its workspace row, and locks sibling workspace rows only `FOR KEY SHARE`. A deletion blocked by retained editable documents, spreadsheets, or presentations now names them in its 409 message.
