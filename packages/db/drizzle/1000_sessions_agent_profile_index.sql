-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS "sessions_workspace_agent_profile_idx"
  ON "sessions" ("workspace_id", ("agent_profile" ->> 'profileId'), "updated_at" DESC)
  WHERE "agent_profile" IS NOT NULL;
