-- deployment-mode: rolling

CREATE TABLE "transcription_recordings" (
  "id" uuid PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "mime_type" text NOT NULL,
  "state" text NOT NULL DEFAULT 'uploading',
  "next_chunk_number" integer NOT NULL DEFAULT 0,
  "chunk_count" integer NOT NULL DEFAULT 0,
  "total_bytes" integer NOT NULL DEFAULT 0,
  "total_duration_milliseconds" integer NOT NULL DEFAULT 0,
  "segment_count" integer NOT NULL DEFAULT 0,
  "completed_segment_count" integer NOT NULL DEFAULT 0,
  "transcript_text" text,
  "languages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "error_code" text,
  "retryable" boolean NOT NULL DEFAULT false,
  "provider_id" text,
  "processing_generation" integer NOT NULL DEFAULT 0,
  "processing_owner" uuid,
  "processing_started_at" timestamptz,
  "objects_cleaned_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "transcription_recordings_workspace_account_fk"
    FOREIGN KEY ("workspace_id", "account_id")
    REFERENCES "workspaces"("id", "account_id") ON DELETE CASCADE,
  CONSTRAINT "transcription_recordings_exact_authority_uq"
    UNIQUE ("account_id", "workspace_id", "subject_id", "id"),
  CONSTRAINT "transcription_recordings_state_check"
    CHECK ("state" IN (
      'uploading', 'segmenting', 'ready', 'transcribing', 'complete', 'failed', 'discarded'
    )),
  CONSTRAINT "transcription_recordings_values_check"
    CHECK (
      "next_chunk_number" >= 0
      AND "chunk_count" >= 0
      AND "total_bytes" >= 0
      AND "total_duration_milliseconds" >= 0
      AND "segment_count" >= 0
      AND "completed_segment_count" >= 0
      AND "completed_segment_count" <= "segment_count"
      AND octet_length("subject_id") BETWEEN 1 AND 1024
      AND octet_length("mime_type") BETWEEN 1 AND 128
      AND ("provider_id" IS NULL OR octet_length("provider_id") BETWEEN 1 AND 128)
      AND ("transcript_text" IS NULL OR octet_length("transcript_text") <= 4000000)
      AND jsonb_typeof("languages") = 'array'
    ),
  CONSTRAINT "transcription_recordings_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" IN (
      'permission_denied', 'not_supported', 'network', 'provider', 'policy_blocked',
      'timeout', 'cancelled', 'unavailable', 'too_large', 'invalid_audio', 'unknown'
    )),
  CONSTRAINT "transcription_recordings_processing_check"
    CHECK (
      ("processing_owner" IS NULL AND "processing_started_at" IS NULL)
      OR ("processing_owner" IS NOT NULL AND "processing_started_at" IS NOT NULL)
    )
);

CREATE INDEX "transcription_recordings_subject_created_idx"
  ON "transcription_recordings" ("workspace_id", "subject_id", "created_at");
CREATE INDEX "transcription_recordings_expiry_idx"
  ON "transcription_recordings" ("expires_at", "id");

CREATE TABLE "transcription_recording_objects" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "recording_id" uuid NOT NULL,
  "object_key" text PRIMARY KEY,
  "kind" text NOT NULL,
  "cleanup_after" timestamptz NOT NULL,
  "cleanup_claim_id" uuid,
  "cleanup_claimed_at" timestamptz,
  "cleaned_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "transcription_recording_objects_authority_fk"
    FOREIGN KEY ("account_id", "workspace_id", "subject_id", "recording_id")
    REFERENCES "transcription_recordings"("account_id", "workspace_id", "subject_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "transcription_recording_objects_kind_check"
    CHECK ("kind" IN ('chunk', 'segment')),
  CONSTRAINT "transcription_recording_objects_values_check"
    CHECK (
      octet_length("object_key") BETWEEN 1 AND 1024
      AND (
        ("cleanup_claim_id" IS NULL AND "cleanup_claimed_at" IS NULL)
        OR ("cleanup_claim_id" IS NOT NULL AND "cleanup_claimed_at" IS NOT NULL)
      )
      AND (
        "cleaned_at" IS NULL
        OR ("cleanup_claim_id" IS NULL AND "cleanup_claimed_at" IS NULL)
      )
    )
);

