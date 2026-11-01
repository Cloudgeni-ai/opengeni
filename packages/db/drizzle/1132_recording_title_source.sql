-- deployment-mode: rolling
-- Meetings name themselves (docs/recordings.md, "Names"). A recording now
-- remembers where its title came from: a person, the owner's calendar event,
-- the conversation (written with its notes), a guess by the recording app, or
-- none (the default, when it started). A better source may replace a title
-- from a weaker one; a person's title is never replaced.
-- Existing rows and a previous binary's inserts get 'person', which is what
-- every title meant until now, so nothing renames them. The constant default
-- makes the column a catalog-only change, and as every row holds that
-- default the check is added NOT VALID without scanning the table.
SET LOCAL lock_timeout = '5s';

ALTER TABLE recordings ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'person';
ALTER TABLE recordings ADD CONSTRAINT recordings_title_source_chk
  CHECK (title_source IN ('person', 'calendar', 'conversation', 'app', 'default'))
  NOT VALID;

-- A title that changes while its source doesn't is a person's. This
-- release's renames and automatic names always set both, but a previous
-- binary still serving during the rollout renames without the source, and a
-- name it took from someone must not be replaced by an automatic one.
CREATE OR REPLACE FUNCTION opengeni_private.recording_title_source_person_v1()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $body$
BEGIN
  NEW.title_source := 'person';
  RETURN NEW;
END $body$;
REVOKE ALL ON FUNCTION opengeni_private.recording_title_source_person_v1() FROM PUBLIC;

DROP TRIGGER IF EXISTS recordings_title_source_person_v1 ON recordings;
CREATE TRIGGER recordings_title_source_person_v1
  BEFORE UPDATE OF title ON recordings
  FOR EACH ROW WHEN (
    NEW.title IS DISTINCT FROM OLD.title
    AND NEW.title_source IS NOT DISTINCT FROM OLD.title_source
  )
  EXECUTE FUNCTION opengeni_private.recording_title_source_person_v1();
