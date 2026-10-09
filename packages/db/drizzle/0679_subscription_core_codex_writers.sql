-- deployment-mode: rolling
-- M3 PR 3b: the remaining Codex writers on the shared subscription core
-- (design docs/design/subscription-core-2026-10-07.md, "PR 3b"). Dormant like
-- PR 1/2: every routine below refuses unless the organization's Codex cutover
-- row is enabled, and no legacy table is read or written.
--
-- 1. v2 accepted-authority slots on scheduled tasks, their revision
--    authorities, internal updates and the update outbox (design 3.7),
--    immutable to application roles after insert like the session_turns slot
--    (0667). A revision authority derives its value from its task: the task's
--    own value when the revision's authorizer is the task owner, otherwise
--    the empty value (never a wider grant).
-- 2. Two owner-run capabilities: `codex_connection_owner` (the acting
--    person's own personal Codex connections and the redemption ledger of one
--    connection) and `codex_reset_credit_fence` (the redemption ledger of one
--    connection across workspaces), each admitted only by owner-only policies.
-- 3. connect_subscription_codex_personal: the owner-scoped personal writer.
--    Only the person themself, in their own Personal workspace, with personal
--    connections allowed there, creates or reconnects their personal Codex
--    connection. A reconnect takes the connection's refresh key
--    ('subscription-refresh:<id>') and then its row lock, so it waits for an
--    in-flight refresh and for a redemption's FOR SHARE lock.
-- 4. disconnect_subscription_codex_connection: an organization administrator
--    removes a shared connection, the owner their personal one (from their
--    Personal workspace). Delegated workspace managers cannot delete
--    (SUB-OWN-04). Refused while any workspace's redemption of the connection
--    is provider_started, or while any chat or operation lease still names it.
-- 5. subscription_codex_personal_connections: the acting person's own personal
--    Codex connections (no credential material), for their Personal-workspace
--    list and their sessions' "Running on" view.
-- 6. subscription_codex_reset_authority also authorizes an organization
--    administrator for an organization-managed shared connection, and
--    subscription_codex_reset_credit_fence serializes and fences one provider
--    credit of one connection across every workspace's ledger.
-- 7. provider_subject_id: the signed-in person within the upstream account.
--    Every member of a ChatGPT Team/Business/Enterprise workspace shares the
--    ChatGPT account id, so one connection per (organization, upstream
--    account, owner) would merge different people's logins. The shared
--    connect writer reconnects in place only for the same person; another
--    person's login is a distinct connection.

SET LOCAL lock_timeout = '5s';

-- 7. The upstream person, part of the connection identity.
ALTER TABLE subscription_connections ADD COLUMN provider_subject_id text;
ALTER TABLE subscription_connections ADD CONSTRAINT subscription_connections_provider_subject_chk
  CHECK (provider_subject_id IS NULL OR length(btrim(provider_subject_id)) BETWEEN 1 AND 512);
