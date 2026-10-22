-- deployment-mode: rolling
-- Indexed full-history session message search (docs/session-message-search.md).
--
-- Search used to walk every eligible message of a workspace in key order and
-- test its text with a regular expression. Under FORCE ROW LEVEL SECURITY
-- PostgreSQL only uses an index for a qualifier that is leakproof or that is
-- itself part of the row-security policy, and no text pattern operator is
-- leakproof, so a trigram index on session_events could never serve it.
--
-- This table holds the searchable text of each user and completed assistant
-- message once, keyed like its event by (workspace, session, sequence). Its
-- row-security policies ARE the search: besides the ordinary workspace and
-- session-visibility policies, a restrictive policy admits only rows whose text matches the pattern the
-- search transaction sets in `opengeni.session_message_search_pattern` (or
-- losslessly encoded text, which only the decoding reader can test). Being
-- policy qualifiers, the workspace and pattern tests can drive the GIN index
-- (built by 0911 in one pass after 0910's backfill, with btree_gin carrying
-- the workspace equality), while authority is unchanged: rows stay workspace-
-- and session-visibility-bound, and search still joins the canonical event under
-- its own policies. Without a pattern set the table shows nothing.
--
-- Rows are written only by the AFTER INSERT trigger on session_events (and
-- the 0910 backfill), both as the schema owner; the application role can only
-- read. Session events are append-only, so a row never goes stale; deleting
-- the event deletes its row.
SET LOCAL lock_timeout = '5s';

-- Trusted extensions: a database owner with CREATE may install them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE "session_message_search_texts" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "sequence" integer NOT NULL,
  "encoded" boolean NOT NULL,
  "text" text NOT NULL,
  -- Key order is search order: a common query walks this index in order and
  -- stops after one window instead of collecting every candidate first.
  CONSTRAINT "session_message_search_texts_pkey" PRIMARY KEY ("workspace_id", "session_id", "sequence"),
  CONSTRAINT "session_message_search_texts_event_fk"
    FOREIGN KEY ("workspace_id", "session_id", "sequence")
    REFERENCES "session_events" ("workspace_id", "session_id", "sequence")
    ON DELETE CASCADE
);

-- Losslessly encoded text is always a candidate; keep finding it bounded.
CREATE INDEX "session_message_search_texts_encoded_idx"
  ON "session_message_search_texts" ("workspace_id") WHERE "encoded";

ALTER TABLE "session_message_search_texts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_message_search_texts" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_message_search_texts"
  FOR SELECT
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation ON "session_message_search_texts" AS RESTRICTIVE
  FOR SELECT
  USING (session_reference_visible("account_id", "workspace_id", "session_id"));
CREATE POLICY session_message_search_pattern ON "session_message_search_texts" AS RESTRICTIVE
  FOR SELECT
  USING (
    "encoded"
    OR "text" ~ nullif(
      pg_catalog.current_setting('opengeni.session_message_search_pattern', true),
      ''
    )
  );
-- Only the schema owner writes, through the trigger below and the backfill.
CREATE POLICY session_message_search_owner_insert ON "session_message_search_texts"
  FOR INSERT
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_message_search_texts'::regclass
    )
  );

REVOKE ALL ON TABLE "session_message_search_texts" FROM PUBLIC;
DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.session_message_search_texts FROM opengeni_app', target_schema);
    EXECUTE format('GRANT SELECT ON TABLE %I.session_message_search_texts TO opengeni_app', target_schema);
  END IF;
END
$grants$;

CREATE FUNCTION opengeni_private.index_session_message_search_text()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO session_message_search_texts
    (account_id, workspace_id, session_id, sequence, encoded, text)
  VALUES (
    NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.sequence,
    starts_with(NEW.payload->>'text', 'opengeni_lossless_json_string_v2_81f06e15:'),
    NEW.payload->>'text'
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
REVOKE ALL ON FUNCTION opengeni_private.index_session_message_search_text() FROM PUBLIC;

CREATE TRIGGER session_message_search_index
  AFTER INSERT ON "session_events"
  FOR EACH ROW
  WHEN (
    NEW.type IN ('user.message', 'agent.message.completed')
    AND NEW.session_id IS NOT NULL
    AND jsonb_typeof(NEW.payload->'text') = 'string'
  )
  EXECUTE FUNCTION opengeni_private.index_session_message_search_text();

-- Backfill progress for 0910: the last session (in workspace, id order) whose
-- existing messages were copied. Owner-only, removed by 0912.
CREATE TABLE opengeni_private.session_message_search_backfill (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  workspace_id uuid,
  session_id uuid,
  CHECK ((workspace_id IS NULL) = (session_id IS NULL))
);
REVOKE ALL ON TABLE opengeni_private.session_message_search_backfill FROM PUBLIC;
ALTER TABLE opengeni_private.session_message_search_backfill ENABLE ROW LEVEL SECURITY;
ALTER TABLE opengeni_private.session_message_search_backfill FORCE ROW LEVEL SECURITY;
CREATE POLICY session_message_search_backfill_owner ON opengeni_private.session_message_search_backfill
  FOR ALL
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'opengeni_private.session_message_search_backfill'::regclass
    )
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'opengeni_private.session_message_search_backfill'::regclass
    )
  );
INSERT INTO opengeni_private.session_message_search_backfill (singleton) VALUES (true);

-- FORCE RLS binds the non-superuser owner that runs migrations. These policy
-- arms open only an exact owner + transaction-local capability, set by the
-- migration runner for 0910's batches; an application role can set the GUC
-- but never satisfies the owner half. 0912 removes them.
CREATE POLICY sessions_message_search_backfill_v1 ON "sessions"
  FOR ALL
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'sessions'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'sessions'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  );
CREATE POLICY session_events_message_search_backfill_v1 ON "session_events"
  FOR ALL
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_events'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_events'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  );
CREATE POLICY session_message_search_texts_backfill_v1 ON "session_message_search_texts"
  FOR ALL
  USING (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_message_search_texts'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  )
  WITH CHECK (
    current_user = (
      SELECT pg_catalog.pg_get_userbyid(relation.relowner)
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'session_message_search_texts'::regclass
    )
    AND pg_catalog.current_setting('opengeni.session_message_search_backfill_v1', true) = '1'
  );
