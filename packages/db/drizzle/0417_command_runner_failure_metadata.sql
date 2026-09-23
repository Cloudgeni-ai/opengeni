-- deployment-mode: rolling
-- A single retained field follows exact provider proof through settlement.
-- No new delivery cursor or ACK authority is introduced.
ALTER TABLE session_background_commands
  ADD COLUMN runner_failure jsonb,
  ADD CONSTRAINT session_background_commands_runner_failure_check CHECK (
    runner_failure IS NULL OR (
      provider = 'connected_machine'
      AND jsonb_typeof(runner_failure) = 'object'
      AND octet_length(runner_failure::text) <= 8192
      AND runner_failure ?& ARRAY['code', 'retryable']
      AND jsonb_typeof(runner_failure -> 'code') = 'string'
      AND (runner_failure ->> 'code') ~ '^[A-Za-z0-9_-]{1,128}$'
      AND runner_failure -> 'retryable' = 'false'::jsonb
      AND (NOT (runner_failure ? 'detail') OR jsonb_typeof(runner_failure -> 'detail') = 'object')
    )
  );