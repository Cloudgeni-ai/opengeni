-- deployment-mode: rolling
-- Every model-usage append first looks up earlier usage events of the same
-- turn by provider source key, to record replays as duplicates. The only
-- index on that key is an expression index over payload ->> 'sourceKey'.
-- Under row-level security PostgreSQL cannot use it: ->> is not leakproof, so
-- the key filter runs after the per-row visibility checks, and each append
-- reads every earlier usage event of its turn (quadratic in turn length).
--
-- usage_source_key holds the same key as a plain column, which an ordinary
-- index can serve under row-level security. A BEFORE INSERT trigger fills it
-- from the payload, so every writer (including binaries still running during
-- a rolling deploy) populates it identically. 0811 backfills usage events of
-- turns that can still receive appends in small batches (finished turns never
-- append again and keep NULL), and 0812 builds the index concurrently. This
-- file only takes the brief catalog locks, so it commits immediately.
SET LOCAL lock_timeout = '5s';

ALTER TABLE session_events ADD COLUMN usage_source_key text;

CREATE FUNCTION session_events_fill_usage_source_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fill_usage_source_key$
BEGIN
  NEW.usage_source_key := NULLIF(NEW.payload ->> 'sourceKey', '');
  RETURN NEW;
END
$fill_usage_source_key$;
REVOKE ALL ON FUNCTION session_events_fill_usage_source_key() FROM PUBLIC;

CREATE TRIGGER session_events_fill_usage_source_key
  BEFORE INSERT ON session_events
  FOR EACH ROW
  WHEN (NEW.type = 'agent.model.usage')
  EXECUTE FUNCTION session_events_fill_usage_source_key();
