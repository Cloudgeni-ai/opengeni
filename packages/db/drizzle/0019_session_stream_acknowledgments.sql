-- The un-redacted-pixel consent gate (P3.2; design-of-record
-- 08-implementation-plan.md P3.2 + modules/07-channel-b.md §1.1/§6 +
-- 05-addendum-shared-sandboxes.md E.1).
--
-- A row here records that a PRINCIPAL (subject) explicitly acknowledged the
-- un-redacted desktop pixel plane for a (workspace, group, subject) — and, when
-- the box is shared with sibling sessions, that they also consented to the
-- SHARED-EXPOSURE disclosure (watching A's desktop also shows B's agent on the
-- one framebuffer; the pixels cannot be redacted, so consent — not authz — is
-- the gate, addendum E.1 / stress g).
--
-- The acknowledgment is keyed on the GROUP, not the session: the un-redacted
-- surface is the BOX's :0 framebuffer (one per group), so acknowledging it once
-- for a group covers every conversation in that group. The shared bit is
-- recorded so a later transition from solo→shared can re-require consent if the
-- product wants it (today the negotiation reports `shared` from the live group
-- session-set and the gate keys on the recorded `acknowledged_shared`).
--
-- Reuses the acknowledgment machinery from P3.1 — NO new permission beyond
-- stream:acknowledge (the principal must hold stream:acknowledge to write a row,
-- and stream:view to use the desktop path the row gates).
--
-- DDL is INERT until the routes wire it (flag sandboxOwnershipEnabled); this
-- migration only creates the table, indexes, RLS, and grants. Forward-only,
-- behavior-preserving: no existing row references it.

-- ============== session_stream_acknowledgments (one row per consent) =========
-- The natural key is (workspace_id, sandbox_group_id, subject_id): a principal's
-- consent to the group's un-redacted pixel plane. acknowledged_shared records
-- whether the shared-exposure disclosure was also consented (the gate returns
-- 409 shared_acknowledgment_required until this is true for a shared box).
CREATE TABLE IF NOT EXISTS "session_stream_acknowledgments" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id"          uuid NOT NULL REFERENCES "managed_accounts"("id") ON DELETE CASCADE,
  "workspace_id"        uuid NOT NULL REFERENCES "workspaces"("id")       ON DELETE CASCADE,

  -- The GROUP whose un-redacted :0 framebuffer this consent covers. A bare uuid
  -- (NOT an FK), matching sandbox_leases.sandbox_group_id: the value is a session
  -- id or an ancestor's id in the same workspace; the lease row, not a
  -- sandbox_groups table, materializes the group (addendum B.1).
  "sandbox_group_id"    uuid NOT NULL,

  -- The acknowledging PRINCIPAL (the access-grant subjectId). Consent is
  -- per-principal: A acknowledging does not consent on B's behalf.
  "subject_id"          text NOT NULL,

  -- Always true when a row exists (the un-redacted pixel plane was acknowledged);
  -- carried explicitly so the column self-documents and a future "withdraw"
  -- toggles it without deleting attribution.
  "acknowledged_unredacted" boolean NOT NULL DEFAULT true,

  -- Whether the SHARED-EXPOSURE disclosure was also consented (addendum E.1).
  -- The gate returns 409 shared_acknowledgment_required for a shared box until
  -- this is true; for a solo box it is irrelevant (the un-redacted ack suffices).
  "acknowledged_shared" boolean NOT NULL DEFAULT false,

  "acknowledged_at"     timestamptz NOT NULL DEFAULT now(),
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

-- One consent row per (workspace, group, subject). Re-acknowledging (e.g. a
-- solo→shared upgrade flipping acknowledged_shared) is an ON CONFLICT DO UPDATE,
-- never a duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS "session_stream_ack_subject_idx"
  ON "session_stream_acknowledgments" ("workspace_id", "sandbox_group_id", "subject_id");

-- Lookup-by-group (enumerate who has consented to a group's pixel plane).
CREATE INDEX IF NOT EXISTS "session_stream_ack_group_idx"
  ON "session_stream_acknowledgments" ("workspace_id", "sandbox_group_id");

-- ============== RLS + grants (verbatim 0017 boilerplate) =====================
ALTER TABLE "session_stream_acknowledgments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "session_stream_acknowledgments" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'session_stream_acknowledgments' AND policyname = 'workspace_isolation'
  ) THEN
    DROP POLICY workspace_isolation ON "session_stream_acknowledgments";
  END IF;
END $$;
CREATE POLICY workspace_isolation ON "session_stream_acknowledgments"
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.workspace_rls_visible(account_id, workspace_id));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "session_stream_acknowledgments" TO opengeni_app;
  END IF;
END $$;
