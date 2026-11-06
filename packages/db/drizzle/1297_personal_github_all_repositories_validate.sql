-- deployment-mode: rolling
-- Validates the check 1296 added NOT VALID. Every existing row has a null
-- all_repositories_access, and 1296's routine is the only writer.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE personal_github_repository_selection_heads
  VALIDATE CONSTRAINT personal_github_repository_selection_heads_all_access_chk;
