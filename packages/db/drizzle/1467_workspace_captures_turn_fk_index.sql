-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS workspace_captures_turn_fk_idx
ON workspace_captures (turn_id)
WHERE turn_id IS NOT NULL;
