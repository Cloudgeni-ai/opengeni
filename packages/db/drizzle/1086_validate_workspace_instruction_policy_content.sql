-- deployment-mode: rolling
-- Validate the instruction-policy content check 1085 added NOT VALID. It is
-- weaker than the check it replaced, so every existing revision passes; this
-- only scans under SHARE UPDATE EXCLUSIVE and blocks no reads or writes.
SET LOCAL lock_timeout = '5s';

ALTER TABLE workspace_instruction_policy_revisions
  VALIDATE CONSTRAINT workspace_instruction_policy_revisions_content_chk;