DROP INDEX subscription_connections_provider_owner_account_uq;
CREATE UNIQUE INDEX subscription_connections_provider_owner_account_uq
  ON subscription_connections (account_id, provider, provider_account_id,
    COALESCE(provider_subject_id, ''),
    COALESCE(owner_organization_membership_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE provider_account_id IS NOT NULL;

-- 1. v2 accepted-authority slots.
ALTER TABLE scheduled_tasks ADD COLUMN subscription_authority jsonb;
ALTER TABLE scheduled_task_revision_authorities ADD COLUMN subscription_authority jsonb;
ALTER TABLE session_system_updates ADD COLUMN subscription_authority jsonb;
ALTER TABLE session_system_update_outbox ADD COLUMN subscription_authority jsonb;
-- Whole-row digests must not reinterpret pre-migration execution evidence.
-- Like immutable owner_subject_id (0478), this separately frozen authority is
-- not mutable execution configuration. Exclude it even when non-null so the
-- drained cutover can backfill v2 without invalidating accepted run receipts.
-- In particular NULL must hash exactly like the pre-migration absent key.
DO $subscription_authority_digest$
DECLARE signature text; definition text; row_name text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'scheduled_task_execution_digest(scheduled_tasks)',
    'set_scheduled_task_execution_digest()'
  ] LOOP
    definition := pg_get_functiondef(signature::regprocedure);
    row_name := CASE WHEN signature = 'set_scheduled_task_execution_digest()'
      THEN 'NEW' ELSE 'p_task' END;
    IF strpos(definition, 'pg_catalog.to_jsonb(' || row_name || ')') = 0 THEN
      RAISE EXCEPTION 'scheduled task digest definition changed: %', signature;
    END IF;
    EXECUTE replace(definition, 'pg_catalog.to_jsonb(' || row_name || ')',
      '(pg_catalog.to_jsonb(' || row_name || ') - ''subscription_authority'')');
  END LOOP;
END
$subscription_authority_digest$;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_subscription_authority_v2_chk
  CHECK (subscription_authority IS NULL OR subscription_personal_authority_v2_valid(subscription_authority))
  NOT VALID;
ALTER TABLE scheduled_task_revision_authorities
  ADD CONSTRAINT scheduled_task_revision_authorities_subscription_authority_v2_chk
  CHECK (subscription_authority IS NULL OR subscription_personal_authority_v2_valid(subscription_authority))
  NOT VALID;
ALTER TABLE session_system_updates ADD CONSTRAINT session_system_updates_subscription_authority_v2_chk
  CHECK (subscription_authority IS NULL OR subscription_personal_authority_v2_valid(subscription_authority))
  NOT VALID;
ALTER TABLE session_system_update_outbox
  ADD CONSTRAINT session_system_update_outbox_subscription_authority_v2_chk
  CHECK (subscription_authority IS NULL OR subscription_personal_authority_v2_valid(subscription_authority))
  NOT VALID;
ALTER TABLE scheduled_tasks VALIDATE CONSTRAINT scheduled_tasks_subscription_authority_v2_chk;
ALTER TABLE scheduled_task_revision_authorities
  VALIDATE CONSTRAINT scheduled_task_revision_authorities_subscription_authority_v2_chk;
ALTER TABLE session_system_updates
  VALIDATE CONSTRAINT session_system_updates_subscription_authority_v2_chk;
ALTER TABLE session_system_update_outbox
  VALIDATE CONSTRAINT session_system_update_outbox_subscription_authority_v2_chk;
CREATE TRIGGER scheduled_tasks_subscription_authority_immutable_trg
  BEFORE UPDATE OF subscription_authority ON scheduled_tasks
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();
CREATE TRIGGER scheduled_task_revision_authorities_subscription_authority_immutable_trg
  BEFORE UPDATE OF subscription_authority ON scheduled_task_revision_authorities
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();
CREATE TRIGGER session_system_updates_subscription_authority_immutable_trg
  BEFORE UPDATE OF subscription_authority ON session_system_updates
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();
CREATE TRIGGER session_system_update_outbox_subscription_authority_immutable_trg
  BEFORE UPDATE OF subscription_authority ON session_system_update_outbox
  FOR EACH ROW EXECUTE FUNCTION prevent_subscription_authority_v2_mutation();

DO $revision_subscription_authority$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.derive_scheduled_revision_subscription_authority()
    RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
    DECLARE task_authority jsonb; task_owner text;
    BEGIN
      IF NEW.subscription_authority IS NOT NULL THEN RETURN NEW; END IF;
      SELECT task.subscription_authority, task.owner_subject_id INTO task_authority, task_owner
      FROM scheduled_tasks task
      WHERE task.account_id = NEW.account_id AND task.id = NEW.task_id;
      -- A task without a v2 value (accepted before the cutover) keeps none;
      -- another person's revision never inherits the owner's personal entry.
      NEW.subscription_authority := CASE
        WHEN task_authority IS NULL THEN NULL
        WHEN NEW.subject_id IS NOT NULL AND NEW.subject_id = task_owner THEN task_authority
        ELSE '{"version":2,"personal":[]}'::jsonb
      END;
      RETURN NEW;
    END
    $body$
  $ddl$, data_schema);
END
$revision_subscription_authority$;
REVOKE ALL ON FUNCTION opengeni_private.derive_scheduled_revision_subscription_authority() FROM PUBLIC;
CREATE TRIGGER scheduled_task_revision_authorities_subscription_authority_trg
  BEFORE INSERT ON scheduled_task_revision_authorities
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.derive_scheduled_revision_subscription_authority();

-- 2. Owner-run capabilities and the owner-only policies that admit them.
ALTER TABLE opengeni_private.subscription_runtime_capabilities
  DROP CONSTRAINT subscription_runtime_capabilities_kind_chk,
  ADD CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN (
      'personal_access', 'session_access', 'binding_access', 'lifecycle',
      'designation_management', 'codex_refresh_authorized', 'codex_refresh_write',
      'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
      'codex_connection_owner', 'codex_reset_credit_fence'
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
    OR (capability_kind IN (
        'codex_apps_refresh_authorized', 'codex_connection_refresh_authorized',
        'codex_refresh_write'
      )
      AND provider = 'codex' AND workspace_id IS NOT NULL
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
    -- The acting person is carried in session_owner_subject_id; no session,
    -- turn or turn human. The all-zero connection id means "this person's own
    -- personal connections"; any other id names exactly one connection. The
    -- workspace is the request's (NULL on an organization route).
    OR (capability_kind IN ('codex_connection_owner', 'codex_reset_credit_fence')
      AND provider = 'codex'
      AND session_id IS NULL AND turn_id IS NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NULL)
  );

-- Owner-only policies. Each admits only the table owner (the SECURITY
-- DEFINER routines below) while this backend's current transaction holds the
-- matching capability, which carries the acting person. The capability is
-- read through SECURITY DEFINER helpers: policies are evaluated for every
-- caller, and the application role has no access to the capability table.
-- The helpers report only this backend's own transaction capabilities, which
-- the application role cannot create.
DO $codex_owner_capability_helpers$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_owner_capability_held(
      p_account_id uuid, p_kinds text[], p_subject_id text, p_connection_id uuid,
      p_any_connection boolean
    ) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = ANY(p_kinds)
          AND capability.account_id = p_account_id
          AND (p_subject_id IS NULL OR capability.session_owner_subject_id = p_subject_id)
          AND (p_connection_id IS NULL OR capability.connection_id = p_connection_id
            OR (p_any_connection
              AND capability.connection_id = '00000000-0000-0000-0000-000000000000'::uuid)))
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_owner_membership_held(
      p_account_id uuid, p_membership_id uuid
    ) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
      SELECT EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        JOIN organization_memberships membership
          ON membership.account_id = capability.account_id
         AND membership.subject_id = capability.session_owner_subject_id
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'codex_connection_owner'
          AND capability.account_id = p_account_id
          AND membership.id = p_membership_id)
    $body$
  $ddl$, data_schema);
