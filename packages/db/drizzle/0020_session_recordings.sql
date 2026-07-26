-- Session recordings — the durable index for the "agent films itself proving
-- the fix" loop (P4.3; design-of-record 08-implementation-plan.md P4.3 +
-- modules/05-computer-use.md §3.5).
--
-- One row per recording: an ffmpeg x11grab of the SAME :0 framebuffer humans
-- watch (Channel B), captured while the box is held warm, finalized by reading
-- the bytes off the box and PUTting them to @opengeni/storage IN THE SAME
-- process that holds the resumed-by-id handle (the turn activity for an on-turn
-- recording; the API in-process for an off-turn finalize) — the bytes are NEVER
-- a Temporal payload (F10). The signed-URL replay route reads `storage_key`.
--
-- The acknowledgment / un-redacted-pixel consent (P3.2) gates whether a viewer
-- may watch the LIVE desktop; a recording artifact is gated by sessions:read on
-- the per-fetch signed-URL route (the row carries no long-lived URL). Recordings
-- are un-redacted (the framebuffer may show creds on screen), so recordingEnabled
-- is an opt-in per deployment and the artifact inherits workspace RLS.
--
-- DDL is INERT until the worker/API wire it (flag sandboxDesktopEnabled); this
-- migration only creates the table, indexes, RLS, and grants. Forward-only,
-- behavior-preserving: no existing row references it.

-- ============== session_recordings (one row per recording) ===================
CREATE TABLE IF NOT EXISTS "session_recordings" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"        uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"      uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,
  "session_id"        uuid NOT NULL REFERENCES "sessions"("id")         ON DELETE CASCADE,
  -- The turn that started the recording (on-turn / on-verify modes). NULL for a
  -- manual recording with no originating turn. ON DELETE SET NULL: a deleted
  -- turn must not cascade-kill the recording artifact row.
  "turn_id"           uuid REFERENCES "session_turns"("id") ON DELETE SET NULL,

  -- recording | finalizing | available | failed (the §3.1 state machine).
  "state"             text NOT NULL,
  -- manual | on-turn | on-verify (who started it).
  "mode"              text NOT NULL,
  -- h264-mp4 | vp9-webm (the container/codec).
  "codec"             text NOT NULL,

  -- The @opengeni/storage object key (NULL until finalize commits `available`).
  "storage_key"       text,
  "size_bytes"        bigint,
  "duration_seconds"  double precision,

  -- The framebuffer geometry the recording was captured at (must match the live
  -- Xvfb geometry — the §7 config coupling).
  "width"             integer NOT NULL,
  "height"            integer NOT NULL,

  -- The verification rationale (on-verify "reason") OR the failure reason/detail.
  -- Agent-authored free text — capped + scrubbed by the producer before storage.
  "reason"            text,

  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "finalized_at"      timestamptz,

  CONSTRAINT "session_recordings_state_chk" CHECK ("state" IN ('recording','finalizing','available','failed')),
  CONSTRAINT "session_recordings_mode_chk"  CHECK ("mode"  IN ('manual','on-turn','on-verify')),
  CONSTRAINT "session_recordings_codec_chk" CHECK ("codec" IN ('h264-mp4','vp9-webm'))
);

-- List a session's recordings newest-first without scanning the event spine.
CREATE INDEX IF NOT EXISTS "session_recordings_session_idx"
  ON "session_recordings" ("workspace_id", "session_id", "created_at" DESC);

-- ============== RLS + grants (verbatim 0017/0019 boilerplate) ================
ALTER TABLE "session_recordings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_recordings" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'session_recordings' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_recordings";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_recordings"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "session_recordings" TO opengeni_app;
  END IF;
END $$;
