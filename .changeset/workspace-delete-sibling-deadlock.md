---
---

Workspace deletion no longer deadlocks with ordinary writers in sibling workspaces of the same organization (previously a retryable 503 `DATABASE_CONTENTION`): it locks the organization row `FOR NO KEY UPDATE` and sibling workspace rows `FOR KEY SHARE` instead of `FOR UPDATE`. A deletion blocked by retained editable documents, spreadsheets, or presentations now names them in its 409 message.
