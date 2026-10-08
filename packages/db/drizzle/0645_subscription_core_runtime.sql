-- deployment-mode: maintenance
-- Runtime posture is an exact relation/grant contract; deploy after old binaries drain.

ALTER TABLE subscription_capacity_waiters
  ADD COLUMN waiter_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN observed_wake_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN next_check_at timestamptz,
  ADD COLUMN blocked_turn_generation bigint;

CREATE UNIQUE INDEX subscription_capacity_waiters_account_waiter_id_uq
  ON subscription_capacity_waiters(account_id, waiter_id);
CREATE INDEX subscription_capacity_waiters_due_idx
  ON subscription_capacity_waiters(provider, next_check_at, wake_revision)
  WHERE next_check_at IS NOT NULL;

CREATE TABLE subscription_capacity_wake_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  waiter_id uuid NOT NULL,
  generation bigint NOT NULL,
  wake_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  claim_generation bigint NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  FOREIGN KEY (account_id, workspace_id) REFERENCES workspaces(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, waiter_id)
    REFERENCES subscription_capacity_waiters(account_id, waiter_id) ON DELETE CASCADE,
  CONSTRAINT subscription_capacity_wake_outbox_identity_uq
    UNIQUE (account_id, waiter_id, generation, wake_revision),
  CHECK (generation > 0 AND wake_revision > 0 AND attempt_count >= 0 AND claim_generation >= 0)
);
CREATE INDEX subscription_capacity_wake_outbox_due_idx
  ON subscription_capacity_wake_outbox(next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

CREATE TABLE subscription_connection_assignment_policies (
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  inference_pool text NOT NULL,
  allocator_enabled boolean NOT NULL DEFAULT true,
  allowed_model_ids text[],
  excluded_models text[] NOT NULL DEFAULT '{}',
  managed_by_workspace_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, connection_id, workspace_id, inference_pool),
  FOREIGN KEY (account_id, connection_id)
    REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, workspace_id)
    REFERENCES workspaces(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, managed_by_workspace_id)
    REFERENCES workspaces(account_id, id) ON DELETE SET NULL (managed_by_workspace_id),
  CHECK (inference_pool IN ('workspace', 'organization'))
);
CREATE INDEX subscription_connection_assignment_policies_pool_idx
  ON subscription_connection_assignment_policies(account_id, workspace_id, inference_pool, connection_id);
CREATE INDEX subscription_connection_assignment_policies_manager_idx
  ON subscription_connection_assignment_policies(account_id, managed_by_workspace_id)
  WHERE managed_by_workspace_id IS NOT NULL;

CREATE TABLE subscription_operation_leases (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  operation_kind text NOT NULL,
  session_id uuid,
  turn_id uuid,
  provider text NOT NULL,
  connection_id uuid NOT NULL,
  holder_id text NOT NULL,
  generation bigint NOT NULL,
  leased_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, operation_id),
  FOREIGN KEY (account_id, workspace_id) REFERENCES workspaces(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, provider, connection_id)
    REFERENCES subscription_connections(account_id, provider, id) ON DELETE RESTRICT,
  CHECK (provider IN ('codex', 'claude', 'xai')),
  CHECK (operation_kind IN ('image', 'realtime', 'transcription')),
  CHECK (length(btrim(holder_id)) BETWEEN 1 AND 256 AND generation > 0),
  CHECK (turn_id IS NULL OR session_id IS NOT NULL),
  CHECK (session_id IS NOT NULL OR (turn_id IS NULL AND operation_kind = 'transcription'))
);
CREATE INDEX subscription_operation_leases_connection_expiry_idx
  ON subscription_operation_leases(account_id, connection_id, leased_until);
CREATE INDEX subscription_operation_leases_session_idx
  ON subscription_operation_leases(account_id, workspace_id, session_id, turn_id)
  WHERE session_id IS NOT NULL;

