-- deployment-mode: rolling
-- Whether a session's earlier hosted web searches reach the model as a
-- labelled runtime record in the user role instead of the original
-- assistant-role record. A worker sets it once, and only while the session's
-- active history projects the same in both forms, so no text an earlier
-- request sent ever changes. Every existing session starts without it. The
-- previous release never reads or sets the column.
SET LOCAL lock_timeout = '5s';
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS search_records_as_input boolean NOT NULL DEFAULT false;
