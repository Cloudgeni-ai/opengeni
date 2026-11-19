-- deployment-mode: rolling
-- Whether `tool_result_read` (the reader of tool results too large to show
-- whole) is in the session's first-request tool list. A session's tool list
-- must not change once a request has carried it, so every existing session
-- keeps false and reaches the reader through tool search when it has one.
-- Sessions created from now on start with true and list it from their first
-- request. Nothing ever changes the value afterwards. The previous release
-- never reads the column.
SET LOCAL lock_timeout = '5s';
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS tool_result_reader_listed boolean NOT NULL DEFAULT false;
ALTER TABLE sessions
  ALTER COLUMN tool_result_reader_listed SET DEFAULT true;
