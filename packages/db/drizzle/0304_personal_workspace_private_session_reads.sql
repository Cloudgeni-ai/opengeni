-- deployment-mode: rolling
-- Align the private-session read predicate with the exact personal-workspace
-- authority already enforced by the 0303 transition/fork lifecycle functions.
-- A managed personal workspace deliberately has no workspace_memberships row,
-- so requiring one here made an owning human lose the session immediately
-- after a valid transition to user_private.

DO $session_private_actor_personal_workspace_reads$
DECLARE
  data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.session_private_actor_visible(
      p_account_id uuid,
      p_workspace_id uuid,
      p_owner_organization_membership_id uuid,
      p_owner_subject_id text
    ) RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE
      actor_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.subject_id', true), ''
      );
      initiating_human_subject_id text := nullif(
        pg_catalog.current_setting('opengeni.initiating_human_subject_id', true), ''
      );
      previous_lifecycle_marker text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      visible boolean := false;
    BEGIN
      IF p_account_id IS NULL
        OR p_workspace_id IS NULL
        OR p_owner_organization_membership_id IS NULL
        OR p_owner_subject_id IS NULL
        OR (
          actor_subject_id IS DISTINCT FROM p_owner_subject_id
          AND initiating_human_subject_id IS DISTINCT FROM p_owner_subject_id
        )
      THEN
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        'session_visibility_activation',
        true
      );
      SELECT EXISTS (
        SELECT 1
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.id = p_owner_organization_membership_id
          AND membership.subject_id = p_owner_subject_id
          AND membership.status = 'active'
          AND (
            membership.personal_workspace_id = p_workspace_id
            OR EXISTS (
              SELECT 1
              FROM workspace_memberships workspace_membership
              WHERE workspace_membership.account_id = p_account_id
                AND workspace_membership.workspace_id = p_workspace_id
                AND workspace_membership.subject_id = p_owner_subject_id
            )
          )
      ) INTO visible;
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RETURN visible;
    EXCEPTION WHEN OTHERS THEN
      PERFORM pg_catalog.set_config(
        'opengeni.organization_tenancy_lifecycle',
        CASE WHEN previous_lifecycle_marker IS NULL THEN '' ELSE previous_lifecycle_marker END,
        true
      );
      RAISE;
    END;
    $body$;
  $ddl$, data_schema);
  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.session_private_actor_visible(uuid,uuid,uuid,text) FROM PUBLIC',
    data_schema
  );
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.session_private_actor_visible(uuid,uuid,uuid,text) TO opengeni_app',
      data_schema
    );
  END IF;
END
$session_private_actor_personal_workspace_reads$;
