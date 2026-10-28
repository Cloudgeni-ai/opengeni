-- deployment-mode: rolling
-- A shared subscription a person connects in a shared workspace also reaches
-- that person's own Personal workspace, and nobody else's. It is one marked
-- workspace assignment: the row for the Personal workspace records whose it is
-- (`personal_reach_subject_id`) and the shared workspace it came through
-- (`personal_reach_via_workspace_id`). The connection stays that workspace's
-- own (D-50), so its administrators keep managing it.
--
-- The reach lasts only while the person still belongs to that workspace:
-- every serving check below requires their workspace membership there
-- (suspension and offboarding delete those memberships), and triggers delete
-- the row when the membership goes or the organization membership stops being
-- active. The person, or whoever manages the workspace's account, can remove
-- it. Existing rows are unchanged (both columns null), so nothing is
-- backfilled. The previous release never writes the columns, reads them only
-- through the replaced routines, and its access editor at most drops the row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE subscription_connection_workspaces
  ADD COLUMN personal_reach_subject_id text,
  ADD COLUMN personal_reach_via_workspace_id uuid;
-- NOT VALID still checks every inserted and updated row, and only those can
-- carry the new columns, so no validating scan is needed.
ALTER TABLE subscription_connection_workspaces
  ADD CONSTRAINT subscription_connection_workspaces_personal_reach_chk CHECK (
    (personal_reach_subject_id IS NULL AND personal_reach_via_workspace_id IS NULL)
    OR (personal_reach_subject_id LIKE 'user:%'
      AND personal_reach_via_workspace_id IS NOT NULL
      AND personal_reach_via_workspace_id <> workspace_id)
  ) NOT VALID;

-- Connect: the connecting person adds their own reach, through the workspace
-- whose own connection it is (the guard below checks the rest).
CREATE POLICY subscription_connection_workspaces_personal_reach_connect
  ON subscription_connection_workspaces FOR INSERT
  WITH CHECK (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND personal_reach_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
    AND personal_reach_via_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND opengeni_private.subscription_apps_designation_manage_allowed(
      account_id, personal_reach_via_workspace_id, connection_id)
  );

-- In the workspace it came through, the person and the workspace's
-- administrators see the reach and may remove it.
CREATE POLICY subscription_connection_workspaces_personal_reach_read
  ON subscription_connection_workspaces FOR SELECT
  USING (
    personal_reach_subject_id IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND personal_reach_via_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND (personal_reach_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
      OR EXISTS (SELECT 1 FROM workspace_memberships manager
        WHERE manager.account_id = subscription_connection_workspaces.account_id
          AND manager.workspace_id = subscription_connection_workspaces.personal_reach_via_workspace_id
          AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions)))
  );
CREATE POLICY subscription_connection_workspaces_personal_reach_remove
  ON subscription_connection_workspaces FOR DELETE
  USING (
    personal_reach_subject_id IS NOT NULL
    AND account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND personal_reach_via_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND (personal_reach_subject_id = nullif(current_setting('opengeni.subject_id', true), '')
      OR EXISTS (SELECT 1 FROM workspace_memberships manager
        WHERE manager.account_id = subscription_connection_workspaces.account_id
          AND manager.workspace_id = subscription_connection_workspaces.personal_reach_via_workspace_id
          AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          AND opengeni_private.workspace_membership_administers(manager.role, manager.permissions)))
  );

-- Membership cleanup (the triggers below), whoever removes the membership.
CREATE POLICY subscription_connection_workspaces_personal_reach_cleanup_read
  ON subscription_connection_workspaces FOR SELECT
  USING (
    personal_reach_subject_id IS NOT NULL
    AND current_setting('opengeni.subscription_personal_reach_cleanup', true) = account_id::text
  );
CREATE POLICY subscription_connection_workspaces_personal_reach_cleanup
  ON subscription_connection_workspaces FOR DELETE
  USING (
    personal_reach_subject_id IS NOT NULL
    AND current_setting('opengeni.subscription_personal_reach_cleanup', true) = account_id::text
  );

-- Removes the reach when its person leaves the workspace it came through
-- (workspace membership deleted or moved) or stops being an active member of
-- the organization. Runs as whoever changed the membership; the cleanup
-- policies above admit exactly these rows.
CREATE FUNCTION opengeni_private.drop_subscription_personal_reach() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT AS $$
DECLARE
  previous_cleanup text := pg_catalog.current_setting(
    'opengeni.subscription_personal_reach_cleanup', true);
