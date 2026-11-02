-- deployment-mode: rolling
-- A chat's changeable unattended setting (whether a person will answer during
-- its turns), kept apart from the session's frozen metadata:
--   unattended / attended   an explicit choice (the chat's switch, the API, or
--                           a scheduled task that says so)
--   unattended_by_default   an automation started the chat; a person's
--                           message turns it into attended
-- NULL leaves the create option recorded in metadata in charge. The column is
-- nullable and additive; older binaries never read or write it. The fork
-- routines start from the complete source row, so a fork keeps it.
--
-- started_unattended records, once at create, that the chat began unattended
-- through its setting (an automation's default or an explicit choice). It is
-- never updated: what the model is told and which tools it has follow how the
-- chat started, so a later change of the setting never rewrites instructions
-- or tools an earlier request already sent. NULL means it did not (or the row
-- predates this column); the create option in metadata still counts.
SET LOCAL lock_timeout = '5s';

-- Every existing row is NULL, so the bound is added NOT VALID: it holds for
-- every new write without scanning the table under its lock.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS unattended_setting text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS started_unattended boolean;
-- A test or preview database that ran an earlier, unreleased numbering of this
-- migration already has the constraint; replace it so this file applies.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_unattended_setting_values;
ALTER TABLE sessions ADD CONSTRAINT sessions_unattended_setting_values
  CHECK (unattended_setting IS NULL
    OR unattended_setting IN ('unattended', 'attended', 'unattended_by_default'))
  NOT VALID;
