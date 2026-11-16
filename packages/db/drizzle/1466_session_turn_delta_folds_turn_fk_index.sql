-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_turn_delta_folds_turn_fk_idx
ON opengeni_private.session_turn_delta_folds (turn_id);
