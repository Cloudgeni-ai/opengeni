-- deployment-mode: rolling
-- Validate 1533's check. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and
-- writes continue while it scans; every existing row satisfies it, as the old
-- check is stricter.
SET LOCAL lock_timeout = '5s';

ALTER TABLE event_sources VALIDATE CONSTRAINT event_sources_kind_v2_check;
