-- deployment-mode: rolling
-- The owner of a personal workspace could not create, open or edit
-- documents, spreadsheets or presentations there from Opengeni. The editable
-- artifact authorization answered a person only from a workspace_memberships
-- row, and a personal workspace deliberately has none (0219): its owner's
-- authority is their active organization membership's personal workspace
-- pointer, as everywhere else that resolves live workspace authority.
--
-- A person in the human branch now also holds their own personal workspace
-- through that pointer. The owner's personal workspace permissions include
-- artifacts:read and artifacts:publish, so every editable artifact permission
-- follows. Agents, API keys, configured keys and everyone else are unchanged.
-- The membership read uses the organization membership lifecycle scope, as
-- list_self_organization_memberships does, and restores the previous scope.
--
-- Only this function body changes; its owner and grants stay.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $repair$
DECLARE definition text;
  anchor text := $old$      INTO principal_allowed
      USING p_account_id, p_workspace_id, p_actor_subject_id, required_permission;
  ELSE
    principal_allowed := false;
  END IF;$old$;
  replacement text := $new$      INTO principal_allowed
      USING p_account_id, p_workspace_id, p_actor_subject_id, required_permission;
    -- A person's own personal workspace has no membership row (0867).
    IF NOT coalesce(principal_allowed, false) AND p_actor_kind = 'human'
      AND p_actor_subject_id ~ '^(user|external_user):'
    THEN
      DECLARE prior_lifecycle text := pg_catalog.current_setting(
        'opengeni.organization_tenancy_lifecycle', true
      );
      BEGIN
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', 'organization_membership_lifecycle', true
        );
        EXECUTE pg_catalog.format($personal$
          SELECT true
          FROM %I.organization_memberships owner_membership
          WHERE owner_membership.account_id = $1
            AND owner_membership.subject_id = $3
            AND owner_membership.personal_workspace_id = $2
            AND owner_membership.status = 'active'
            AND owner_membership.revoked_at IS NULL
          LIMIT 1
          FOR SHARE OF owner_membership
        $personal$, data_schema)
          INTO principal_allowed
          USING p_account_id, p_workspace_id, p_actor_subject_id;
        PERFORM pg_catalog.set_config(
          'opengeni.organization_tenancy_lifecycle', coalesce(prior_lifecycle, ''), true
        );
      END;
    END IF;
  ELSE
    principal_allowed := false;
  END IF;$new$;
BEGIN
  SELECT pg_get_functiondef(
    'opengeni_private.authorize_editable_artifact_actor(uuid,uuid,text,text,text,text,text,text,integer,text,text,name)'::regprocedure
  ) INTO STRICT definition;
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'authorize_editable_artifact_actor human branch anchor drifted';
  END IF;
  EXECUTE replace(definition, anchor, replacement);
END $repair$;
