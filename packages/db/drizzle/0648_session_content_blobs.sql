-- deployment-mode: rolling
-- Session-scoped content-addressed JSON values.
--
-- Per-attempt tool catalogs and model-request snapshots repeat almost the same
-- content on every attempt of a long session. New writers store each distinct
-- value once per session here and keep only digests in the owning row
-- (`content_refs`). A NULL `content_refs` is the unchanged legacy inline form,
-- so old readers keep working for every row they can still see; new readers
-- hydrate either form. Values are owned by their session and are removed with
-- it; nothing is shared across sessions or workspaces.
SET LOCAL lock_timeout = '5s';

CREATE TABLE "session_content_blobs" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "digest" text NOT NULL,
  "value" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "session_content_blobs_pkey" PRIMARY KEY ("workspace_id", "session_id", "digest"),
  CONSTRAINT "session_content_blobs_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "session_content_blobs_session_fk"
    FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE CASCADE,
  CONSTRAINT "session_content_blobs_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id") REFERENCES "workspaces" ("id", "account_id")
    ON DELETE CASCADE
);

CREATE INDEX "session_content_blobs_session_idx"
  ON "session_content_blobs" ("session_id");

ALTER TABLE "session_content_blobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_content_blobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON "session_content_blobs"
  USING (opengeni_private.workspace_rls_visible("account_id", "workspace_id"))
  WITH CHECK (opengeni_private.workspace_rls_visible("account_id", "workspace_id"));
CREATE POLICY session_visibility_isolation ON "session_content_blobs" AS RESTRICTIVE
  FOR ALL
  USING (session_reference_visible("account_id", "workspace_id", "session_id"))
  WITH CHECK (session_reference_visible("account_id", "workspace_id", "session_id"));

ALTER TABLE "session_attempt_tool_catalogs" ADD COLUMN "content_refs" jsonb;
ALTER TABLE "session_attempt_tool_catalogs"
  ADD CONSTRAINT "session_attempt_tool_catalogs_content_refs_check" CHECK (
    "content_refs" IS NULL OR (
      jsonb_typeof("content_refs") = 'object'
      AND ("content_refs"->>'v')::integer = 1
      AND jsonb_typeof("content_refs"->'entries') = 'array'
      AND jsonb_array_length("catalog"->'entries') = 0
    )
  ) NOT VALID;

ALTER TABLE "session_attempt_model_context_snapshots" ADD COLUMN "content_refs" jsonb;
ALTER TABLE "session_attempt_model_context_snapshots"
  ADD CONSTRAINT "session_attempt_model_context_snapshots_content_refs_check" CHECK (
    "content_refs" IS NULL OR (
      jsonb_typeof("content_refs") = 'object'
      AND ("content_refs"->>'v')::integer = 1
    )
  ) NOT VALID;

DO $grants$
DECLARE target_schema text := current_schema();
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.session_content_blobs FROM opengeni_app', target_schema);
    EXECUTE format(
      'GRANT SELECT, INSERT ON TABLE %I.session_content_blobs TO opengeni_app',
      target_schema
    );
  END IF;
END
$grants$;