CREATE INDEX "transcription_recording_objects_due_cleanup_idx"
  ON "transcription_recording_objects" ("cleanup_after", "object_key")
  WHERE "cleaned_at" IS NULL;
CREATE INDEX "transcription_recording_objects_claim_recovery_idx"
  ON "transcription_recording_objects" ("cleanup_claimed_at", "object_key")
  WHERE "cleaned_at" IS NULL AND "cleanup_claim_id" IS NOT NULL;

CREATE TABLE "transcription_recording_chunks" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "recording_id" uuid NOT NULL,
  "chunk_number" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'uploading',
  "byte_length" integer NOT NULL,
  "sha256" text NOT NULL,
  "start_milliseconds" integer NOT NULL,
  "duration_milliseconds" integer NOT NULL,
  "object_key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "transcription_recording_chunks_pk" PRIMARY KEY ("recording_id", "chunk_number"),
  CONSTRAINT "transcription_recording_chunks_authority_fk"
    FOREIGN KEY ("account_id", "workspace_id", "subject_id", "recording_id")
    REFERENCES "transcription_recordings"("account_id", "workspace_id", "subject_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "transcription_recording_chunks_object_fk"
    FOREIGN KEY ("object_key")
    REFERENCES "transcription_recording_objects"("object_key") ON DELETE RESTRICT,
  CONSTRAINT "transcription_recording_chunks_state_check"
    CHECK ("state" IN ('uploading', 'complete')),
  CONSTRAINT "transcription_recording_chunks_values_check"
    CHECK (
      "chunk_number" >= 0
      AND "byte_length" > 0
      AND "start_milliseconds" >= 0
      AND "duration_milliseconds" >= 0
      AND "sha256" ~ '^[0-9a-f]{64}$'
      AND octet_length("object_key") BETWEEN 1 AND 1024
      AND (
        ("state" = 'uploading' AND "completed_at" IS NULL)
        OR ("state" = 'complete' AND "completed_at" IS NOT NULL)
      )
    ),
  CONSTRAINT "transcription_recording_chunks_object_key_uq" UNIQUE ("object_key")
);

CREATE INDEX "transcription_recording_chunks_order_idx"
  ON "transcription_recording_chunks" ("workspace_id", "recording_id", "chunk_number");

CREATE TABLE "transcription_recording_segments" (
  "account_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "subject_id" text NOT NULL,
  "recording_id" uuid NOT NULL,
  "segment_number" integer NOT NULL,
  "generation" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'preparing',
  "byte_length" integer NOT NULL,
  "sha256" text NOT NULL,
  "start_milliseconds" integer NOT NULL,
  "duration_milliseconds" integer NOT NULL,
  "object_key" text NOT NULL,
  "attempt_id" uuid,
  "attempt_started_at" timestamptz,
  "transcript_text" text,
  "languages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provider_id" text,
  "error_code" text,
  "retryable" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "transcription_recording_segments_pk"
    PRIMARY KEY ("recording_id", "segment_number"),
  CONSTRAINT "transcription_recording_segments_authority_fk"
    FOREIGN KEY ("account_id", "workspace_id", "subject_id", "recording_id")
    REFERENCES "transcription_recordings"("account_id", "workspace_id", "subject_id", "id")
    ON DELETE CASCADE,
  CONSTRAINT "transcription_recording_segments_object_fk"
    FOREIGN KEY ("object_key")
    REFERENCES "transcription_recording_objects"("object_key") ON DELETE RESTRICT,
  CONSTRAINT "transcription_recording_segments_state_check"
    CHECK ("state" IN ('preparing', 'pending', 'transcribing', 'complete', 'failed')),
  CONSTRAINT "transcription_recording_segments_values_check"
    CHECK (
      "segment_number" >= 0
      AND "generation" > 0
      AND "byte_length" > 0
      AND "start_milliseconds" >= 0
      AND "duration_milliseconds" > 0
      AND "sha256" ~ '^[0-9a-f]{64}$'
      AND octet_length("object_key") BETWEEN 1 AND 1024
      AND ("transcript_text" IS NULL OR octet_length("transcript_text") <= 1000000)
      AND jsonb_typeof("languages") = 'array'
      AND (
        ("attempt_id" IS NULL AND "attempt_started_at" IS NULL)
        OR ("attempt_id" IS NOT NULL AND "attempt_started_at" IS NOT NULL)
      )
    ),
  CONSTRAINT "transcription_recording_segments_error_code_check"
    CHECK ("error_code" IS NULL OR "error_code" IN (
      'permission_denied', 'not_supported', 'network', 'provider', 'policy_blocked',
      'timeout', 'cancelled', 'unavailable', 'too_large', 'invalid_audio', 'unknown'
    )),
  CONSTRAINT "transcription_recording_segments_object_key_uq" UNIQUE ("object_key")
);

