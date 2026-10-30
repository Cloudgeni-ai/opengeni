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
