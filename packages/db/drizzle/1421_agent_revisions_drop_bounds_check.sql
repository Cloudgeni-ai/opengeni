-- deployment-mode: rolling
-- First-message cleanup: drop the old revision bounds (Instructions at most
-- 20,000 characters); 1419's validated check keeps every other bound. Neither
-- release relies on the database refusing longer Instructions: the API limits
-- what a person sends.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_revisions DROP CONSTRAINT IF EXISTS agent_revisions_bounds_check;