CREATE INDEX "transcription_recording_segments_order_idx"
  ON "transcription_recording_segments" ("workspace_id", "recording_id", "segment_number");

ALTER TABLE "transcription_recordings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recordings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_objects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_objects" FORCE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_chunks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_chunks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "transcription_recording_segments" FORCE ROW LEVEL SECURITY;

CREATE POLICY transcription_recordings_subject_isolation ON "transcription_recordings"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  );

CREATE POLICY transcription_recording_objects_subject_isolation
  ON "transcription_recording_objects"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  );

CREATE POLICY transcription_recording_chunks_subject_isolation
  ON "transcription_recording_chunks"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  );

-- The existing provider-neutral object reaper needs one bounded cross-workspace
-- claim seam. The function returns only exact authority ids plus opaque storage
-- keys; no transcript, audio, credential, or provider metadata crosses the RLS
-- boundary. Recording rows are locked before object rows, matching request-side
-- mutation order. Expired recordings are fenced to discarded in the same claim.
-- The migration may target public or a dedicated embedded schema, so bind
-- current_schema() into every relation at creation time and expose only
-- pg_catalog at execution time.
DO $privileged_functions$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.claim_due_transcription_recording_object_cleanup(
      p_grace_ms bigint,
      p_claim_timeout_ms bigint,
      p_limit integer
    )
    RETURNS TABLE (
      account_id uuid,
      workspace_id uuid,
      subject_id text,
      recording_id uuid,
      object_key text,
      cleanup_claim_id uuid
    )
    LANGUAGE sql
    SECURITY DEFINER
    STRICT
    SET search_path = pg_catalog
    AS $function$
      WITH due_recordings AS MATERIALIZED (
        SELECT R.id, R.account_id, R.workspace_id, R.subject_id, R.expires_at
        FROM %1$I.transcription_recordings R
        WHERE EXISTS (
          SELECT 1
          FROM %1$I.transcription_recording_objects O
          WHERE O.recording_id = R.id
            AND O.cleaned_at IS NULL
            AND O.cleanup_after <=
              clock_timestamp() - greatest(p_grace_ms, 0) * interval '1 millisecond'
            AND (
              O.cleanup_claim_id IS NULL
              OR O.cleanup_claimed_at <=
                clock_timestamp() - greatest(p_claim_timeout_ms, 0) * interval '1 millisecond'
            )
        )
        ORDER BY R.expires_at, R.id
        FOR UPDATE OF R SKIP LOCKED
        LIMIT least(greatest(p_limit, 0), 1000)
      ), expired_recordings AS (
        UPDATE %1$I.transcription_recordings R
        SET state = 'discarded',
            processing_owner = NULL,
            processing_started_at = NULL,
            error_code = NULL,
            retryable = false,
            updated_at = clock_timestamp()
        FROM due_recordings D
        WHERE R.id = D.id
          AND D.expires_at <=
            clock_timestamp() - greatest(p_grace_ms, 0) * interval '1 millisecond'
          AND R.state <> 'discarded'
        RETURNING R.id
      ), candidates AS MATERIALIZED (
        SELECT O.object_key
        FROM %1$I.transcription_recording_objects O
        JOIN due_recordings R ON R.id = O.recording_id
        WHERE O.cleaned_at IS NULL
          AND O.cleanup_after <=
            clock_timestamp() - greatest(p_grace_ms, 0) * interval '1 millisecond'
          AND (
            O.cleanup_claim_id IS NULL
            OR O.cleanup_claimed_at <=
              clock_timestamp() - greatest(p_claim_timeout_ms, 0) * interval '1 millisecond'
          )
        ORDER BY O.cleanup_after, O.object_key
        FOR UPDATE OF O SKIP LOCKED
        LIMIT least(greatest(p_limit, 0), 1000)
      ), claimed AS (
        UPDATE %1$I.transcription_recording_objects O
        SET cleanup_claim_id = gen_random_uuid(), cleanup_claimed_at = clock_timestamp()
        FROM candidates C
        WHERE O.object_key = C.object_key
        RETURNING
          O.account_id,
          O.workspace_id,
          O.subject_id,
          O.recording_id,
          O.object_key,
          O.cleanup_claim_id
      )
      SELECT
        C.account_id,
        C.workspace_id,
        C.subject_id,
        C.recording_id,
        C.object_key,
        C.cleanup_claim_id
      FROM claimed C, (SELECT count(*) FROM expired_recordings) AS fence;
    $function$;
  $ddl$, data_schema);

  -- Once every object for an expired recording has been confirmed deleted,
  -- purge the remaining manifest, chunk/segment metadata, provider pin, and
  -- transcript. Provider deletion settles one object at a time first, so
  -- metadata is never removed while an opaque object key still needs retryable
  -- cleanup.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.purge_expired_transcription_recordings(
      p_grace_ms bigint,
      p_limit integer
    )
    RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    STRICT
    SET search_path = pg_catalog
    AS $function$
    DECLARE
      v_recording_id uuid;
      v_purged integer := 0;
    BEGIN
      IF p_grace_ms < 0 OR p_limit <= 0 THEN
        RAISE EXCEPTION 'invalid transcription recording purge bounds';
      END IF;

      FOR v_recording_id IN
        SELECT R.id
        FROM %1$I.transcription_recordings R
        WHERE R.expires_at <=
            clock_timestamp() - p_grace_ms * interval '1 millisecond'
          AND NOT EXISTS (
            SELECT 1
            FROM %1$I.transcription_recording_objects O
            WHERE O.recording_id = R.id
              AND O.cleaned_at IS NULL
          )
        ORDER BY R.expires_at, R.id
        FOR UPDATE OF R SKIP LOCKED
        LIMIT least(p_limit, 1000)
      LOOP
        DELETE FROM %1$I.transcription_recording_chunks
        WHERE recording_id = v_recording_id;
        DELETE FROM %1$I.transcription_recording_segments
        WHERE recording_id = v_recording_id;
        DELETE FROM %1$I.transcription_recording_objects
        WHERE recording_id = v_recording_id;
        DELETE FROM %1$I.transcription_recordings
        WHERE id = v_recording_id;
        v_purged := v_purged + 1;
      END LOOP;

      RETURN v_purged;
    END;
    $function$;
  $ddl$, data_schema);
END
$privileged_functions$;

REVOKE ALL ON FUNCTION
  opengeni_private.claim_due_transcription_recording_object_cleanup(bigint, bigint, integer)
  FROM PUBLIC;

REVOKE ALL ON FUNCTION
  opengeni_private.purge_expired_transcription_recordings(bigint, integer)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION
      opengeni_private.claim_due_transcription_recording_object_cleanup(bigint, bigint, integer)
      TO opengeni_app;
    GRANT EXECUTE ON FUNCTION
      opengeni_private.purge_expired_transcription_recordings(bigint, integer)
      TO opengeni_app;
  END IF;
END $$;

CREATE POLICY transcription_recording_segments_subject_isolation
  ON "transcription_recording_segments"
  USING (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  )
  WITH CHECK (
    opengeni_private.workspace_rls_visible("account_id", "workspace_id")
    AND "subject_id" = nullif(current_setting('opengeni.subject_id', true), '')
  );