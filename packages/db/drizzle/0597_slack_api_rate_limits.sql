-- deployment-mode: maintenance
-- The new deployment-global relation changes the exact runtime posture contract.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO $drain$
DECLARE roles jsonb := nullif(current_setting('opengeni.migration_application_roles', true), '')::jsonb;
BEGIN
  IF roles IS NULL OR jsonb_typeof(roles) <> 'array' OR jsonb_array_length(roles) NOT BETWEEN 1 AND 16
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(roles) item WHERE jsonb_typeof(item) <> 'string'
      OR btrim(item #>> '{}') = '' OR item #>> '{}' <> btrim(item #>> '{}') OR octet_length(item #>> '{}') > 63)
    OR EXISTS (SELECT 1 FROM pg_stat_activity a JOIN jsonb_array_elements_text(roles) r ON r = a.usename
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) THEN
    RAISE EXCEPTION 'Slack API quota migration requires stopped application roles' USING ERRCODE = '55000';
  END IF;
END $drain$;

-- Only a hash of app/workspace/method and a timestamp. No Slack or tenant content.
CREATE TABLE slack_api_rate_limits (
  scope_hash text PRIMARY KEY CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  next_allowed_at timestamptz NOT NULL
);
REVOKE ALL ON TABLE slack_api_rate_limits FROM PUBLIC;
-- db:provision-roles grants the exact current runtime role after activation.
