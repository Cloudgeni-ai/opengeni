-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS retained_screenshot_artifacts_turn_fk_idx
ON retained_screenshot_artifacts (turn_id)
WHERE turn_id IS NOT NULL;
