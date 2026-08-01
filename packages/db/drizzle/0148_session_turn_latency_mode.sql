-- deployment-mode: rolling
-- Per-turn latency mode is the durable peer of model + reasoning_effort.
-- Existing rows default to Standard; backfill from frozen turn execution policy.

ALTER TABLE session_turns
  ADD COLUMN latency_mode text NOT NULL DEFAULT 'standard',
  ADD CONSTRAINT session_turns_latency_mode_check
    CHECK (latency_mode IN ('standard', 'priority', 'fast'));

UPDATE session_turns
SET latency_mode = metadata->'turnExecutionPolicyV1'->>'latencyMode'
WHERE metadata->'turnExecutionPolicyV1'->>'latencyMode' IN ('standard', 'priority', 'fast');
