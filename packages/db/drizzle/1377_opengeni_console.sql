-- deployment-mode: rolling
-- online-safety-exception: unbatched-data: copies each organization's external identity labels once, a few rows per product end user, in per-organization statements
-- Opengeni Console (expand). Organizations that embed Opengeni review the
-- sessions their product's end users have in the workspaces the product
-- manages, see cost, and audit who read what.
--
--   1. organization_managed_workspaces: a shared workspace the product
--      manages. The API marks a workspace when an organization API key creates
--      it; an owner or admin can mark or unmark one in Console. Backfilled
--      below from creation provenance: an API-key owner membership, a
--      key-created lifecycle event, or an external identity set by the SDK.
--      Personal workspaces are never marked.
--   2. organization_session_review_settings: what owners and admins may see in
--      managed workspaces: full transcripts (no row, the default), metadata
--      only, or nothing.
--   3. organization_console_audit_events: append-only log of transcript and
--      metadata reads and setting changes. The runtime may only insert and
--      read it.
--   4. organization_end_user_labels: the product's own id for each external
--      user subject (`external_user:<identity>`), so Console can show who a
--      session belongs to without the runtime reading external_identities.
--      Recorded by the API when it resolves an external actor; backfilled
--      below. A label, never authority.
--   5. feedback_submissions.console_review_read: ratings and comments are
--      readable only by their author today. Console reads the ratings of the
--      sessions it shows inside its own read-only review scope, marked by
--      `opengeni.console_review`, still bounded by workspace tenancy and the
--      restrictive session visibility policy. SELECT only.
--
-- None of these rows widen database visibility: session reads stay under the
-- ordinary tenancy RLS and the API filters which sessions Console may show.
--
-- Rolling: four new tables the previous release never reads or writes, and a
-- permissive read policy that only a scope the previous release never sets
-- can satisfy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE organization_managed_workspaces (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid PRIMARY KEY,
  source text NOT NULL,
  created_by_api_key_id uuid,
  marked_by_subject_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_managed_workspaces_source_check
    CHECK (source IN ('api_key', 'backfill', 'console')),
  CONSTRAINT organization_managed_workspaces_subject_check
    CHECK (marked_by_subject_id IS NULL OR length(marked_by_subject_id) BETWEEN 1 AND 512),
  CONSTRAINT organization_managed_workspaces_workspace_account_fkey
    FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX organization_managed_workspaces_account_idx
  ON organization_managed_workspaces (account_id, workspace_id);
CREATE INDEX organization_managed_workspaces_key_idx
  ON organization_managed_workspaces (account_id, created_by_api_key_id)
  WHERE created_by_api_key_id IS NOT NULL;
COMMENT ON TABLE organization_managed_workspaces IS 'Shared workspaces an embedding product manages; Console reviews end-user sessions only here.';

CREATE TABLE organization_session_review_settings (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  review_level text NOT NULL,
  updated_by_subject_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_session_review_settings_level_check
    CHECK (review_level IN ('full', 'metadata', 'off')),
  CONSTRAINT organization_session_review_settings_subject_check
    CHECK (length(updated_by_subject_id) BETWEEN 1 AND 512)
);
COMMENT ON TABLE organization_session_review_settings IS 'What organization owners and admins may see of end-user sessions in managed workspaces. No row means full.';

CREATE TABLE organization_console_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  actor_subject_id text NOT NULL,
  actor_label text,
  action text NOT NULL,
  workspace_id uuid,
  session_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organization_console_audit_events_action_check
    CHECK (action IN ('session.transcript_viewed', 'session.metadata_viewed',
      'settings.review_level_changed', 'workspace.kind_changed')),
  CONSTRAINT organization_console_audit_events_bounds_check
    CHECK (length(actor_subject_id) BETWEEN 1 AND 512
      AND (actor_label IS NULL OR length(actor_label) <= 512)
      AND jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 8192)
);
CREATE INDEX organization_console_audit_events_account_idx
  ON organization_console_audit_events (account_id, created_at DESC, id DESC);
CREATE INDEX organization_console_audit_events_session_idx
  ON organization_console_audit_events (account_id, session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
COMMENT ON TABLE organization_console_audit_events IS 'Append-only Console audit log: transcript reads and review setting changes.';

CREATE TABLE organization_end_user_labels (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  subject_id text NOT NULL,
  source text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, subject_id),
  CONSTRAINT organization_end_user_labels_bounds_check
    CHECK (subject_id LIKE 'external_user:%' AND length(subject_id) <= 512
      AND length(source) BETWEEN 1 AND 200 AND length(external_id) BETWEEN 1 AND 1024)
);
COMMENT ON TABLE organization_end_user_labels IS 'The embedding product''s own id for an external user subject; display only, never authority.';

ALTER TABLE organization_managed_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_managed_workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_session_review_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_session_review_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_console_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_console_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_end_user_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_end_user_labels FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE organization_managed_workspaces FROM PUBLIC;
REVOKE ALL ON TABLE organization_session_review_settings FROM PUBLIC;
REVOKE ALL ON TABLE organization_console_audit_events FROM PUBLIC;
REVOKE ALL ON TABLE organization_end_user_labels FROM PUBLIC;
-- Account scope: an account-only context reads every row of the organization;
-- a workspace context reads its own workspace's marker.
CREATE POLICY account_isolation ON organization_managed_workspaces
  USING (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id))
  WITH CHECK (opengeni_private.optional_workspace_rls_visible(account_id, workspace_id));
