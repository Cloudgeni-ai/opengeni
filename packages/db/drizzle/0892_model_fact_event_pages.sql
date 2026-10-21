-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
-- opengeni:pre-release
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_events_model_fact_page_idx
ON session_events (workspace_id, session_id, turn_id, occurred_at, id)
WHERE type = 'agent.model.usage';
