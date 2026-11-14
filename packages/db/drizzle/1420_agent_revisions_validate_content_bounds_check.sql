-- deployment-mode: rolling
-- First-message cleanup: validate 1419's check. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while it scans; every existing row
-- satisfies it, as the old check is stricter.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_revisions VALIDATE CONSTRAINT agent_revisions_content_bounds_check;
