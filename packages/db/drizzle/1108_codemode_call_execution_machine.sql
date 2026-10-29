-- deployment-mode: rolling
-- A Codemode call made by code running on another enrolled machine (a
-- `run_on` exec, whose Codemode token names that machine) records the
-- machine, so a tool that takes a path in the workspace reads it where the
-- calling code runs instead of on the session's active sandbox. Nullable and
-- additive: older binaries never read or write it, and a call without it
-- resolves paths on the active sandbox as before.
SET LOCAL lock_timeout = '5s';

ALTER TABLE session_attempt_codemode_calls
  ADD COLUMN IF NOT EXISTS caller_execution_sandbox_id uuid;