END
$codex_owner_capability_helpers$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_owner_capability_held(
  uuid, text[], text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_owner_membership_held(uuid, uuid)
  FROM PUBLIC;
DO $grant_codex_owner_capability_helpers$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_owner_capability_held(
      uuid, text[], text, uuid, boolean) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_owner_membership_held(uuid, uuid)
      TO opengeni_app;
  END IF;
END
$grant_codex_owner_capability_helpers$;

CREATE POLICY subscription_codex_owner_membership_read ON organization_memberships FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'organization_memberships'::regclass))
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], subject_id, NULL, false));

CREATE POLICY subscription_codex_owner_authority_read ON organization_user_resource_authorities
  FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection'
    AND opengeni_private.subscription_codex_owner_membership_held(
      account_id, organization_membership_id));
CREATE POLICY subscription_codex_owner_authority_insert ON organization_user_resource_authorities
  FOR INSERT
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection' AND status = 'active'
    AND opengeni_private.subscription_codex_owner_membership_held(
      account_id, organization_membership_id));
CREATE POLICY subscription_codex_owner_authority_revoke ON organization_user_resource_authorities
  FOR UPDATE
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND resource_kind = 'subscription_connection'
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], NULL, resource_id, false))
  WITH CHECK (status = 'revoked');

CREATE POLICY subscription_codex_owner_alias_read ON subscription_connection_aliases FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connection_aliases'::regclass))
    AND provider = 'codex'
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], NULL, connection_id, true));

CREATE POLICY subscription_codex_owner_connections ON subscription_connections FOR ALL
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connections'::regclass))
    AND provider = 'codex' AND ownership = 'personal'
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], owner_subject_id, id, true))
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'subscription_connections'::regclass))
    AND provider = 'codex' AND ownership = 'personal'
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], owner_subject_id, id, true));

-- Disconnect must retire expired leases even in another/private workspace.
-- Only this owner-run, exact-connection capability crosses the session RLS
-- fence; application reads/writes and every live lease keep their policies.
DO $expired_codex_leases$
DECLARE table_name text; owner_clause text; ordinary_clause text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['subscription_leases', 'subscription_operation_leases'] LOOP
    owner_clause := format(
      'current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = %L::regclass)) AND leased_until <= clock_timestamp() AND opengeni_private.subscription_codex_owner_capability_held(account_id, ARRAY[''codex_connection_owner''], NULL, connection_id, false)', table_name);
    ordinary_clause := CASE WHEN table_name = 'subscription_operation_leases'
      THEN 'session_id IS NULL OR session_reference_visible(account_id, workspace_id, session_id)'
      ELSE 'session_reference_visible(account_id, workspace_id, session_id)' END;
    EXECUTE format('ALTER POLICY session_visibility_isolation ON %I USING ((%s) OR (%s))',
      table_name, ordinary_clause, owner_clause);
    EXECUTE format('CREATE POLICY subscription_codex_expired_lease_read ON %I FOR SELECT USING (%s)', table_name, owner_clause);
    EXECUTE format('CREATE POLICY subscription_codex_expired_lease_delete ON %I FOR DELETE USING (%s)', table_name, owner_clause);
  END LOOP;
END
$expired_codex_leases$;

CREATE POLICY subscription_codex_owner_settings ON subscription_settings FOR ALL
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class
      WHERE oid = 'subscription_settings'::regclass))
    AND workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner'], NULL, NULL, false)
    AND cardinality(locked_settings) = 0);

-- The redemption ledger of exactly one connection, in every workspace. Only
-- the cross-workspace fence may write through it (to re-file one attempt).
CREATE POLICY subscription_codex_reset_ledger_fence ON codex_reset_redemption_attempts FOR ALL
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'codex_reset_redemption_attempts'::regclass))
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_connection_owner', 'codex_reset_credit_fence'], NULL,
      credential_id, false))
  WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'codex_reset_redemption_attempts'::regclass))
    AND opengeni_private.subscription_codex_owner_capability_held(
      account_id, ARRAY['codex_reset_credit_fence'], NULL, credential_id, false));

