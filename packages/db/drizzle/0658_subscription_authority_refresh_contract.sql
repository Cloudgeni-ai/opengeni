-- deployment-mode: rolling
-- Add only the chat-turn v2 slot and an inactive, lease-fenced credential-write
-- seam. The M3 cutover gate remains absent; v1 accepted authority stays live.

ALTER TABLE session_turns
  ADD COLUMN subscription_authority jsonb;

CREATE FUNCTION subscription_personal_authority_v2_valid(snapshot jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $function$
  SELECT jsonb_typeof(snapshot) = 'object'
    AND snapshot ?& ARRAY['version', 'personal']
    AND snapshot - ARRAY['version', 'personal']::text[] = '{}'::jsonb
    AND snapshot->'version' = '2'::jsonb
    AND jsonb_typeof(snapshot->'personal') = 'array'
    AND CASE
      WHEN jsonb_typeof(snapshot->'personal') = 'array'
        THEN jsonb_array_length(snapshot->'personal') <= 3
      ELSE false
    END
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(snapshot->'personal') = 'array' THEN snapshot->'personal'
        ELSE '[]'::jsonb
      END) AS entry(value)
      WHERE jsonb_typeof(entry.value) <> 'object'
        OR entry.value - ARRAY['provider', 'ownerMembershipId', 'authorityGeneration']::text[] <> '{}'::jsonb
        OR NOT (entry.value ?& ARRAY['provider', 'ownerMembershipId', 'authorityGeneration'])
        OR entry.value->>'provider' NOT IN ('codex', 'claude', 'xai')
        OR jsonb_typeof(entry.value->'ownerMembershipId') <> 'string'
        -- Canonical lowercase only, matching uuid::text and the TypeScript
        -- schema, so an accepted snapshot can never silently fail to match.
        OR (entry.value->>'ownerMembershipId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR jsonb_typeof(entry.value->'authorityGeneration') <> 'number'
        OR (entry.value->>'authorityGeneration') !~ '^[1-9][0-9]*$'
        OR (entry.value->>'authorityGeneration')::numeric > 9007199254740991
    )
    AND (
      SELECT count(DISTINCT entry.value->>'provider') = count(*)
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(snapshot->'personal') = 'array' THEN snapshot->'personal'
        ELSE '[]'::jsonb
      END) AS entry(value)
    )
$function$;

ALTER TABLE session_turns
  ADD CONSTRAINT session_turns_subscription_authority_v2_chk
  CHECK (subscription_authority IS NULL OR subscription_personal_authority_v2_valid(subscription_authority))
  NOT VALID;
ALTER TABLE session_turns
  VALIDATE CONSTRAINT session_turns_subscription_authority_v2_chk;

COMMENT ON COLUMN session_turns.subscription_authority IS
  'Nullable M3 v2 accepted-authority slot. The v1 Codex snapshot remains authoritative until drained cutover.';

-- The accepted v2 snapshot is immutable for application callers, like the v1
-- provider snapshots. The table owner remains able to populate it during the
-- later drained maintenance backfill; SECURITY DEFINER callers do not inherit
-- that exception because the check uses session_user.
DO $subscription_authority_immutability$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION %1$I.prevent_subscription_authority_v2_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog
    AS $body$
    DECLARE table_owner name;
    BEGIN
      IF NEW.subscription_authority IS DISTINCT FROM OLD.subscription_authority THEN
        SELECT pg_catalog.pg_get_userbyid(relation.relowner) INTO table_owner
        FROM pg_catalog.pg_class relation
        WHERE relation.oid = TG_RELID;
        IF session_user IS DISTINCT FROM table_owner THEN
          RAISE EXCEPTION 'session turn subscription authority is immutable'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $body$;
  $ddl$, data_schema);

  EXECUTE format(
    'REVOKE ALL ON FUNCTION %I.prevent_subscription_authority_v2_mutation() FROM PUBLIC',
    data_schema
  );

  EXECUTE format($ddl$
    CREATE TRIGGER session_turns_subscription_authority_immutable_trg
    BEFORE UPDATE OF subscription_authority ON %1$I.session_turns
    FOR EACH ROW
    EXECUTE FUNCTION %1$I.prevent_subscription_authority_v2_mutation()
  $ddl$, data_schema);
