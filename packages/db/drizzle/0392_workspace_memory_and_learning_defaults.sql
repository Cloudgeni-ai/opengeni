-- deployment-mode: rolling
-- Migration 0392: enable Workspace Memory by default and make approval-required
-- workspace instruction/Skill learning the default when no policy revision has
-- been activated.
--
-- Explicit memory opt-outs and activated learning-policy revisions remain
-- authoritative. Existing immutable turn and learning snapshots are untouched.
-- Materializing the Memory default in workspace settings keeps old and new
-- rolling binaries aligned while the application resolver changes omission to
-- enabled.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE "workspaces"
  ALTER COLUMN "settings" SET DEFAULT '{"memoryEnabled": true}'::jsonb;

UPDATE "workspaces"
SET "settings" = jsonb_set("settings", '{memoryEnabled}', 'true'::jsonb, true)
WHERE NOT ("settings" ? 'memoryEnabled');

-- Historical no-revision snapshots were frozen with workspace_mode = 'off'.
-- Keep those rows valid while allowing newly accepted attempts to freeze the
-- approval-required default below.
ALTER TABLE "workspace_learning_policy_snapshots"
  DROP CONSTRAINT "workspace_learning_policy_snapshots_identity_chk";

ALTER TABLE "workspace_learning_policy_snapshots"
  ADD CONSTRAINT "workspace_learning_policy_snapshots_identity_chk" CHECK (
    (
      "revision_id" IS NULL
      AND "revision" IS NULL
      AND "policy_hash" IS NULL
      AND "activation_version" = 0
      AND "activated_at" IS NULL
      AND "workspace_mode" IN ('off', 'suggest')
      AND "source_overrides" = '[]'::jsonb
    )
    OR (
      "revision_id" IS NOT NULL
      AND "revision" > 0
      AND "policy_hash" ~ '^[0-9a-f]{64}$'
      AND "activation_version" > 0
      AND "activated_at" IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE "workspace_learning_policy_snapshots"
  VALIDATE CONSTRAINT "workspace_learning_policy_snapshots_identity_chk";

CREATE OR REPLACE FUNCTION workspace_learning_policy_canonical_at(
  p_account_id uuid,
  p_workspace_id uuid,
  p_accepted_at timestamptz
) RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN active."id" IS NULL THEN
    jsonb_build_object(
      'revisionId', NULL,
      'revision', NULL,
      'policyHash', NULL,
      'activationVersion', 0,
      'activatedAt', NULL,
      'workspaceMode', 'suggest',
      'sourceOverrides', '[]'::jsonb
    )
  ELSE
    jsonb_build_object(
      'revisionId', revision."id"::text,
      'revision', revision."revision",
      'policyHash', revision."policy_hash",
      'activationVersion', active."activation_version",
      'activatedAt', to_char(
        active."created_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'workspaceMode', revision."workspace_mode",
      'sourceOverrides', revision."source_overrides"
    )
  END
  FROM (SELECT 1) singleton
  LEFT JOIN LATERAL (
    SELECT event.*
    FROM "workspace_learning_policy_activation_events" event
    WHERE event."account_id" = p_account_id
      AND event."workspace_id" = p_workspace_id
      AND event."created_at" <= p_accepted_at
    ORDER BY event."created_at" DESC, event."activation_version" DESC, event."id" DESC
    LIMIT 1
  ) active ON true
  LEFT JOIN "workspace_learning_policy_revisions" revision
    ON revision."account_id" = active."account_id"
    AND revision."workspace_id" = active."workspace_id"
    AND revision."id" = active."new_revision_id"
    AND revision."revision" = active."new_revision"
    AND revision."policy_hash" = active."new_policy_hash";
$$;

REVOKE ALL ON FUNCTION workspace_learning_policy_canonical_at(uuid, uuid, timestamptz)
  FROM PUBLIC;