-- deployment-mode: rolling
-- A Site has an audience, like a chat and a schedule: everyone in the
-- workspace (`workspace_shared`, the default and every existing Site's
-- behaviour) or only its owner (`user_private`). The owner is the person the
-- Site was published for and never changes; only they can change the
-- audience. An Only me Site needs an owner.
--
-- Every existing Site stays visible to the workspace. Its owner is backfilled
-- so that person can later limit it to themselves: the person whose chat turn
-- published its first version, or the member who published it directly.
-- Sites with neither keep no owner and stay workspace-wide. Old releases never
-- read the columns; their inserts get the shared default and no owner.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE workspace_artifacts
  ADD COLUMN visibility text NOT NULL DEFAULT 'workspace_shared',
  ADD COLUMN owner_subject_id text,
  ADD CONSTRAINT workspace_artifacts_visibility_check CHECK (
    visibility IN ('workspace_shared', 'user_private')
    AND (visibility = 'workspace_shared' OR owner_subject_id IS NOT NULL)
  );

-- The backfill reads across tenants, so it lifts FORCE row security for its
-- own transaction on exactly the tables that have it, then restores it.
CREATE TEMP TABLE site_audience_forced_tables ON COMMIT DROP AS
  SELECT relation.oid::regclass AS relation
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = pg_catalog.current_schema()
    AND relation.relname IN (
      'workspace_artifacts', 'workspace_artifact_versions', 'session_turns',
      'organization_memberships'
    )
    AND relation.relforcerowsecurity;

DO $lift$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT relation FROM site_audience_forced_tables LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END
$lift$;

WITH owners AS (
  SELECT site.id, coalesce(
    (
      SELECT coalesce(
        turn.initiating_human_subject_id,
        CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
      )
      FROM workspace_artifact_versions first_version
      JOIN session_turns turn
        ON turn.account_id = first_version.account_id
        AND turn.workspace_id = first_version.workspace_id
        AND turn.session_id = first_version.source_session_id
        AND turn.id = first_version.source_turn_id
      JOIN organization_memberships membership
        ON membership.account_id = site.account_id
        AND membership.subject_id = coalesce(
          turn.initiating_human_subject_id,
          CASE WHEN turn.initiator_kind = 'subject' THEN turn.initiator_subject_id END
        )
      WHERE first_version.workspace_id = site.workspace_id
        AND first_version.artifact_id = site.id
        AND first_version.revision = 1
      LIMIT 1
    ),
    (
      SELECT membership.subject_id
      FROM organization_memberships membership
      WHERE membership.account_id = site.account_id
        AND membership.subject_id = site.created_by_subject_id
      LIMIT 1
    )
  ) AS owner_subject_id
  FROM workspace_artifacts site
  WHERE site.owner_subject_id IS NULL
)
UPDATE workspace_artifacts site
SET owner_subject_id = owners.owner_subject_id
FROM owners
WHERE site.id = owners.id
  AND owners.owner_subject_id IS NOT NULL;

-- The updated rows queue the deferred current-version check; run it now, while
-- row security is still lifted, so the table can be altered back below.
SET CONSTRAINTS workspace_artifacts_validate_current IMMEDIATE;

DO $restore$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT relation FROM site_audience_forced_tables LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END
$restore$;

DO $existing_sites_stay_shared$
BEGIN
  IF EXISTS (SELECT 1 FROM workspace_artifacts WHERE visibility <> 'workspace_shared') THEN
    RAISE EXCEPTION 'site audience backfill must keep every existing Site workspace-visible';
  END IF;
END
$existing_sites_stay_shared$;
