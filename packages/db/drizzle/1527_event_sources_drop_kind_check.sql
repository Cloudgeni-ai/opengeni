-- deployment-mode: rolling
-- Drop the old kind check; 1525's validated check keeps every other kind.
SET LOCAL lock_timeout = '5s';

ALTER TABLE event_sources DROP CONSTRAINT IF EXISTS event_sources_kind_check;