-- Legacy compaction. The global maintenance worker cannot enumerate FORCE-RLS
-- workspaces, so discovery is this narrow SECURITY DEFINER seam returning only
-- routing ids (no content). Rewriting a legacy row is a second definer routine
-- that changes only the representation: under a row lock it proves that the
-- referenced blobs, already written by the caller under its workspace scope,
-- rebuild exactly the stored inline content before replacing it. Any mismatch
-- (missing blob, different value, unexpected stripped form) leaves the row
-- untouched and returns false.
CREATE FUNCTION opengeni_private.session_content_compaction_candidates(
  p_kind text,
  p_after_attempt_id uuid,
  p_limit integer
)
RETURNS TABLE (attempt_id uuid, account_id uuid, workspace_id uuid, session_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
-- EMBED-SAFE: data tables live in the caller-selected schema, matching the
-- existing global-reaper convention; opengeni_private is absolute.
AS $$
BEGIN
  IF p_kind = 'tool_catalog' THEN
    RETURN QUERY
      SELECT C.attempt_id, C.account_id, C.workspace_id, C.session_id
      FROM session_attempt_tool_catalogs C
      WHERE C.content_refs IS NULL
        AND (p_after_attempt_id IS NULL OR C.attempt_id > p_after_attempt_id)
      ORDER BY C.attempt_id
      LIMIT least(greatest(p_limit, 0), 1000);
  ELSIF p_kind = 'model_context_snapshot' THEN
    RETURN QUERY
      SELECT S.attempt_id, S.account_id, S.workspace_id, S.session_id
      FROM session_attempt_model_context_snapshots S
      WHERE S.content_refs IS NULL
        AND (p_after_attempt_id IS NULL OR S.attempt_id > p_after_attempt_id)
      ORDER BY S.attempt_id
      LIMIT least(greatest(p_limit, 0), 1000);
  ELSE
    RAISE EXCEPTION 'unknown session content kind' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE FUNCTION opengeni_private.compact_session_content_row(
  p_kind text,
  p_workspace_id uuid,
  p_attempt_id uuid,
  p_stored jsonb,
  p_refs jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  row_account uuid;
  row_session uuid;
  original jsonb;
  expected jsonb;
  rebuilt jsonb;
  rebuilt_text text;
  chunks_complete boolean;
BEGIN
  IF p_refs IS NULL OR jsonb_typeof(p_refs) <> 'object' OR (p_refs->>'v')::integer <> 1 THEN
    RETURN false;
  END IF;
  IF p_kind = 'tool_catalog' THEN
    SELECT C.account_id, C.session_id, C.catalog INTO row_account, row_session, original
    FROM session_attempt_tool_catalogs C
    WHERE C.workspace_id = p_workspace_id AND C.attempt_id = p_attempt_id
      AND C.content_refs IS NULL
    FOR UPDATE;
    IF NOT FOUND OR jsonb_typeof(p_refs->'entries') <> 'array' THEN
      RETURN false;
    END IF;
    expected := jsonb_set(original, '{entries}', '[]'::jsonb);
    IF p_stored IS DISTINCT FROM expected THEN
      RETURN false;
    END IF;
    SELECT coalesce(jsonb_agg(B.value ORDER BY E.ordinality), '[]'::jsonb) INTO rebuilt
    FROM jsonb_array_elements_text(p_refs->'entries') WITH ORDINALITY AS E(digest, ordinality)
    JOIN session_content_blobs B
      ON B.workspace_id = p_workspace_id AND B.session_id = row_session
      AND B.account_id = row_account AND B.digest = E.digest;
    IF rebuilt IS DISTINCT FROM original->'entries' THEN
      RETURN false;
    END IF;
    UPDATE session_attempt_tool_catalogs
    SET catalog = p_stored, content_refs = p_refs
    WHERE workspace_id = p_workspace_id AND attempt_id = p_attempt_id;
    RETURN true;
  ELSIF p_kind = 'model_context_snapshot' THEN
    SELECT S.account_id, S.session_id, S.snapshot INTO row_account, row_session, original
    FROM session_attempt_model_context_snapshots S
    WHERE S.workspace_id = p_workspace_id AND S.attempt_id = p_attempt_id
      AND S.content_refs IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    expected := original
      || jsonb_build_object('instructions', '', 'layers', '[]'::jsonb, 'tools', '[]'::jsonb,
        'skills', '[]'::jsonb);
    IF jsonb_typeof(p_refs->'body') = 'array' THEN
      IF jsonb_typeof(original #> '{providerRequest,body}') IS DISTINCT FROM 'string' THEN
        RETURN false;
      END IF;
      expected := jsonb_set(expected, '{providerRequest,body}', 'null'::jsonb);
      SELECT string_agg(B.value #>> '{}', '' ORDER BY E.ordinality),
        count(*) FILTER (WHERE jsonb_typeof(B.value) = 'string')
          = jsonb_array_length(p_refs->'body')
      INTO rebuilt_text, chunks_complete
      FROM jsonb_array_elements_text(p_refs->'body') WITH ORDINALITY AS E(digest, ordinality)
      JOIN session_content_blobs B
        ON B.workspace_id = p_workspace_id AND B.session_id = row_session
        AND B.account_id = row_account AND B.digest = E.digest;
      IF chunks_complete IS NOT TRUE
        OR coalesce(rebuilt_text, '') IS DISTINCT FROM original #>> '{providerRequest,body}' THEN
        RETURN false;
      END IF;
    ELSIF p_refs->'body' IS DISTINCT FROM 'null'::jsonb THEN
      RETURN false;
    END IF;
    IF p_stored IS DISTINCT FROM expected THEN
      RETURN false;
    END IF;
    IF (SELECT count(*) FROM (VALUES ('instructions'), ('layers'), ('tools'), ('skills')) AS K(name)
        JOIN session_content_blobs B
          ON B.workspace_id = p_workspace_id AND B.session_id = row_session
          AND B.account_id = row_account AND B.digest = p_refs->>K.name
          AND B.value = original->K.name) <> 4 THEN
      RETURN false;
    END IF;
    UPDATE session_attempt_model_context_snapshots
    SET snapshot = p_stored, content_refs = p_refs
    WHERE workspace_id = p_workspace_id AND attempt_id = p_attempt_id;
    RETURN true;
  END IF;
  RAISE EXCEPTION 'unknown session content kind' USING ERRCODE = '22023';
END;
$$;

REVOKE ALL ON FUNCTION opengeni_private.session_content_compaction_candidates(text, uuid, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.compact_session_content_row(text, uuid, uuid, jsonb, jsonb)
  FROM PUBLIC;
DO $compaction_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.session_content_compaction_candidates(text, uuid, integer),
      opengeni_private.compact_session_content_row(text, uuid, uuid, jsonb, jsonb)
      TO opengeni_app;
  END IF;
END
$compaction_grants$;