END
$subscription_authority_immutability$;

ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN (
      'personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write'
    )),
  DROP CONSTRAINT subscription_runtime_capabilities_provider_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_provider_chk CHECK (
    (capability_kind = 'personal_access' AND provider IN ('codex','claude','xai')
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'session_access' AND provider IS NULL
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
    OR (capability_kind = 'binding_access' AND provider IN ('codex','claude','xai')
      AND session_id IS NOT NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'lifecycle' AND provider IS NULL AND session_id IS NULL
      AND turn_id IS NULL AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
    OR (capability_kind = 'designation_management' AND provider IS NULL AND session_id IS NULL
      AND turn_id IS NULL AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL
      AND workspace_id IS NOT NULL)
    OR (capability_kind IN ('codex_refresh_authorized', 'codex_refresh_write') AND provider = 'codex'
      AND workspace_id IS NOT NULL AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND ((session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
        OR (session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)))
  );

DO $ownerless_session_access$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE allowed boolean;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR nullif(current_setting('opengeni.subject_id', true), '') IS DISTINCT FROM 'service:subscription-core'
        OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NOT NULL
      THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING;
      SELECT EXISTS (
        SELECT 1 FROM sessions session
        JOIN session_turns turn ON turn.account_id = session.account_id
          AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
        WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
          AND session.id = p_session_id AND session.owner_subject_id IS NULL
          AND session.owner_organization_membership_id IS NULL
          AND session.visibility <> 'user_private'
          AND turn.id = p_turn_id AND turn.initiating_human_subject_id IS NULL
          AND session_reference_visible(p_account_id, p_workspace_id, p_session_id)
      ) INTO allowed;
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      IF NOT allowed THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'session_access',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_session_id, NULL, NULL
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
      DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
        turn_id = EXCLUDED.turn_id, session_owner_subject_id = NULL, turn_human_subject_id = NULL;
      PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', '', true);
      PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', '', true);
      RETURN true;
    END
    $body$
  $ddl$, data_schema);
END
$ownerless_session_access$;
REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(uuid, uuid, uuid, uuid) FROM PUBLIC;
DO $grant_ownerless_session_access$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(uuid, uuid, uuid, uuid) TO opengeni_app;
  END IF;
END
$grant_ownerless_session_access$;

DO $personal_placement_access$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.authorize_subscription_personal_placement_access(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_provider text, p_owner_membership_id uuid, p_authority_generation bigint,
      p_session_owner_subject_id text, p_turn_human_subject_id text
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      authority_snapshot jsonb;
      enabled boolean := false;
      allowed boolean := false;
      minted_lifecycle boolean := false;
      minted_connections uuid[] := '{}'::uuid[];
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR nullif(current_setting('opengeni.subject_id', true), '') IS DISTINCT FROM 'service:subscription-core'
        OR p_turn_human_subject_id IS NULL
        OR p_turn_human_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
        OR p_session_owner_subject_id IS NULL
        OR p_session_owner_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.session_owner_subject_id', true), '')
        OR p_session_owner_subject_id IS DISTINCT FROM p_turn_human_subject_id
        OR p_owner_membership_id IS NULL OR p_authority_generation IS NULL OR p_authority_generation < 1
        OR p_provider NOT IN ('codex', 'claude', 'xai')
      THEN RETURN false; END IF;

      -- This precursor remains inert until the provider's cutover row is
      -- explicitly enabled by the later drained migration. Check this before
      -- consulting v2 so v1 remains authoritative during rolling deploys.
      SELECT cutover.enabled INTO enabled
      FROM subscription_provider_cutovers cutover
      WHERE cutover.account_id = p_account_id AND cutover.provider = p_provider;
      IF enabled IS DISTINCT FROM true THEN RETURN false; END IF;

      IF NOT EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'session_access'
          AND capability.account_id = p_account_id
          AND capability.workspace_id = p_workspace_id
          AND capability.session_id = p_session_id
          AND capability.turn_id = p_turn_id
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id
      ) THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING
      RETURNING true INTO minted_lifecycle;
      minted_lifecycle := coalesce(minted_lifecycle, false);

      SELECT turn.subscription_authority INTO authority_snapshot
      FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      JOIN organization_memberships membership ON membership.account_id = session.account_id
        AND membership.id = session.owner_organization_membership_id
        AND membership.subject_id = session.owner_subject_id
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND session.owner_subject_id = p_session_owner_subject_id
        AND session.owner_organization_membership_id = p_owner_membership_id
        AND turn.id = p_turn_id AND turn.initiating_human_subject_id = p_turn_human_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND (session.visibility = 'user_private' OR membership.personal_workspace_id = p_workspace_id)
        AND session_reference_visible(p_account_id, p_workspace_id, p_session_id);

      IF authority_snapshot IS NOT NULL
        AND authority_snapshot->>'version' = '2'
        AND jsonb_typeof(authority_snapshot->'personal') = 'array'
      THEN
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements(authority_snapshot->'personal') entry
          WHERE entry->>'provider' = p_provider
            AND (entry->>'ownerMembershipId')::uuid = p_owner_membership_id
            AND entry->>'authorityGeneration' = p_authority_generation::text
        ) INTO allowed;
      END IF;
      IF NOT allowed OR NOT coalesce((subscription_effective_settings(
        p_account_id, p_workspace_id
      ) #>> '{values,personalConnectionsAllowed}')::boolean, false) THEN
        IF minted_lifecycle THEN
          DELETE FROM opengeni_private.subscription_runtime_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
        END IF;
        RETURN false;
      END IF;

      -- Authorities identify exact personal resource IDs. Mint temporary
      -- per-connection capabilities only for those whose current authority
      -- generation matches the frozen v2 generation, then remove any whose
      -- connection row does not prove the same owner/provider/generation.
      -- Never rewrite or remove a capability the caller already held for a
      -- connection (for example an earlier v1 Claude authorization in the
      -- same transaction): conflicts are left untouched, and every cleanup
      -- below is limited to the rows this call inserted.
      WITH inserted AS (
        INSERT INTO opengeni_private.subscription_runtime_capabilities (
          backend_pid, transaction_id, capability_kind, account_id, workspace_id,
          session_id, turn_id, connection_id, provider,
          session_owner_subject_id, turn_human_subject_id
        )
        SELECT pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'personal_access',
          p_account_id, p_workspace_id, p_session_id, p_turn_id, authority.resource_id,
          p_provider, p_session_owner_subject_id, p_turn_human_subject_id
        FROM organization_user_resource_authorities authority
        WHERE authority.account_id = p_account_id
          AND authority.organization_membership_id = p_owner_membership_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.generation = p_authority_generation
          AND authority.status = 'active' AND authority.revoked_at IS NULL
        ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
        RETURNING connection_id
      )
      SELECT coalesce(array_agg(inserted.connection_id), '{}'::uuid[])
        INTO minted_connections FROM inserted;

      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'personal_access'
        AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
        AND capability.connection_id = ANY (minted_connections)
        AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
        AND capability.provider = p_provider
        AND capability.session_owner_subject_id = p_session_owner_subject_id
        AND capability.turn_human_subject_id = p_turn_human_subject_id
        AND NOT EXISTS (
          SELECT 1 FROM subscription_connections connection
          JOIN organization_user_resource_authorities authority
            ON authority.id = connection.authority_id
            AND authority.account_id = connection.account_id
            AND authority.organization_membership_id = p_owner_membership_id
            AND authority.resource_kind = 'subscription_connection'
            AND authority.resource_id = connection.id
            AND authority.generation = p_authority_generation
            AND authority.status = 'active' AND authority.revoked_at IS NULL
          WHERE connection.account_id = capability.account_id
            AND connection.id = capability.connection_id
            AND connection.provider = p_provider AND connection.ownership = 'personal'
            AND connection.owner_organization_membership_id = p_owner_membership_id
            AND connection.owner_subject_id = p_session_owner_subject_id
            AND connection.authority_generation = p_authority_generation
            AND connection.status = 'active'
        );

      SELECT EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        JOIN subscription_connections connection ON connection.account_id = capability.account_id
          AND connection.id = capability.connection_id AND connection.provider = capability.provider
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
          AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
          AND capability.provider = p_provider
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = p_owner_membership_id
          AND connection.authority_generation = p_authority_generation
          AND opengeni_private.subscription_personal_connection_visible(
            p_account_id, connection.id, p_owner_membership_id,
            p_session_owner_subject_id, p_turn_human_subject_id, p_provider
          )
      ) INTO allowed;

      IF minted_lifecycle THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      END IF;
      IF NOT allowed THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.workspace_id = p_workspace_id
          AND capability.connection_id = ANY (minted_connections)
          AND capability.session_id = p_session_id AND capability.turn_id = p_turn_id
          AND capability.provider = p_provider
          AND capability.session_owner_subject_id = p_session_owner_subject_id
          AND capability.turn_human_subject_id = p_turn_human_subject_id;
        RETURN false;
      END IF;
      PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', p_session_owner_subject_id, true);
      PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', p_turn_human_subject_id, true);
      RETURN true;
    END
    $body$
  $ddl$, data_schema);
END
$personal_placement_access$;
REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_personal_placement_access(
  uuid, uuid, uuid, uuid, text, uuid, bigint, text, text
) FROM PUBLIC;
DO $grant_personal_placement_access$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_subscription_personal_placement_access(
      uuid, uuid, uuid, uuid, text, uuid, bigint, text, text
    ) TO opengeni_app;
  END IF;
END
$grant_personal_placement_access$;

CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_connection_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
DECLARE
  session_owner text;
  session_owner_membership uuid;
  turn_human text;
  target subscription_connections%ROWTYPE;
  visible boolean;
  personal_authorized boolean := false;
  ownerless_session boolean := false;
BEGIN
  IF NEW.connection_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR NEW.workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR NOT session_reference_visible(NEW.account_id, NEW.workspace_id, NEW.session_id)
  THEN
    RAISE EXCEPTION 'subscription connection target is outside the visible session'
      USING ERRCODE = '42501';
  END IF;
  SELECT session.owner_subject_id, session.owner_organization_membership_id
    INTO session_owner, session_owner_membership
  FROM sessions session
  WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
    AND session.id = NEW.session_id;
  IF NOT FOUND OR (session_owner IS NULL) <> (session_owner_membership IS NULL) THEN
    RAISE EXCEPTION 'subscription session owner authority is unavailable or malformed'
      USING ERRCODE = '42501';
  END IF;
  ownerless_session := session_owner IS NULL;

  IF TG_TABLE_NAME = 'subscription_leases' THEN
    SELECT turn.initiating_human_subject_id INTO turn_human
    FROM session_turns turn
    WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
      AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'subscription lease turn is not in the referenced session'
        USING ERRCODE = '42501';
    END IF;
    IF ownerless_session THEN
      IF turn_human IS NOT NULL OR NOT opengeni_private.authorize_subscription_ownerless_session_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id
      ) THEN
        RAISE EXCEPTION 'ownerless subscription lease turn is not authorized for this session'
          USING ERRCODE = '42501';
      END IF;
    ELSIF turn_human IS NULL THEN
      IF NOT opengeni_private.authorize_subscription_service_session_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner
      ) THEN
        RAISE EXCEPTION 'non-human subscription lease turn is not authorized for this session'
          USING ERRCODE = '42501';
      END IF;
      turn_human := session_owner;
    ELSIF NOT opengeni_private.authorize_subscription_session_access(
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner, turn_human
    ) THEN
      RAISE EXCEPTION 'subscription lease turn is not authorized for this session'
        USING ERRCODE = '42501';
    END IF;
    IF NOT ownerless_session THEN
      personal_authorized := opengeni_private.authorize_subscription_personal_access(
        NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, NEW.connection_id,
        NEW.provider, session_owner, turn_human
      );
    END IF;
  ELSE
    -- Bindings have no turn id, so there is no exact ownerless turn to verify.
    -- Keep ownerless binding writes fail-closed until that contract is explicit.
    IF ownerless_session THEN
      RAISE EXCEPTION 'ownerless subscription bindings require an exact accepted turn'
        USING ERRCODE = '42501';
    END IF;
    turn_human := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
    IF turn_human IS NULL THEN
      RAISE EXCEPTION 'subscription binding requires an initiating human'
        USING ERRCODE = '42501';
    END IF;
    INSERT INTO opengeni_private.subscription_runtime_capabilities (
      backend_pid, transaction_id, capability_kind, account_id, workspace_id,
      session_id, connection_id, provider, session_owner_subject_id, turn_human_subject_id
    ) VALUES (
      pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'binding_access',
      NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.connection_id, NEW.provider,
      session_owner, turn_human
    )
    ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
    DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
      provider = EXCLUDED.provider,
      session_owner_subject_id = EXCLUDED.session_owner_subject_id,
      turn_human_subject_id = EXCLUDED.turn_human_subject_id;
    PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', session_owner, true);
    PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', turn_human, true);
  END IF;

  SELECT connection.* INTO target
  FROM subscription_connections connection
  WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
    AND connection.provider = NEW.provider AND connection.status = 'active';
  IF NOT FOUND OR NOT opengeni_private.subscription_connection_visible(
    NEW.account_id, NEW.workspace_id, target.id, target.ownership, target.scope_kind,
    target.owner_organization_membership_id, target.owner_subject_id, target.provider
  ) THEN
    RAISE EXCEPTION 'subscription connection is not in the session eligible pool'
      USING ERRCODE = '42501';
  END IF;
  IF ownerless_session AND (target.ownership <> 'shared'
    OR target.scope_kind NOT IN ('organization', 'workspaces')) THEN
    RAISE EXCEPTION 'ownerless subscription sessions require organization- or workspace-scoped shared connections'
      USING ERRCODE = '42501';
  END IF;
  IF target.ownership = 'personal' AND TG_TABLE_NAME = 'subscription_leases'
    AND (ownerless_session OR NOT personal_authorized OR NOT coalesce((subscription_effective_settings(
      NEW.account_id, NEW.workspace_id
    ) #>> '{values,personalConnectionsAllowed}')::boolean, false)) THEN
    RAISE EXCEPTION 'personal subscription lease lacks current settings or frozen user authority'
      USING ERRCODE = '42501';
  END IF;
  IF target.ownership = 'personal' AND TG_TABLE_NAME = 'subscription_session_bindings' THEN
    SELECT EXISTS (
      SELECT 1 FROM sessions session
      JOIN organization_memberships membership ON membership.account_id = session.account_id
        AND membership.id = target.owner_organization_membership_id
        AND membership.subject_id = session.owner_subject_id
      JOIN organization_user_resource_authorities authority
        ON authority.id = target.authority_id AND authority.account_id = target.account_id
        AND authority.organization_membership_id = membership.id
        AND authority.resource_kind = target.authority_resource_kind
        AND authority.resource_id = target.id
        AND authority.generation = target.authority_generation
        AND authority.status = 'active' AND authority.revoked_at IS NULL
      WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
        AND session.id = NEW.session_id AND session.owner_subject_id = target.owner_subject_id
        AND turn_human = session.owner_subject_id AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND (session.visibility = 'user_private' OR membership.personal_workspace_id = NEW.workspace_id)
    ) INTO visible;
    IF NOT visible OR NOT coalesce((subscription_effective_settings(
      NEW.account_id, NEW.workspace_id
    ) #>> '{values,personalConnectionsAllowed}')::boolean, false) THEN
      RAISE EXCEPTION 'personal subscription connection is not eligible for this session'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

DO $ownerless_operation_lease_guard$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.guard_subscription_operation_lease_reference()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      session_owner text;
      session_owner_membership uuid;
      turn_human text;
      visible boolean;
      personal_authorized boolean := false;
      ownerless_session boolean := false;
    BEGIN
      IF NEW.account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR NEW.workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN
        RAISE EXCEPTION 'subscription operation lease is outside the scoped account or workspace'
          USING ERRCODE = '42501';
      END IF;

      IF NEW.session_id IS NULL THEN
        IF NEW.operation_kind <> 'transcription'
          OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL
          OR nullif(current_setting('opengeni.initiating_human_subject_id', true), '') IS NULL
        THEN
          RAISE EXCEPTION 'sessionless subscription operation requires explicit transcription authority'
            USING ERRCODE = '42501';
        END IF;
      ELSE
        IF NOT session_reference_visible(NEW.account_id, NEW.workspace_id, NEW.session_id) THEN
          RAISE EXCEPTION 'subscription operation session is not visible'
            USING ERRCODE = '42501';
        END IF;
        SELECT session.owner_subject_id, session.owner_organization_membership_id
          INTO session_owner, session_owner_membership
        FROM sessions session
        WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
          AND session.id = NEW.session_id;
        IF NOT FOUND OR (session_owner IS NULL) <> (session_owner_membership IS NULL) THEN
          RAISE EXCEPTION 'subscription operation session owner authority is unavailable or malformed'
            USING ERRCODE = '42501';
        END IF;
        ownerless_session := session_owner IS NULL;

        IF NEW.turn_id IS NOT NULL THEN
          SELECT turn.initiating_human_subject_id INTO turn_human
          FROM session_turns turn
          WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
            AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'subscription operation turn is not in the referenced session'
              USING ERRCODE = '42501';
          END IF;
          IF ownerless_session THEN
            IF turn_human IS NOT NULL OR NOT opengeni_private.authorize_subscription_ownerless_session_access(
              NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id
            ) THEN
              RAISE EXCEPTION 'ownerless subscription operation turn is not authorized for this session'
                USING ERRCODE = '42501';
            END IF;
          ELSIF turn_human IS NULL THEN
            IF NOT opengeni_private.authorize_subscription_service_session_access(
              NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner
            ) THEN
              RAISE EXCEPTION 'non-human subscription operation is not authorized for this session'
                USING ERRCODE = '42501';
            END IF;
            turn_human := session_owner;
          ELSIF NOT opengeni_private.authorize_subscription_session_access(
            NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, session_owner, turn_human
          ) THEN
            RAISE EXCEPTION 'subscription operation turn is not authorized for this session'
              USING ERRCODE = '42501';
          END IF;
        ELSE
          turn_human := nullif(current_setting('opengeni.initiating_human_subject_id', true), '');
          IF ownerless_session OR turn_human IS NULL OR turn_human IS DISTINCT FROM session_owner THEN
            RAISE EXCEPTION 'session-bound subscription operation requires its accepted owner context'
              USING ERRCODE = '42501';
          END IF;
        END IF;
      END IF;

      IF NEW.session_id IS NOT NULL AND NEW.turn_id IS NOT NULL AND NOT ownerless_session THEN
        personal_authorized := opengeni_private.authorize_subscription_personal_access(
          NEW.account_id, NEW.workspace_id, NEW.session_id, NEW.turn_id, NEW.connection_id,
          NEW.provider, session_owner, turn_human
        );
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = NEW.account_id AND connection.id = NEW.connection_id
        AND connection.provider = NEW.provider AND connection.status = 'active';
      IF NOT FOUND OR NOT opengeni_private.subscription_connection_visible(
        NEW.account_id, NEW.workspace_id, target.id, target.ownership, target.scope_kind,
        target.owner_organization_membership_id, target.owner_subject_id, target.provider
      ) THEN
        RAISE EXCEPTION 'subscription operation connection is not in the authorized pool'
          USING ERRCODE = '42501';
      END IF;
      IF ownerless_session AND (target.ownership <> 'shared'
        OR target.scope_kind NOT IN ('organization', 'workspaces')) THEN
        RAISE EXCEPTION 'ownerless subscription operations require organization- or workspace-scoped shared connections'
          USING ERRCODE = '42501';
      END IF;
      IF target.ownership = 'personal' THEN
        IF NEW.session_id IS NULL OR NEW.turn_id IS NULL OR NOT personal_authorized
          OR NOT coalesce((subscription_effective_settings(
            NEW.account_id, NEW.workspace_id
          ) #>> '{values,personalConnectionsAllowed}')::boolean, false)
        THEN
          RAISE EXCEPTION 'personal subscription operation lacks frozen owner authority or current settings'
            USING ERRCODE = '42501';
        END IF;
      END IF;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$ownerless_operation_lease_guard$;

CREATE FUNCTION opengeni_private.subscription_codex_refresh_write_allowed(
  p_account_id uuid, p_workspace_id uuid, p_connection_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, opengeni_private, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = 'codex_refresh_write'
      AND capability.account_id = p_account_id
      AND capability.workspace_id = p_workspace_id
      AND capability.connection_id = p_connection_id
      AND capability.provider = 'codex'
  )
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_refresh_write_allowed(uuid, uuid, uuid) FROM PUBLIC;

CREATE POLICY subscription_connections_codex_refresh_update
  ON subscription_connections FOR UPDATE
  USING (provider = 'codex' AND opengeni_private.subscription_codex_refresh_write_allowed(
    account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id
  ))
  WITH CHECK (provider = 'codex' AND opengeni_private.subscription_codex_refresh_write_allowed(
    account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id
  ));

-- The write capability exists only inside persist_subscription_codex_refresh.
-- Expose the exact row to that statement even when the turn lost ordinary
-- visibility during the provider call: the rotated refresh token belongs to
-- the connection, and refusing to store it would strand every other user.
CREATE POLICY subscription_connections_codex_refresh_read
  ON subscription_connections FOR SELECT
  USING (provider = 'codex' AND opengeni_private.subscription_codex_refresh_write_allowed(
    account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid, id
  ));

-- Codex refresh is two calls in one transaction around the provider request.
--
-- begin_subscription_codex_refresh authorizes before the network call: exact
-- accepted turn, session access, live lease holder and generation, ownerless
-- shared-only scope, personal authority and current visibility. It returns the
-- credential to refresh and mints a one-shot codex_refresh_authorized
-- capability that no RLS policy reads.
--
-- persist_subscription_codex_refresh runs after the provider has rotated the
-- refresh token. It consumes that capability and writes under the per-connection
-- advisory lock and refresh_generation compare-and-swap only. It deliberately
-- does not repeat lease-expiry, visibility, settings or authority checks:
-- Codex refresh tokens rotate, so refusing a write after the provider accepted
-- the old token would leave the connection unusable for everyone, while
-- writing it back gives this turn nothing it does not already hold.
--
-- Lock order: the advisory key 'subscription-refresh:<connection id>' first,
-- then the connection row (FOR NO KEY UPDATE through the UPDATE). Neither
-- function locks the lease row, and no row lock is held across the provider
-- call, so lease renewal, release and foreign-key checks against the
-- connection never wait on a refresh. Any writer that replaces a Codex
-- credential must take the same advisory key and advance refresh_generation.
DO $begin_codex_refresh$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.begin_subscription_codex_refresh(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_session_owner_subject_id text, p_turn_human_subject_id text,
      p_connection_id uuid, p_holder_id text, p_lease_generation bigint
    ) RETURNS TABLE (
      refresh_generation bigint, credential_encrypted text, expires_at timestamptz
    )
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      session_owner text;
      turn_human text;
      capability_owner text;
      capability_human text;
      target subscription_connections%%ROWTYPE;
      authorized boolean := false;
      personal_authorized boolean := false;
      ownerless_session boolean := false;
      had_personal_access boolean := false;
      minted boolean := false;
      lease_current boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_lease_generation IS NULL OR p_lease_generation < 1
        OR p_holder_id IS NULL OR length(btrim(p_holder_id)) NOT BETWEEN 1 AND 256
      THEN RETURN; END IF;

      -- Serialize every refresh of this connection for the whole transaction,
      -- including the provider call between begin and persist.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('subscription-refresh:' || p_connection_id::text, 0)
      );

      -- Treat the accepted row as authoritative. The service-turn wrapper may
      -- set the owner as the effective human GUC while the frozen turn human
      -- remains NULL, so those values must not be conflated.
      SELECT session.owner_subject_id, turn.initiating_human_subject_id
        INTO session_owner, turn_human
      FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND turn.id = p_turn_id;
      IF NOT FOUND OR session_owner IS DISTINCT FROM p_session_owner_subject_id
        OR turn_human IS DISTINCT FROM p_turn_human_subject_id
      THEN RETURN; END IF;
      ownerless_session := session_owner IS NULL;

      IF session_owner IS NULL THEN
        authorized := turn_human IS NULL
          AND opengeni_private.authorize_subscription_ownerless_session_access(
            p_account_id, p_workspace_id, p_session_id, p_turn_id
          );
      ELSIF turn_human IS NULL THEN
        authorized := opengeni_private.authorize_subscription_service_session_access(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, session_owner
        );
      ELSE
        authorized := opengeni_private.authorize_subscription_session_access(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, session_owner, turn_human
        );
      END IF;
      IF NOT authorized THEN RETURN; END IF;
      IF ownerless_session THEN
        capability_owner := NULL;
        capability_human := NULL;
      ELSE
        capability_owner := session_owner;
        capability_human := coalesce(turn_human, session_owner);
      END IF;

      -- Authorize only for the exact accepted turn's live lease. This is a
      -- point-in-time check: the lease row is not locked across the call.
      SELECT EXISTS (
        SELECT 1 FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.workspace_id = p_workspace_id
          AND lease.session_id = p_session_id AND lease.turn_id = p_turn_id
          AND lease.provider = 'codex' AND lease.connection_id = p_connection_id
          AND lease.holder_id = p_holder_id AND lease.generation = p_lease_generation
          AND lease.leased_until > pg_catalog.clock_timestamp()
      ) INTO lease_current;
      IF NOT lease_current THEN RETURN; END IF;

      -- A service or ownerless turn can refresh only shared credentials. For
      -- human turns, the existing v1 helper grants visibility only for the
      -- exact accepted personal connection and authority snapshot. Remember
      -- whether the caller already held that capability so cleanup removes
      -- only what this call created.
      IF NOT ownerless_session AND turn_human IS NOT NULL THEN
        SELECT EXISTS (
          SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
          WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
            AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
            AND capability.capability_kind = 'personal_access'
            AND capability.account_id = p_account_id
            AND capability.connection_id = p_connection_id
        ) INTO had_personal_access;
        personal_authorized := opengeni_private.authorize_subscription_personal_access(
          p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id,
          'codex', session_owner, turn_human
        );
      END IF;

      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.status = 'active';
      authorized := FOUND
        AND NOT (ownerless_session AND (
          target.ownership IS DISTINCT FROM 'shared'
          OR (
            target.scope_kind IS DISTINCT FROM 'organization'
            AND target.scope_kind IS DISTINCT FROM 'workspaces'
          )
        ))
        AND NOT (target.ownership = 'personal' AND NOT personal_authorized)
        AND opengeni_private.subscription_connection_visible(
          p_account_id, p_workspace_id, target.id, target.ownership, target.scope_kind,
          target.owner_organization_membership_id, target.owner_subject_id, target.provider
        );

      IF NOT had_personal_access THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id
          AND capability.connection_id = p_connection_id;
      END IF;
      IF NOT coalesce(authorized, false) THEN RETURN; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_authorized',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, 'codex',
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO minted;
      -- A second begin for the same connection in one transaction would bind
      -- two refreshes to one advisory hold. Refuse it without touching the
      -- first authorization.
      IF minted IS DISTINCT FROM true THEN RETURN; END IF;

      refresh_generation := target.refresh_generation;
      credential_encrypted := target.credential_encrypted;
      expires_at := target.expires_at;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
END
$begin_codex_refresh$;

DO $persist_codex_refresh$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.persist_subscription_codex_refresh(
      p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
      p_connection_id uuid, p_expected_refresh_generation bigint,
      p_credential_encrypted text, p_expires_at timestamptz, p_last_refresh_at timestamptz
    ) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      capability_owner text;
      capability_human text;
      write_minted boolean := false;
      refresh_persisted boolean := false;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_connection_id IS NULL OR p_session_id IS NULL OR p_turn_id IS NULL
        OR p_expected_refresh_generation IS NULL OR p_expected_refresh_generation < 1
        OR p_credential_encrypted IS NULL
        OR p_credential_encrypted !~ '^v[12]:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$'
        OR p_last_refresh_at IS NULL
      THEN RETURN false; END IF;

      -- Consume the one-shot authorization begin minted in this transaction.
      -- The advisory transaction lock it took is still held.
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_refresh_authorized'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_id = p_session_id
        AND capability.turn_id = p_turn_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = 'codex'
      RETURNING capability.session_owner_subject_id, capability.turn_human_subject_id
        INTO capability_owner, capability_human;
      IF NOT FOUND THEN RETURN false; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id,
        session_id, turn_id, connection_id, provider,
        session_owner_subject_id, turn_human_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'codex_refresh_write',
        p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, 'codex',
        capability_owner, capability_human
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO NOTHING
      RETURNING true INTO write_minted;
      IF write_minted IS DISTINCT FROM true THEN RETURN false; END IF;

      -- The compare-and-swap is the only freshness fence after the provider
      -- call. Status is not rechecked: a connection disabled meanwhile keeps a
      -- usable token if it is enabled again, and a deleted row simply matches
      -- nothing.
      UPDATE subscription_connections
      SET credential_encrypted = p_credential_encrypted,
          credential_format = split_part(p_credential_encrypted, ':', 1),
          expires_at = p_expires_at,
          last_refresh_at = p_last_refresh_at,
          refresh_generation = subscription_connections.refresh_generation + 1,
          version = version + 1,
          updated_at = pg_catalog.clock_timestamp()
      WHERE account_id = p_account_id AND id = p_connection_id
        AND provider = 'codex' AND kind = 'subscription'
        AND subscription_connections.refresh_generation = p_expected_refresh_generation;
      refresh_persisted := FOUND;

      -- Do not let the write capability survive this call and authorize
      -- another statement in the caller's transaction.
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'codex_refresh_write'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id;
      RETURN refresh_persisted;
    END
    $body$
  $ddl$, data_schema);
END
$persist_codex_refresh$;

REVOKE ALL ON FUNCTION opengeni_private.begin_subscription_codex_refresh(
  uuid, uuid, uuid, uuid, text, text, uuid, text, bigint
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.persist_subscription_codex_refresh(
  uuid, uuid, uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
) FROM PUBLIC;

DO $grant_codex_refresh$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_refresh_write_allowed(uuid, uuid, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.begin_subscription_codex_refresh(
      uuid, uuid, uuid, uuid, text, text, uuid, text, bigint
    ) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.persist_subscription_codex_refresh(
      uuid, uuid, uuid, uuid, uuid, bigint, text, timestamptz, timestamptz
    ) TO opengeni_app;
  END IF;
END
$grant_codex_refresh$;

DO $subscription_core_precursor_search_paths$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.authorize_subscription_ownerless_session_access(uuid,uuid,uuid,uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.authorize_subscription_personal_placement_access(uuid,uuid,uuid,uuid,text,uuid,bigint,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_subscription_connection_reference() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
END
$subscription_core_precursor_search_paths$;