BEGIN
  PERFORM pg_catalog.set_config(
    'opengeni.subscription_personal_reach_cleanup', OLD.account_id::text, true);
  IF TG_TABLE_NAME = 'workspace_memberships' THEN
    DELETE FROM subscription_connection_workspaces assignment
    WHERE assignment.account_id = OLD.account_id
      AND assignment.personal_reach_via_workspace_id = OLD.workspace_id
      AND assignment.personal_reach_subject_id = OLD.subject_id;
  ELSE
    DELETE FROM subscription_connection_workspaces assignment
    WHERE assignment.account_id = OLD.account_id
      AND assignment.personal_reach_subject_id = OLD.subject_id;
  END IF;
  PERFORM pg_catalog.set_config(
    'opengeni.subscription_personal_reach_cleanup', coalesce(previous_cleanup, ''), true);
  RETURN NULL;
END
$$;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.drop_subscription_personal_reach() SET search_path = pg_catalog, %I, pg_temp',
    current_schema());
END
$pin$;
REVOKE ALL ON FUNCTION opengeni_private.drop_subscription_personal_reach() FROM PUBLIC;

CREATE TRIGGER workspace_memberships_personal_reach_drop
  AFTER DELETE ON workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.drop_subscription_personal_reach();
CREATE TRIGGER workspace_memberships_personal_reach_move
  AFTER UPDATE OF account_id, workspace_id, subject_id ON workspace_memberships
  FOR EACH ROW
  WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.subject_id IS DISTINCT FROM NEW.subject_id)
  EXECUTE FUNCTION opengeni_private.drop_subscription_personal_reach();
CREATE TRIGGER organization_memberships_personal_reach_drop
  AFTER DELETE ON organization_memberships
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.drop_subscription_personal_reach();
CREATE TRIGGER organization_memberships_personal_reach_inactive
  AFTER UPDATE OF status, revoked_at, personal_workspace_id ON organization_memberships
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM 'active'
    OR NEW.revoked_at IS NOT NULL
    OR OLD.personal_workspace_id IS DISTINCT FROM NEW.personal_workspace_id)
  EXECUTE FUNCTION opengeni_private.drop_subscription_personal_reach();

-- The routines below are patched in place: pg_get_functiondef keeps each
-- one's owner, SECURITY mode and pinned search_path, and CREATE OR REPLACE
-- keeps its grants. Each anchor must occur exactly once.
DO $patch$
DECLARE
  definition text;
  anchor text;
  replacement text;
  routine regprocedure;
  -- A marked row serves only while its person still belongs to the workspace
  -- it came through.
  live constant text := $live$
          AND (assignment.personal_reach_subject_id IS NULL OR EXISTS (
            SELECT 1 FROM workspace_memberships reach_member
            WHERE reach_member.account_id = assignment.account_id
              AND reach_member.workspace_id = assignment.personal_reach_via_workspace_id
              AND reach_member.subject_id = assignment.personal_reach_subject_id))$live$;
  patches constant text[][] := ARRAY[
    -- Serving and RLS visibility.
    ARRAY['opengeni_private.subscription_connection_visible(uuid,uuid,uuid,text,text,uuid,text,text)',
      $a$        WHERE assignment.account_id = p_account_id AND assignment.workspace_id = p_workspace_id
          AND assignment.connection_id = p_connection_id$a$],
    -- Operation targets outside a turn.
    ARRAY['opengeni_subscription_internal.subscription_core_connection_target(text,uuid,uuid,uuid,uuid,uuid,text,bigint)',
      $a$            WHERE assignment.account_id = target.account_id
              AND assignment.connection_id = target.id
              AND assignment.workspace_id = p_workspace_id$a$],
    -- Codex Apps designation and its target.
    ARRAY['opengeni_private.subscription_apps_designation_allowed(uuid,uuid,uuid)',
      $a$          WHERE assignment.account_id = connection.account_id
            AND assignment.connection_id = connection.id
            AND assignment.workspace_id = p_workspace_id$a$],
    ARRAY['opengeni_private.subscription_codex_apps_designation_target(uuid,uuid)',
      $a$            WHERE assignment.account_id = target.account_id
              AND assignment.connection_id = target.id
              AND assignment.workspace_id = p_workspace_id$a$]
  ];
BEGIN
  FOR i IN 1 .. array_length(patches, 1) LOOP
    routine := patches[i][1]::regprocedure;
    definition := pg_catalog.pg_get_functiondef(routine);
    anchor := patches[i][2];
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '% assignment anchor changed', routine USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(definition, anchor, anchor || live);
  END LOOP;

  -- A workspace administrator still disconnects the workspace's own account
  -- when its only other reach is a Personal workspace that came through it.
  routine := 'opengeni_private.disconnect_subscription_core_connection(text,uuid,uuid,text,uuid)'::regprocedure;
  definition := pg_catalog.pg_get_functiondef(routine);
  anchor := $a$                AND assignment.workspace_id <> p_workspace_id))$a$;
  replacement := $r$                AND assignment.workspace_id <> p_workspace_id
                AND assignment.personal_reach_via_workspace_id IS DISTINCT FROM p_workspace_id))$r$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION '% reach anchor changed', routine USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END