CREATE POLICY account_isolation ON organization_session_review_settings
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
CREATE POLICY account_isolation ON organization_console_audit_events
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));
CREATE POLICY account_isolation ON organization_end_user_labels
  USING (opengeni_private.account_rls_visible(account_id))
  WITH CHECK (opengeni_private.account_rls_visible(account_id));

DO $opengeni_console_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_managed_workspaces TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON organization_session_review_settings TO opengeni_app;
    GRANT SELECT, INSERT ON organization_console_audit_events TO opengeni_app;
    GRANT SELECT, INSERT ON organization_end_user_labels TO opengeni_app;
  END IF;
END
$opengeni_console_grants$;

-- Backfill. Every table here is FORCE RLS, so the loop scopes itself to each
-- organization (and workspace) the way the runtime does.
DO $opengeni_console_backfill$
DECLARE
  account_row record;
  candidate_ids uuid[];
  candidate_sources text[];
  candidate_index integer;
  workspace_row_id uuid;
  workspace_row_source text;
  key_id uuid;
  organization_workspace_ids uuid[];
  previous_account text := current_setting('opengeni.account_id', true);
  previous_workspace text := current_setting('opengeni.workspace_id', true);
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  FOR account_row IN SELECT id FROM managed_accounts LOOP
    PERFORM set_config('opengeni.account_id', account_row.id::text, true);
    PERFORM set_config('opengeni.workspace_id', '', true);
    SELECT coalesce(array_agg(inventory.workspace_id), '{}') INTO organization_workspace_ids
      FROM list_organization_workspace_ids(account_row.id) inventory;
    -- Collected up front: the loop below changes the workspace scope, so it
    -- must not read from a cursor whose rows depend on that scope.
    SELECT coalesce(array_agg(w.id ORDER BY w.id), '{}'),
        coalesce(array_agg(w.external_source ORDER BY w.id), '{}')
      INTO candidate_ids, candidate_sources
      FROM workspaces w
      WHERE w.account_id = account_row.id
        AND w.external_source IS DISTINCT FROM 'opengeni:organization-membership'
        AND coalesce(w.external_source, '') NOT LIKE 'better-auth:%'
        -- Shared workspaces only: never a member's personal workspace.
        AND w.id = ANY (organization_workspace_ids);
    FOR candidate_index IN 1 .. coalesce(array_length(candidate_ids, 1), 0) LOOP
      workspace_row_id := candidate_ids[candidate_index];
      workspace_row_source := candidate_sources[candidate_index];
      PERFORM set_config('opengeni.workspace_id', workspace_row_id::text, true);
      SELECT substring(membership.subject_id FROM 9)::uuid INTO key_id
        FROM workspace_memberships membership
        WHERE membership.account_id = account_row.id
          AND membership.workspace_id = workspace_row_id
          AND membership.role = 'owner'
          AND membership.subject_id ~ '^api_key:[0-9a-f-]{36}$'
        ORDER BY membership.created_at
        LIMIT 1;
      IF key_id IS NULL THEN
        PERFORM set_config('opengeni.organization_tenancy_lifecycle',
          'organization_membership_lifecycle', true);
        SELECT substring(event.actor_service_subject FROM 9)::uuid INTO key_id
          FROM organization_workspace_lifecycle_events event
          WHERE event.account_id = account_row.id
            AND event.workspace_id = workspace_row_id
            AND event.kind = 'create'
            AND event.actor_service_subject IS NOT NULL
          ORDER BY event.created_at
          LIMIT 1;
        PERFORM set_config('opengeni.organization_tenancy_lifecycle',
          coalesce(previous_marker, ''), true);
      END IF;
      -- Opengeni's own sources (`opengeni:additional-organization-default`,
      -- `opengeni:local`, `opengeni:configured`) are team workspaces unless a
      -- key created them.
      IF key_id IS NOT NULL OR (workspace_row_source IS NOT NULL
        AND workspace_row_source NOT LIKE 'opengeni:%') THEN
        INSERT INTO organization_managed_workspaces
          (account_id, workspace_id, source, created_by_api_key_id)
        VALUES (account_row.id, workspace_row_id, 'backfill', key_id)
        ON CONFLICT (workspace_id) DO NOTHING;
      END IF;
      key_id := NULL;
    END LOOP;
    PERFORM set_config('opengeni.workspace_id', '', true);
    PERFORM set_config('opengeni.organization_tenancy_lifecycle',
      'external_identity_provisioning', true);
    INSERT INTO organization_end_user_labels (account_id, subject_id, source, external_id, created_at)
      SELECT identity.account_id, identity.subject_id, identity.source, identity.external_id,
        identity.created_at
      FROM external_identities identity
      WHERE identity.account_id = account_row.id
        AND identity.subject_id LIKE 'external_user:%'
      ON CONFLICT (account_id, subject_id) DO NOTHING;
    PERFORM set_config('opengeni.organization_tenancy_lifecycle',
      coalesce(previous_marker, ''), true);
  END LOOP;
  PERFORM set_config('opengeni.account_id', coalesce(previous_account, ''), true);
  PERFORM set_config('opengeni.workspace_id', coalesce(previous_workspace, ''), true);
END
$opengeni_console_backfill$;

-- Last, so the ACCESS EXCLUSIVE lock on feedback_submissions is not held
-- through the backfill.
CREATE POLICY console_review_read ON feedback_submissions FOR SELECT
  USING (opengeni_private.workspace_rls_visible(account_id, workspace_id)
    AND current_setting('opengeni.console_review', true) = 'on');