-- Shared helpers for the routines below.
DO $codex_owner_routines$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_revision_authority_v2(
      p_account_id uuid, p_workspace_id uuid, p_task_id uuid, p_revision bigint
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN NULL; END IF;
      RETURN (SELECT revision.subscription_authority
        FROM scheduled_task_revision_authorities revision
        WHERE revision.account_id = p_account_id AND revision.workspace_id = p_workspace_id
          AND revision.task_id = p_task_id AND revision.task_authority_revision = p_revision);
    END
    $body$
  $ddl$, data_schema);
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_writer_context(
      p_account_id uuid, p_workspace_id uuid, p_subject_id text
    ) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      -- The exact authenticated caller (a NULL workspace only on an
      -- organization route) and an enabled Codex cutover.
      SELECT p_account_id IS NOT NULL
        AND p_subject_id IS NOT NULL AND p_subject_id LIKE 'user:_%%'
        AND p_account_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        AND p_workspace_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND p_subject_id IS NOT DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
        AND EXISTS (SELECT 1 FROM subscription_provider_cutovers cutover
          WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
            AND cutover.enabled)
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.grant_subscription_codex_owner_capability(
      p_kind text, p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid
    ) RETURNS void
    LANGUAGE sql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id, workspace_id, connection_id,
        provider, session_owner_subject_id
      ) VALUES (
        pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), p_kind, p_account_id,
        p_workspace_id, p_connection_id, 'codex', p_subject_id
      ) ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
        DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
          session_owner_subject_id = EXCLUDED.session_owner_subject_id
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id uuid)
    RETURNS void
    LANGUAGE sql
    SET search_path = pg_catalog, %1$I, pg_temp
    AS $body$
      DELETE FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('codex_connection_owner', 'codex_reset_credit_fence')
        AND capability.account_id = p_account_id
    $body$
  $ddl$, data_schema);

  -- 3. The owner-scoped personal writer.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.connect_subscription_codex_personal(
      p_account_id uuid, p_workspace_id uuid, p_subject_id text,
      p_credential_encrypted text, p_provider_account_id text, p_plan_type text,
      p_provider_state jsonb, p_expires_at timestamptz, p_last_refresh_at timestamptz,
      p_account_email text, p_label text, p_connected_by_subject_id text
    ) RETURNS TABLE (outcome text, connection_id uuid, is_new boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      owner_membership uuid;
      existing_id uuid;
      new_id uuid;
      authority uuid;
      authority_gen bigint;
      personal_allowed boolean;
    BEGIN
      IF NOT opengeni_private.subscription_codex_writer_context(
          p_account_id, p_workspace_id, p_subject_id)
        OR p_credential_encrypted IS NULL OR length(p_credential_encrypted) = 0
        OR (p_provider_state IS NOT NULL AND jsonb_typeof(p_provider_state) <> 'object')
      THEN
        outcome := 'refused'; RETURN NEXT; RETURN;
      END IF;
      PERFORM opengeni_private.grant_subscription_codex_owner_capability(
        'codex_connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      -- Only the person, in their own Personal workspace.
      -- (No row lock: a lock would also need an UPDATE policy, and placement
      -- rechecks the membership and resource authority on every use.)
      SELECT membership.id INTO owner_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id AND membership.subject_id = p_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.personal_workspace_id = p_workspace_id;
      IF owner_membership IS NULL THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        outcome := 'not_personal_workspace'; RETURN NEXT; RETURN;
      END IF;
      personal_allowed := coalesce((subscription_effective_settings(p_account_id, p_workspace_id)
        #>> '{values,personalConnectionsAllowed}')::boolean, false);
      IF NOT personal_allowed THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        outcome := 'personal_connections_disabled'; RETURN NEXT; RETURN;
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-personal-authority:' || p_account_id::text || ':' || owner_membership::text, 0));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-connect:' || p_account_id::text || ':codex:' || owner_membership::text
          || ':' || coalesce(p_provider_account_id, ''), 0));
      IF p_provider_account_id IS NOT NULL THEN
        SELECT connection.id INTO existing_id
        FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.provider = 'codex'
          AND connection.kind = 'subscription' AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.provider_account_id = p_provider_account_id;
      END IF;
      IF existing_id IS NOT NULL THEN
        -- Credential replacement: the refresh key first, then the row lock
        -- (which also waits for a redemption's FOR SHARE).
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'subscription-refresh:' || existing_id::text, 0));
        PERFORM 1 FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.id = existing_id
        FOR UPDATE;
        UPDATE subscription_connections connection SET
          credential_encrypted = p_credential_encrypted, credential_format = 'v1',
          expires_at = p_expires_at, last_refresh_at = p_last_refresh_at,
          refresh_generation = connection.refresh_generation + 1,
          version = connection.version + 1, status = 'active', last_error = NULL,
          plan_type = coalesce(p_plan_type, connection.plan_type),
          provider_state = connection.provider_state || coalesce(p_provider_state, '{}'::jsonb),
          account_email = coalesce(p_account_email, connection.account_email),
          label = coalesce(connection.label, p_label),
          connected_by_subject_id = p_connected_by_subject_id, updated_at = clock_timestamp()
        WHERE connection.account_id = p_account_id AND connection.id = existing_id;
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        outcome := 'connected'; connection_id := existing_id; is_new := false;
        RETURN NEXT; RETURN;
      END IF;
      -- A new personal connection carries the owner's one current authority
      -- generation for personal Codex connections (1 for the first one), so
      -- frozen accepted authority keeps resolving to a single generation.
      SELECT max(resource.generation) INTO authority_gen
      FROM subscription_connections connection
      JOIN organization_user_resource_authorities resource
        ON resource.account_id = connection.account_id AND resource.id = connection.authority_id
       AND resource.status = 'active' AND resource.revoked_at IS NULL
      WHERE connection.account_id = p_account_id AND connection.provider = 'codex'
        AND connection.ownership = 'personal'
        AND connection.owner_organization_membership_id = owner_membership;
      IF authority_gen IS NULL THEN
        -- Authorities survive deletion of their resource. Never reuse an old
        -- epoch after disconnect-all: old accepted work must stay revoked.
        -- Other subscription providers may raise this high-water mark, which
        -- is safe; generations need only be monotone, not consecutive.
        SELECT coalesce(max(resource.generation), 0) + 1 INTO authority_gen
        FROM organization_user_resource_authorities resource
        WHERE resource.account_id = p_account_id
          AND resource.organization_membership_id = owner_membership
          AND resource.resource_kind = 'subscription_connection';
      END IF;
      new_id := gen_random_uuid();
      INSERT INTO organization_user_resource_authorities (
        account_id, organization_membership_id, resource_kind, resource_id,
        origin_workspace_id, generation, status
      ) VALUES (
        p_account_id, owner_membership, 'subscription_connection', new_id, p_workspace_id,
        authority_gen, 'active'
      ) RETURNING id INTO authority;
      INSERT INTO subscription_connections (
        id, account_id, provider, kind, provider_account_id, account_email, label, plan_type,
        credential_encrypted, credential_format, expires_at, last_refresh_at, status,
        ownership, owner_organization_membership_id, owner_subject_id, authority_id,
        authority_resource_kind, authority_generation, connected_by_subject_id, scope_kind,
        allow_personal_workspaces, managed_by_workspace_id, provider_state
      ) VALUES (
        new_id, p_account_id, 'codex', 'subscription', p_provider_account_id, p_account_email,
        p_label, p_plan_type, p_credential_encrypted, 'v1', p_expires_at, p_last_refresh_at,
        'active', 'personal', owner_membership, p_subject_id, authority,
        'subscription_connection', authority_gen, p_connected_by_subject_id, 'people', true, NULL,
        coalesce(p_provider_state, '{}'::jsonb)
      );
      PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
      outcome := 'connected'; connection_id := new_id; is_new := true;
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);

  -- 4. Disconnect one connection.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.disconnect_subscription_codex_connection(
      p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid
    ) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      owner_personal_workspace uuid;
    BEGIN
      IF NOT opengeni_private.subscription_codex_writer_context(
          p_account_id, p_workspace_id, p_subject_id) OR p_connection_id IS NULL THEN
        RETURN 'refused';
      END IF;
      PERFORM opengeni_private.grant_subscription_codex_owner_capability(
        'codex_connection_owner', p_account_id, p_workspace_id, p_subject_id, p_connection_id);
      -- Visible to an organization administrator (shared) or to its owner
      -- through the capability (personal); nothing else.
      SELECT connection.* INTO target FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription';
      IF NOT FOUND THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN 'not_found';
      END IF;
      IF target.ownership = 'shared' THEN
        -- SUB-OWN-04: delegated managers reconnect, rename and toggle
        -- allocation; only an organization administrator deletes.
        IF NOT opengeni_private.subscription_organization_admin(p_account_id) THEN
          PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
          RETURN 'forbidden';
        END IF;
      ELSE
        SELECT membership.personal_workspace_id INTO owner_personal_workspace
        FROM organization_memberships membership
        WHERE membership.account_id = p_account_id
          AND membership.id = target.owner_organization_membership_id
          AND membership.subject_id = p_subject_id;
        IF target.owner_subject_id IS DISTINCT FROM p_subject_id
          OR owner_personal_workspace IS DISTINCT FROM p_workspace_id THEN
          PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
          RETURN 'not_found';
        END IF;
      END IF;
      IF target.ownership = 'personal' THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
          'subscription-personal-authority:' || p_account_id::text || ':' ||
          target.owner_organization_membership_id::text, 0));
      END IF;
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-refresh:' || p_connection_id::text, 0));
      PERFORM 1 FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
      FOR UPDATE;
      -- An unresolved provider outcome in any workspace keeps the connection:
      -- its one upstream idempotency key must stay retryable.
      IF EXISTS (SELECT 1 FROM codex_reset_redemption_attempts attempt
        WHERE attempt.account_id = p_account_id AND attempt.credential_id = p_connection_id
          AND attempt.status = 'provider_started') THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN 'unresolved_redemption';
      END IF;
      BEGIN
        DELETE FROM subscription_leases lease
        WHERE lease.account_id = p_account_id AND lease.connection_id = p_connection_id
          AND lease.leased_until <= clock_timestamp();
        DELETE FROM subscription_operation_leases lease
        WHERE lease.account_id = p_account_id AND lease.connection_id = p_connection_id
          AND lease.leased_until <= clock_timestamp();
        DELETE FROM subscription_connections connection
        WHERE connection.account_id = p_account_id AND connection.id = p_connection_id;
      EXCEPTION WHEN foreign_key_violation THEN
        -- A chat or operation lease still names it (leases are RESTRICT).
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN 'in_use';
      END;
      IF target.ownership = 'personal' THEN
        UPDATE organization_user_resource_authorities resource
        SET status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE resource.account_id = p_account_id AND resource.id = target.authority_id
          AND resource.resource_id = p_connection_id AND resource.status <> 'revoked';
      END IF;
      PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
      RETURN 'removed';
    END
    $body$
  $ddl$, data_schema);

  -- 5. The acting person's own personal connections (no credential material).
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.manage_subscription_codex_personal(
      p_account_id uuid, p_workspace_id uuid, p_subject_id text, p_connection_id uuid,
      p_action text, p_label text, p_enabled boolean, p_expected_version integer
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE target subscription_connections%%ROWTYPE; result jsonb; mode text;
    BEGIN
      IF NOT opengeni_private.subscription_codex_writer_context(p_account_id, p_workspace_id, p_subject_id)
        OR p_action NOT IN ('resolve', 'rename', 'allocator', 'primary') OR p_connection_id IS NULL
      THEN RETURN NULL; END IF;
      PERFORM opengeni_private.grant_subscription_codex_owner_capability(
        'codex_connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      SELECT coalesce((SELECT alias.connection_id FROM subscription_connection_aliases alias
        WHERE alias.account_id = p_account_id AND alias.provider = 'codex'
          AND alias.alias_connection_id = p_connection_id), p_connection_id) INTO p_connection_id;
      SELECT connection.* INTO target FROM subscription_connections connection
      JOIN organization_memberships membership
        ON membership.account_id = connection.account_id AND membership.id = connection.owner_organization_membership_id
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.ownership = 'personal'
        AND connection.owner_subject_id = p_subject_id AND membership.subject_id = p_subject_id
        AND membership.personal_workspace_id = p_workspace_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL;
      IF NOT FOUND THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        RETURN NULL;
      END IF;
      result := jsonb_build_object('id', target.id, 'kind', 'unchanged');
      IF p_action <> 'resolve' THEN
        SELECT * INTO target FROM subscription_connections WHERE id = target.id FOR UPDATE;
        IF NOT FOUND THEN
          PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
          RETURN NULL;
        END IF;
      END IF;
      IF p_action = 'rename' THEN
        UPDATE subscription_connections SET label = nullif(left(btrim(p_label), 200), ''),
          version = version + 1, updated_at = clock_timestamp() WHERE id = target.id;
      ELSIF p_action = 'allocator' THEN
        IF p_enabled IS NULL OR p_expected_version IS NULL THEN
          PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
          RETURN NULL;
        END IF;
        IF target.allocator_enabled IS DISTINCT FROM p_enabled THEN
          IF target.allocator_version <> p_expected_version THEN
            result := result || '{"kind":"conflict"}'::jsonb;
          ELSE
            UPDATE subscription_connections SET allocator_enabled = p_enabled,
              allocator_version = allocator_version + 1, updated_at = clock_timestamp()
            WHERE id = target.id RETURNING * INTO target;
            result := result || '{"kind":"updated"}'::jsonb;
          END IF;
        END IF;
        result := result || jsonb_build_object('allocatorEnabled', target.allocator_enabled,
          'allocatorVersion', target.allocator_version, 'allocatorUpdatedAt', target.updated_at);
      ELSE
        mode := coalesce(subscription_effective_settings(p_account_id, p_workspace_id)
          #>> '{values,rotation,codex,mode}', 'spread');
        INSERT INTO subscription_settings (account_id, workspace_id, rotation, codex_primary_connection_id,
          updated_by_subject_id) VALUES (p_account_id, p_workspace_id,
          jsonb_build_object('codex', jsonb_build_object('mode', mode)), target.id, p_subject_id)
        ON CONFLICT (account_id, workspace_id) DO UPDATE SET
          rotation = coalesce(subscription_settings.rotation, '{}'::jsonb) || EXCLUDED.rotation,
          codex_primary_connection_id = EXCLUDED.codex_primary_connection_id,
          updated_by_subject_id = p_subject_id, version = subscription_settings.version + 1,
          updated_at = clock_timestamp();
      END IF;
      PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
      RETURN result;
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_personal_connections(
      p_account_id uuid, p_workspace_id uuid, p_subject_id text
    ) RETURNS TABLE (
      id uuid, label text, account_email text, plan_type text, provider_account_id text,
      status text, last_error text, allocator_enabled boolean, allocator_version integer,
      allowed_model_ids text[], connected_by_subject_id text, expires_at timestamptz,
      last_refresh_at timestamptz, provider_state jsonb, updated_at timestamptz, quota jsonb,
      quota_revision bigint, quota_observed_refresh_generation bigint,
      quota_updated_at timestamptz
    )
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    BEGIN
      IF NOT opengeni_private.subscription_codex_writer_context(
          p_account_id, p_workspace_id, p_subject_id) THEN
        RETURN;
      END IF;
      PERFORM opengeni_private.grant_subscription_codex_owner_capability(
        'codex_connection_owner', p_account_id, p_workspace_id, p_subject_id,
        '00000000-0000-0000-0000-000000000000'::uuid);
      -- The person must be an active member who may use this workspace.
      IF EXISTS (SELECT 1 FROM organization_memberships membership
          WHERE membership.account_id = p_account_id AND membership.subject_id = p_subject_id
            AND membership.status = 'active' AND membership.revoked_at IS NULL
            AND (membership.personal_workspace_id = p_workspace_id
              OR EXISTS (SELECT 1 FROM workspace_memberships grant_row
                WHERE grant_row.account_id = p_account_id
                  AND grant_row.workspace_id = p_workspace_id
                  AND grant_row.subject_id = p_subject_id))) THEN
        RETURN QUERY
        SELECT connection.id, connection.label, connection.account_email, connection.plan_type,
          connection.provider_account_id, connection.status, connection.last_error,
          connection.allocator_enabled, connection.allocator_version,
          connection.allowed_model_ids, connection.connected_by_subject_id,
          connection.expires_at, connection.last_refresh_at, connection.provider_state,
          connection.updated_at, quota.quota, quota.revision::bigint,
          quota.observed_refresh_generation, quota.updated_at
        FROM subscription_connections connection
        LEFT JOIN subscription_connection_quota quota
          ON quota.account_id = connection.account_id AND quota.connection_id = connection.id
        WHERE connection.account_id = p_account_id AND connection.provider = 'codex'
          AND connection.kind = 'subscription' AND connection.ownership = 'personal'
          AND connection.owner_subject_id = p_subject_id
        ORDER BY connection.created_at, connection.id;
      END IF;
      PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
    END
    $body$
  $ddl$, data_schema);

  -- 6. A scheduled task's frozen v2 value at creation (design 3.7, EP-T15):
  -- the same rule as acceptance. A task bound to a reusable session takes
  -- that session's acceptance value; otherwise a personal entry only when
  -- the exact requesting person creates it in their own Personal workspace,
  -- with their one current generation. Everything else is empty; nothing
  -- before the cutover. Firings copy it and never recompute it.
  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_task_authority_v2(
      p_account_id uuid, p_workspace_id uuid, p_reusable_session_id uuid,
      p_accepting_subject_id text
    ) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      request_subject text := nullif(current_setting('opengeni.subject_id', true), '');
      owner_membership uuid;
      minted_lifecycle boolean := false;
      generations bigint[];
      empty_v2 constant jsonb := '{"version":2,"personal":[]}'::jsonb;
    BEGIN
      IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      THEN RETURN NULL; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
          AND cutover.enabled
      ) THEN RETURN NULL; END IF;
      IF p_reusable_session_id IS NOT NULL THEN
        RETURN coalesce(opengeni_private.subscription_codex_acceptance_authority_v2(
          p_account_id, p_workspace_id, p_reusable_session_id, p_accepting_subject_id), empty_v2);
      END IF;
      IF p_accepting_subject_id IS NULL OR length(btrim(p_accepting_subject_id)) = 0
        OR request_subject IS DISTINCT FROM p_accepting_subject_id
      THEN RETURN empty_v2; END IF;

      INSERT INTO opengeni_private.subscription_runtime_capabilities (
        backend_pid, transaction_id, capability_kind, account_id
      ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
      ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING
      RETURNING true INTO minted_lifecycle;
      minted_lifecycle := coalesce(minted_lifecycle, false);

      SELECT membership.id INTO owner_membership
      FROM organization_memberships membership
      WHERE membership.account_id = p_account_id AND membership.subject_id = p_accepting_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.personal_workspace_id = p_workspace_id;
      IF owner_membership IS NOT NULL THEN
        SELECT coalesce(array_agg(DISTINCT authority.generation ORDER BY authority.generation), '{}')
          INTO generations
        FROM subscription_connections connection
        JOIN organization_user_resource_authorities authority
          ON authority.id = connection.authority_id
          AND authority.account_id = connection.account_id
          AND authority.resource_kind = 'subscription_connection'
          AND authority.resource_id = connection.id
        WHERE connection.account_id = p_account_id
          AND connection.provider = 'codex' AND connection.kind = 'subscription'
          AND connection.ownership = 'personal'
          AND connection.owner_organization_membership_id = owner_membership
          AND connection.owner_subject_id = p_accepting_subject_id
          AND connection.status IN ('active', 'error')
          AND connection.authority_generation = authority.generation
          AND authority.organization_membership_id = owner_membership
          AND authority.status = 'active' AND authority.revoked_at IS NULL;
      END IF;
      IF minted_lifecycle THEN
        DELETE FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
      END IF;
      IF owner_membership IS NULL OR cardinality(generations) <> 1 THEN RETURN empty_v2; END IF;
      RETURN jsonb_build_object(
        'version', 2,
        'personal', jsonb_build_array(jsonb_build_object(
          'provider', 'codex',
          'ownerMembershipId', owner_membership::text,
          'authorityGeneration', generations[1]
        ))
      );
    END
    $body$
  $ddl$, data_schema);

  -- 7. Reset-credit redemption: authority and the cross-workspace fence.
  EXECUTE format($ddl$
    CREATE OR REPLACE FUNCTION opengeni_private.subscription_codex_reset_authority(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text
    ) RETURNS TABLE (status text, authorized boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      target subscription_connections%%ROWTYPE;
      locked boolean := false;
    BEGIN
      IF p_account_id IS NULL OR p_workspace_id IS NULL OR p_connection_id IS NULL
        OR p_subject_id IS NULL
        OR p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
        OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        OR p_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.subject_id', true), '')
      THEN RETURN; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM subscription_provider_cutovers cutover
        WHERE cutover.account_id = p_account_id AND cutover.provider = 'codex'
          AND cutover.enabled
      ) THEN RETURN; END IF;
      -- A connection the requesting workspace manages (its administrators or
      -- an organization administrator), or an organization-managed one (an
      -- organization administrator only). Read under the caller's own
      -- row-level security.
      SELECT connection.* INTO target
      FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.kind = 'subscription'
        AND connection.ownership = 'shared'
        AND (connection.managed_by_workspace_id = p_workspace_id
          OR connection.managed_by_workspace_id IS NULL);
      IF NOT FOUND THEN RETURN; END IF;
      -- FOR SHARE also applies the connection's UPDATE policies, which admit
      -- exactly an organization administrator or an administrator of the
      -- managing workspace; anyone else gets no lock and no authority.
      PERFORM 1 FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
      FOR SHARE;
      locked := FOUND;
      status := target.status;
      authorized := locked AND (
        opengeni_private.subscription_organization_admin(p_account_id)
        OR (target.managed_by_workspace_id = p_workspace_id AND EXISTS (
          SELECT 1 FROM workspace_memberships manager
          WHERE manager.account_id = p_account_id
            AND manager.workspace_id = p_workspace_id
            AND manager.subject_id = p_subject_id
            AND manager.role = 'admin'
        ))
      );
      RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);

  EXECUTE format($ddl$
    CREATE FUNCTION opengeni_private.subscription_codex_reset_credit_fence(
      p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_subject_id text,
      p_credit_id text, p_attempt_id uuid
    ) RETURNS TABLE (outcome text, attempt_workspace_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, %1$I, opengeni_private, pg_temp
    AS $body$
    DECLARE
      allowed boolean := false;
      holder codex_reset_redemption_attempts%%ROWTYPE;
    BEGIN
      SELECT authority.authorized INTO allowed
      FROM opengeni_private.subscription_codex_reset_authority(
        p_account_id, p_workspace_id, p_connection_id, p_subject_id) authority;
      IF allowed IS DISTINCT FROM true OR p_credit_id IS NULL OR p_attempt_id IS NULL THEN
        outcome := 'refused'; RETURN NEXT; RETURN;
      END IF;
      -- One provider credit of one connection, whichever workspace files it.
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'subscription-reset-credit:' || p_connection_id::text || ':' || p_credit_id, 0));
      PERFORM opengeni_private.grant_subscription_codex_owner_capability(
        'codex_reset_credit_fence', p_account_id, p_workspace_id, p_subject_id, p_connection_id);
      -- An expired pre-provider claim has no uncertain upstream effect. Like
      -- the same-workspace claim path, retire it under the global credit lock.
      DELETE FROM codex_reset_redemption_attempts attempt
      WHERE attempt.account_id = p_account_id AND attempt.credential_id = p_connection_id
        AND attempt.credit_id = p_credit_id AND attempt.workspace_id <> p_workspace_id
        AND attempt.status = 'processing' AND attempt.claim_expires_at <= now();
      SELECT attempt.* INTO holder FROM codex_reset_redemption_attempts attempt
      WHERE attempt.account_id = p_account_id AND attempt.credential_id = p_connection_id
        AND attempt.credit_id = p_credit_id AND attempt.workspace_id <> p_workspace_id
        AND (attempt.status <> 'completed' OR attempt.outcome IN ('reset', 'alreadyRedeemed'))
      ORDER BY attempt.created_at, attempt.id
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        outcome := 'clear'; RETURN NEXT; RETURN;
      END IF;
      -- Recovery from another workspace: the same person's same logical
      -- attempt, with no live claim, moves to this workspace and keeps its
      -- one upstream idempotency key, status and outcome.
      IF holder.id = p_attempt_id AND holder.subject_id = p_subject_id
        AND (holder.claim_expires_at IS NULL OR holder.claim_expires_at <= now()) THEN
        UPDATE codex_reset_redemption_attempts attempt
        SET workspace_id = p_workspace_id, updated_at = now()
        WHERE attempt.account_id = p_account_id AND attempt.id = holder.id;
        PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
        outcome := 'refiled'; attempt_workspace_id := holder.workspace_id; RETURN NEXT; RETURN;
      END IF;
      PERFORM opengeni_private.drop_subscription_codex_owner_capabilities(p_account_id);
      outcome := 'held_elsewhere'; attempt_workspace_id := holder.workspace_id; RETURN NEXT;
    END
    $body$
  $ddl$, data_schema);
