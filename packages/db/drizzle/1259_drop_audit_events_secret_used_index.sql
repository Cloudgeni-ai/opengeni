-- deployment-mode: rolling
-- contract-step: nothing in this release reads audit_events_secret_used_idx; the previous release's session-tree secret lookup only loses an index and falls back to audit_events_workspace_created_idx
-- Known-value masking (1023) loaded a session tree's earlier secret uses
-- through this index. Masking is gone, so the index only costs writes.
DROP INDEX IF EXISTS audit_events_secret_used_idx;
