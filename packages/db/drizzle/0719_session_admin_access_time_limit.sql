-- deployment-mode: rolling
-- Admin access for a session lasts as long as the person who gave it chose:
-- a number of hours, or no time limit (null). Every use already re-checks
-- the grant live, so access ends on the first call after this time. Grants
-- given before this column existed keep no time limit, as they were given.
-- Old releases never read the column and keep treating every grant as open.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "session_admin_access" ADD COLUMN "expires_at" timestamptz;