END
$codex_owner_routines$;

REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_writer_context(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_revision_authority_v2(uuid, uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.manage_subscription_codex_personal(uuid, uuid, text, uuid, text, text, boolean, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.grant_subscription_codex_owner_capability(text, uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.drop_subscription_codex_owner_capabilities(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.connect_subscription_codex_personal(
  uuid, uuid, text, text, text, text, jsonb, timestamptz, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.disconnect_subscription_codex_connection(uuid, uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_personal_connections(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_reset_authority(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_reset_credit_fence(
  uuid, uuid, uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION opengeni_private.subscription_codex_task_authority_v2(
  uuid, uuid, uuid, text) FROM PUBLIC;
DO $grant_codex_writers$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_revision_authority_v2(uuid, uuid, uuid, bigint) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.manage_subscription_codex_personal(uuid, uuid, text, uuid, text, text, boolean, integer) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.connect_subscription_codex_personal(
      uuid, uuid, text, text, text, text, jsonb, timestamptz, timestamptz, text, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.disconnect_subscription_codex_connection(
      uuid, uuid, text, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_personal_connections(
      uuid, uuid, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_reset_authority(
      uuid, uuid, uuid, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_reset_credit_fence(
      uuid, uuid, uuid, text, text, uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_codex_task_authority_v2(
      uuid, uuid, uuid, text) TO opengeni_app;
    -- Policy and capability internals are owner-only; the trigger function
    -- fires without the inserting role holding EXECUTE.
    REVOKE EXECUTE ON FUNCTION opengeni_private.subscription_codex_writer_context(
      uuid, uuid, text) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION opengeni_private.grant_subscription_codex_owner_capability(
      text, uuid, uuid, text, uuid) FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION opengeni_private.drop_subscription_codex_owner_capabilities(uuid)
      FROM opengeni_app;
    REVOKE EXECUTE ON FUNCTION opengeni_private.derive_scheduled_revision_subscription_authority()
      FROM opengeni_app;
  END IF;
END
$grant_codex_writers$;
