-- deployment-mode: rolling
-- Validates the check 1370 re-added NOT VALID. Every existing row matched the
-- narrower owner pattern, which the widened one includes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE personal_github_repository_selections
  VALIDATE CONSTRAINT personal_github_repository_selections_shape_chk;