CREATE FUNCTION opengeni_private.guard_subscription_operation_lease_reference()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
DECLARE
  target subscription_connections%ROWTYPE;
  session_owner text;
  turn_human text;
  visible boolean;
  personal_authorized boolean := false;
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
    SELECT session.owner_subject_id INTO session_owner
    FROM sessions session
    WHERE session.account_id = NEW.account_id AND session.workspace_id = NEW.workspace_id
      AND session.id = NEW.session_id;
    IF session_owner IS NULL THEN
      RAISE EXCEPTION 'subscription operation session owner is unavailable'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.turn_id IS NOT NULL THEN
      SELECT turn.initiating_human_subject_id INTO turn_human
      FROM session_turns turn
      WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
        AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'subscription operation turn is not in the referenced session'
          USING ERRCODE = '42501';
      END IF;
      IF turn_human IS NULL THEN
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
      IF turn_human IS NULL OR turn_human IS DISTINCT FROM session_owner THEN
        RAISE EXCEPTION 'session-bound subscription operation requires its accepted owner context'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL AND NEW.turn_id IS NOT NULL THEN
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
  IF target.ownership = 'personal' THEN
    IF NEW.session_id IS NULL OR NEW.turn_id IS NULL
      OR NOT personal_authorized
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
$function$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_operation_lease_reference() FROM PUBLIC;
CREATE TRIGGER subscription_operation_leases_connection_reference_guard
  BEFORE INSERT OR UPDATE OF account_id, workspace_id, operation_id, attempt_id, operation_kind,
    session_id, turn_id, connection_id, provider, holder_id, generation
  ON subscription_operation_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_operation_lease_reference();

ALTER TABLE subscription_connection_assignment_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_connection_assignment_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_connection_assignment_policy_runtime_read
  ON subscription_connection_assignment_policies FOR SELECT
  USING (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_assignment_policies.account_id
        AND connection.id = subscription_connection_assignment_policies.connection_id
        AND opengeni_private.subscription_connection_visible(
          connection.account_id, subscription_connection_assignment_policies.workspace_id,
          connection.id, connection.ownership, connection.scope_kind,
          connection.owner_organization_membership_id, connection.owner_subject_id, connection.provider
        )
    )
  );
CREATE POLICY subscription_connection_assignment_policy_manage
  ON subscription_connection_assignment_policies FOR ALL
  USING (
    opengeni_private.subscription_organization_admin(account_id)
    OR (workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND managed_by_workspace_id = workspace_id
      AND opengeni_private.subscription_apps_designation_manage_allowed(
        account_id, workspace_id, connection_id
      )
      AND EXISTS (
        SELECT 1 FROM workspace_memberships manager
        WHERE manager.account_id = subscription_connection_assignment_policies.account_id
          AND manager.workspace_id = subscription_connection_assignment_policies.workspace_id
          AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          AND manager.role = 'admin'
      ))
  )
  WITH CHECK (
    opengeni_private.subscription_organization_admin(account_id)
    OR (workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
      AND managed_by_workspace_id = workspace_id
      AND opengeni_private.subscription_apps_designation_manage_allowed(
        account_id, workspace_id, connection_id
      )
      AND EXISTS (
        SELECT 1 FROM workspace_memberships manager
        WHERE manager.account_id = subscription_connection_assignment_policies.account_id
          AND manager.workspace_id = subscription_connection_assignment_policies.workspace_id
          AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
          AND manager.role = 'admin'
      ))
  );

ALTER TABLE subscription_operation_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_operation_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_operation_leases_scope
  ON subscription_operation_leases FOR ALL
  USING (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND (session_id IS NULL OR session_reference_visible(account_id, workspace_id, session_id))
  )
  WITH CHECK (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND (session_id IS NULL OR session_reference_visible(account_id, workspace_id, session_id))
  );

ALTER TABLE subscription_capacity_wake_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_capacity_wake_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY subscription_capacity_wake_outbox_service
  ON subscription_capacity_wake_outbox FOR ALL
  USING (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND nullif(current_setting('opengeni.subject_id', true), '') IS NULL
  )
  WITH CHECK (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND nullif(current_setting('opengeni.subject_id', true), '') IS NULL
  );
CREATE POLICY subscription_connection_aliases_runtime_read
  ON subscription_connection_aliases FOR SELECT
  USING (
    account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND provider IN ('codex', 'claude', 'xai')
    AND EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = subscription_connection_aliases.account_id
        AND connection.provider = subscription_connection_aliases.provider
        AND connection.id = subscription_connection_aliases.connection_id
        AND opengeni_private.subscription_connection_visible(
          connection.account_id,
          nullif(current_setting('opengeni.workspace_id', true), '')::uuid,
          connection.id, connection.ownership, connection.scope_kind,
          connection.owner_organization_membership_id, connection.owner_subject_id, connection.provider
        )
    )
  );

DO $subscription_runtime_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      subscription_connection_assignment_policies, subscription_operation_leases,
      subscription_capacity_wake_outbox TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.guard_subscription_operation_lease_reference() TO opengeni_app;
  END IF;
END
$subscription_runtime_grants$;

DO $subscription_runtime_search_path$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format(
    'ALTER FUNCTION opengeni_private.guard_subscription_operation_lease_reference() SET search_path = pg_catalog, %I, opengeni_private, pg_temp',
    data_schema
  );
END
$subscription_runtime_search_path$;