$patch$;

-- D-50 with one exception: a workspace's own connection may also reach the
-- Personal workspace of the person who connected it there. Only connect adds
-- that row, only for that person, and it is never rewritten (only removed or,
-- by the organization, made an ordinary assignment). CREATE OR REPLACE keeps
-- the routine's owner, grants and both triggers; the search_path is pinned
-- again below.
CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_workspace_owner_reach()
RETURNS trigger
LANGUAGE plpgsql
AS $$
    DECLARE
      reach_connection subscription_connections%ROWTYPE;
      reach_memberships jsonb;
      previous_lifecycle text;
    BEGIN
      IF TG_TABLE_NAME = 'subscription_connection_workspaces' THEN
        IF NEW.personal_reach_subject_id IS NOT NULL THEN
          IF TG_OP = 'UPDATE' AND (
              NEW.personal_reach_subject_id IS DISTINCT FROM OLD.personal_reach_subject_id
              OR NEW.personal_reach_via_workspace_id IS DISTINCT FROM OLD.personal_reach_via_workspace_id
              OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id) THEN
            RAISE EXCEPTION 'a Personal workspace reach is added only when its person connects'
              USING ERRCODE = '23514';
          END IF;
          IF TG_OP = 'INSERT' THEN
            SELECT connection.* INTO reach_connection FROM subscription_connections connection
            WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id;
            IF NOT FOUND
              OR NEW.personal_reach_subject_id IS DISTINCT FROM
                nullif(pg_catalog.current_setting('opengeni.subject_id', true), '')
              OR reach_connection.ownership IS DISTINCT FROM 'shared'
              OR reach_connection.scope_kind IS DISTINCT FROM 'workspaces'
              OR reach_connection.allow_personal_workspaces
              OR reach_connection.connected_by_subject_id IS DISTINCT FROM NEW.personal_reach_subject_id
              OR reach_connection.managed_by_workspace_id IS DISTINCT FROM NEW.personal_reach_via_workspace_id
              OR NOT EXISTS (SELECT 1 FROM workspace_memberships member
                WHERE member.account_id = NEW.account_id
                  AND member.workspace_id = NEW.personal_reach_via_workspace_id
                  AND member.subject_id = NEW.personal_reach_subject_id) THEN
              RAISE EXCEPTION 'only the connecting person''s own Personal workspace can be added'
                USING ERRCODE = '23514';
            END IF;
            previous_lifecycle := pg_catalog.current_setting(
              'opengeni.organization_tenancy_lifecycle', true);
            reach_memberships := list_self_organization_memberships(NEW.personal_reach_subject_id);
            PERFORM pg_catalog.set_config(
              'opengeni.organization_tenancy_lifecycle', coalesce(previous_lifecycle, ''), true);
            IF NOT EXISTS (SELECT 1 FROM pg_catalog.jsonb_array_elements(reach_memberships) membership
                WHERE membership->>'organizationId' = NEW.account_id::text
                  AND membership->>'status' = 'active'
                  AND membership->>'revokedAt' IS NULL
                  AND membership->>'personalWorkspaceId' = NEW.workspace_id::text) THEN
              RAISE EXCEPTION 'only the connecting person''s own Personal workspace can be added'
                USING ERRCODE = '23514';
            END IF;
          END IF;
          IF EXISTS (SELECT 1 FROM subscription_connections connection
              WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
                AND connection.managed_by_workspace_id IS NOT NULL
                AND connection.managed_by_workspace_id <> NEW.personal_reach_via_workspace_id) THEN
            RAISE EXCEPTION 'a workspace''s own subscription connection serves only that workspace'
              USING ERRCODE = '23514';
          END IF;
        ELSIF EXISTS (SELECT 1 FROM subscription_connections connection
            WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
              AND connection.managed_by_workspace_id IS NOT NULL
              AND connection.managed_by_workspace_id <> NEW.workspace_id) THEN
          RAISE EXCEPTION 'a workspace''s own subscription connection serves only that workspace'
            USING ERRCODE = '23514';
        END IF;
      ELSIF NEW.managed_by_workspace_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM subscription_connection_workspaces assignment
          WHERE assignment.account_id = NEW.account_id AND assignment.connection_id = NEW.id
            AND assignment.workspace_id <> NEW.managed_by_workspace_id
            AND assignment.personal_reach_via_workspace_id IS DISTINCT FROM
              NEW.managed_by_workspace_id) THEN
        RAISE EXCEPTION 'a workspace''s own subscription connection serves only that workspace'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $$;

DO $pin$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_subscription_workspace_owner_reach() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    current_schema());
END
$pin$;
