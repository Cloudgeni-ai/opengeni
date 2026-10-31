-- deployment-mode: rolling
-- Validate the audience check 1160 added NOT VALID. Every existing artifact
-- has the default 'workspace_shared' audience, so every row passes; this only
-- scans under SHARE UPDATE EXCLUSIVE and blocks no reads or writes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE editable_artifacts
  VALIDATE CONSTRAINT editable_artifacts_visibility_chk;
