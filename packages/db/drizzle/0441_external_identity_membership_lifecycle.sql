-- deployment-mode: rolling
-- Add attributable service administration to the canonical organization
-- lifecycle. No copied teardown, new retention policy, or native member proxy.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE organization_membership_lifecycle_events
  ALTER COLUMN actor_membership_id DROP NOT NULL,
  ADD COLUMN actor_service_subject text,
  ADD CONSTRAINT organization_membership_lifecycle_events_actor_kind_check CHECK (
    (actor_membership_id IS NOT NULL AND actor_service_subject IS NULL)
    OR (actor_membership_id IS NULL AND actor_service_subject IS NOT NULL
      AND actor_service_subject ~ '^api_key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  );

-- Only the existing definer lifecycle routines invoke this private helper.
-- UUID knowledge is not authentication; API resolution supplies the subject.
CREATE FUNCTION opengeni_private.external_membership_service_authority(p_command jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE
  actor_subject text := p_command ->> 'actorSubjectId';
  account_id_value uuid := (p_command ->> 'organizationId')::uuid;
  membership_id_value uuid := (p_command ->> 'membershipId')::uuid;
  permissions_value jsonb;
  allowed boolean;
  previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF actor_subject NOT LIKE 'api_key:%' THEN RETURN false; END IF;
  IF actor_subject IS DISTINCT FROM opengeni_private.current_subject_id()
    OR account_id_value IS DISTINCT FROM opengeni_private.current_account_id()
    OR (p_command ->> 'action') IS NULL
    OR (p_command ->> 'action') NOT IN ('suspend', 'reactivate', 'offboard')
    OR account_id_value IS NULL OR membership_id_value IS NULL
  THEN RAISE EXCEPTION 'external lifecycle authority invalid' USING ERRCODE = '42501'; END IF;
  SELECT credential.permissions INTO permissions_value FROM api_keys credential
  WHERE credential.account_id = account_id_value
    AND 'api_key:' || credential.id::text = actor_subject
    AND credential.workspace_id IS NULL AND credential.credential_kind = 'organization'
    AND credential.revoked_at IS NULL
    AND (credential.expires_at IS NULL OR credential.expires_at > clock_timestamp())
  FOR SHARE;
  IF NOT coalesce(permissions_value ? 'account:admin', false) THEN
    RAISE EXCEPTION 'external lifecycle service administration required' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  SELECT EXISTS (
    SELECT 1 FROM external_identities identity_row
    JOIN organization_memberships membership
      ON membership.id = identity_row.organization_membership_id
      AND membership.account_id = identity_row.account_id
      AND membership.subject_id = identity_row.subject_id
      AND membership.personal_workspace_id = identity_row.personal_workspace_id
    WHERE identity_row.account_id = account_id_value
      AND membership.id = membership_id_value AND membership.role = 'member'
  ) INTO allowed;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  IF NOT allowed THEN
    RAISE EXCEPTION 'external lifecycle target unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.external_membership_service_authority(jsonb) FROM PUBLIC;

-- Native and service lifecycle writes invalidate the same external admission
-- generation. Reactivation never restores the shared memberships or durable
-- grants that the canonical suspension/offboarding protocol already revoked.
CREATE FUNCTION opengeni_private.sync_external_membership_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $body$
DECLARE previous_marker text := current_setting('opengeni.organization_tenancy_lifecycle', true);
BEGIN
  IF NEW.subject_id NOT LIKE 'external_user:%' THEN RETURN NEW; END IF;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', 'external_identity_provisioning', true);
  UPDATE external_identities SET
    status = CASE NEW.status WHEN 'active' THEN 'active' WHEN 'revoked' THEN 'revoked' ELSE 'disabled' END,
    authorization_revision = authorization_revision + 1,
    updated_at = clock_timestamp()
  WHERE account_id = NEW.account_id AND organization_membership_id = NEW.id
    AND subject_id = NEW.subject_id;
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('opengeni.organization_tenancy_lifecycle', coalesce(previous_marker, ''), true);
  RAISE;
END
$body$;
REVOKE ALL ON FUNCTION opengeni_private.sync_external_membership_lifecycle() FROM PUBLIC;
CREATE TRIGGER organization_membership_external_lifecycle
AFTER UPDATE OF status, authorization_revision ON organization_memberships
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.authorization_revision IS DISTINCT FROM NEW.authorization_revision)
EXECUTE FUNCTION opengeni_private.sync_external_membership_lifecycle();

DO $patch$
DECLARE
  signature text;
  definition text;
  anchor text;
  replacement text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'prepare_organization_membership_protocol_settlements(jsonb)',
    'organization_membership_command_0263(jsonb)'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    anchor := '  input_hash_value text;';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1
      OR strpos(definition, 'acquire_organization_session_tenancy_fences') = 0 THEN
      RAISE EXCEPTION '0441 lifecycle declaration or fence drift: %', signature USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, anchor || E'\n  service_authorized boolean := false;');
    anchor := '  input_hash_value := pg_catalog.encode(';
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0441 lifecycle admission drift: %', signature USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor,
      E'  service_authorized := opengeni_private.external_membership_service_authority(p_command);\n' || anchor);
    IF signature = 'prepare_organization_membership_protocol_settlements(jsonb)' THEN
      anchor := 'IF actor.id IS NULL OR actor.status <> ''active'' OR actor.role NOT IN (''owner'', ''admin'') THEN';
      replacement := 'IF NOT service_authorized AND (actor.id IS NULL OR actor.status <> ''active'' OR actor.role NOT IN (''owner'', ''admin'')) THEN';
    ELSE
      anchor := 'IF NOT FOUND OR actor.status <> ''active'' THEN';
      replacement := 'IF NOT service_authorized AND (NOT FOUND OR actor.status <> ''active'') THEN';
    END IF;
    IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
      RAISE EXCEPTION '0441 lifecycle actor guard drift: %', signature USING ERRCODE = '55000';
    END IF;
    definition := replace(definition, anchor, replacement);
    IF signature = 'organization_membership_command_0263(jsonb)' THEN
      -- All service actions were strictly constrained before receipt replay;
      -- native administration checks stay byte-for-byte for native actors.
      anchor := 'IF actor.role NOT IN (''owner'', ''admin'') THEN';
      IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 3 THEN
        RAISE EXCEPTION '0441 lifecycle role guard drift' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, anchor, 'IF NOT service_authorized AND actor.role NOT IN (''owner'', ''admin'') THEN');
      anchor := 'account_id, operation_id, actor_membership_id, target_membership_id, kind,';
      IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
        RAISE EXCEPTION '0441 lifecycle audit columns drift' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, anchor,
        'account_id, operation_id, actor_membership_id, actor_service_subject, target_membership_id, kind,');
      anchor := 'account_id_value, operation_id_value, actor.id,';
      IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
        RAISE EXCEPTION '0441 lifecycle audit values drift' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, anchor,
        'account_id_value, operation_id_value, actor.id, CASE WHEN service_authorized THEN actor_subject ELSE NULL END,');
      anchor := '''human'', actor_subject, ''organization.membership.'' || action_name';
      IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
        RAISE EXCEPTION '0441 lifecycle interruption audit drift' USING ERRCODE = '55000';
      END IF;
      definition := replace(definition, anchor,
        'CASE WHEN service_authorized THEN ''service'' ELSE ''human'' END, actor_subject, ''organization.membership.'' || action_name');
    END IF;
    EXECUTE definition;
  END LOOP;
END
$patch$;