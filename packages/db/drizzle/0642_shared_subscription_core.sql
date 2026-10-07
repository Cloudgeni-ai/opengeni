-- deployment-mode: rolling
-- M2 of the provider-neutral subscription core. This migration is additive and
-- intentionally creates empty storage: no production reader or writer is
-- switched to these relations in this step.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10min';

CREATE TABLE opengeni_private.subscription_runtime_capabilities (
  backend_pid integer NOT NULL,
  transaction_id xid8 NOT NULL,
  capability_kind text NOT NULL,
  account_id uuid NOT NULL,
  workspace_id uuid,
  session_id uuid,
  turn_id uuid,
  connection_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,
  provider text,
  session_owner_subject_id text,
  turn_human_subject_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (backend_pid, transaction_id, capability_kind, account_id, connection_id),
  CONSTRAINT subscription_runtime_capabilities_kind_chk
    CHECK (capability_kind IN ('personal_access', 'session_access', 'lifecycle')),
  CONSTRAINT subscription_runtime_capabilities_provider_chk CHECK (
    (capability_kind = 'personal_access' AND provider IN ('codex','claude','xai')
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'session_access' AND provider IS NULL
      AND session_id IS NOT NULL AND turn_id IS NOT NULL
      AND session_owner_subject_id IS NOT NULL AND turn_human_subject_id IS NOT NULL)
    OR (capability_kind = 'lifecycle' AND provider IS NULL AND session_id IS NULL
      AND turn_id IS NULL AND session_owner_subject_id IS NULL AND turn_human_subject_id IS NULL)
  )
);
REVOKE ALL ON TABLE opengeni_private.subscription_runtime_capabilities FROM PUBLIC;
DO $revoke_capability$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    REVOKE ALL ON TABLE opengeni_private.subscription_runtime_capabilities FROM opengeni_app;
  END IF;
END
$revoke_capability$;

-- Resource identity is immutable, but authority generation advances on leave.
-- Do not make that mutable fence part of a physical foreign key, or offboarding
-- cannot revoke retained provider credentials while preserving them for cleanup.
ALTER TABLE codex_subscription_credentials
  ADD CONSTRAINT codex_credentials_subscription_resource_fk
  FOREIGN KEY (organization_user_resource_authority_id, account_id,
    owner_organization_membership_id, organization_user_resource_kind, id)
  REFERENCES organization_user_resource_authorities
    (id, account_id, organization_membership_id, resource_kind, resource_id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE codex_subscription_credentials
  DROP CONSTRAINT codex_credentials_user_authority_fk;

ALTER TABLE claude_subscription_credentials
  ADD CONSTRAINT claude_credentials_subscription_resource_fk
  FOREIGN KEY (organization_user_resource_authority_id, account_id,
    owner_organization_membership_id, organization_user_resource_kind, id)
  REFERENCES organization_user_resource_authorities
    (id, account_id, organization_membership_id, resource_kind, resource_id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE claude_subscription_credentials
  DROP CONSTRAINT claude_subscription_credentials_user_authority_fk;

ALTER TABLE xai_subscription_credentials
  ADD CONSTRAINT xai_credentials_subscription_resource_fk
  FOREIGN KEY (organization_user_resource_authority_id, account_id,
    owner_organization_membership_id, organization_user_resource_kind, id)
  REFERENCES organization_user_resource_authorities
    (id, account_id, organization_membership_id, resource_kind, resource_id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE xai_subscription_credentials
  DROP CONSTRAINT xai_subscription_credentials_user_authority_fk;

CREATE TABLE subscription_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  kind text NOT NULL DEFAULT 'subscription',
  provider_account_id text,
  account_email text,
  label text,
  plan_type text,
  credential_encrypted text NOT NULL,
  credential_format text NOT NULL DEFAULT 'v1',
  expires_at timestamptz,
  last_refresh_at timestamptz,
  refresh_generation bigint NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  allocator_enabled boolean NOT NULL DEFAULT true,
  allocator_version integer NOT NULL DEFAULT 1,
  excluded_models text[] NOT NULL DEFAULT '{}',
  allowed_model_ids text[],
  ownership text NOT NULL DEFAULT 'shared',
  owner_organization_membership_id uuid,
  owner_subject_id text,
  authority_id uuid,
  authority_resource_kind text,
  authority_generation bigint,
  connected_by_subject_id text,
  scope_kind text NOT NULL DEFAULT 'workspaces',
  allow_personal_workspaces boolean NOT NULL DEFAULT true,
  managed_by_workspace_id uuid,
  provider_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_connections_provider_chk CHECK (provider IN ('codex', 'claude', 'xai')),
  CONSTRAINT subscription_connections_kind_chk CHECK (kind IN ('subscription', 'api_key')),
  CONSTRAINT subscription_connections_status_chk CHECK (status IN ('active', 'needs_relogin', 'error', 'disabled')),
  CONSTRAINT subscription_connections_ownership_chk CHECK (ownership IN ('shared', 'personal')),
  CONSTRAINT subscription_connections_scope_chk CHECK (scope_kind IN ('organization', 'workspaces', 'people')),
  CONSTRAINT subscription_connections_owner_shape_chk CHECK (
    (ownership = 'shared' AND owner_organization_membership_id IS NULL AND owner_subject_id IS NULL
      AND authority_id IS NULL AND authority_resource_kind IS NULL AND authority_generation IS NULL)
    OR (ownership = 'personal' AND scope_kind = 'people'
      AND owner_organization_membership_id IS NOT NULL AND owner_subject_id IS NOT NULL
      AND authority_id IS NOT NULL AND authority_resource_kind = 'subscription_connection'
      AND authority_generation > 0)
  ),
  CONSTRAINT subscription_connections_provider_account_chk CHECK (
    provider_account_id IS NULL OR length(btrim(provider_account_id)) BETWEEN 1 AND 512
  ),
  CONSTRAINT subscription_connections_versions_chk CHECK (
    version > 0 AND allocator_version > 0 AND refresh_generation > 0
  ),
  CONSTRAINT subscription_connections_connected_by_chk CHECK (
    connected_by_subject_id IS NULL OR length(btrim(connected_by_subject_id)) BETWEEN 1 AND 1024
  ),
  CONSTRAINT subscription_connections_json_shape_chk CHECK (
    jsonb_typeof(provider_state) = 'object'
    AND array_position(excluded_models, '') IS NULL
    AND (allowed_model_ids IS NULL OR array_position(allowed_model_ids, '') IS NULL)
  ),
  CONSTRAINT subscription_connections_membership_fk FOREIGN KEY (owner_organization_membership_id, account_id)
    REFERENCES organization_memberships(id, account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_connections_workspace_fk FOREIGN KEY (managed_by_workspace_id, account_id)
    REFERENCES workspaces(id, account_id) ON DELETE SET NULL (managed_by_workspace_id),
  CONSTRAINT subscription_connections_authority_fk FOREIGN KEY (
    authority_id, account_id, owner_organization_membership_id,
    authority_resource_kind, id
  ) REFERENCES organization_user_resource_authorities(
    id, account_id, organization_membership_id, resource_kind, resource_id
  ) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX subscription_connections_provider_owner_account_uq
  ON subscription_connections (account_id, provider, provider_account_id,
    COALESCE(owner_organization_membership_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE provider_account_id IS NOT NULL;
CREATE UNIQUE INDEX subscription_connections_account_id_uq ON subscription_connections(account_id, id);
CREATE UNIQUE INDEX subscription_connections_account_provider_id_uq
  ON subscription_connections(account_id, provider, id);
CREATE INDEX subscription_connections_placement_idx
  ON subscription_connections(account_id, provider, status, allocator_enabled, ownership, scope_kind);
CREATE INDEX subscription_connections_manager_idx
  ON subscription_connections(account_id, managed_by_workspace_id) WHERE managed_by_workspace_id IS NOT NULL;

CREATE TABLE subscription_connection_workspaces (
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  PRIMARY KEY (connection_id, workspace_id),
  FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE
);
CREATE INDEX subscription_connection_workspaces_placement_idx
  ON subscription_connection_workspaces(account_id, workspace_id, connection_id);

CREATE TABLE subscription_connection_people (
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  organization_membership_id uuid NOT NULL,
  PRIMARY KEY (connection_id, organization_membership_id),
  FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE CASCADE
);
CREATE INDEX subscription_connection_people_placement_idx
  ON subscription_connection_people(account_id, organization_membership_id, connection_id);

CREATE TABLE subscription_connection_aliases (
  account_id uuid NOT NULL,
  provider text NOT NULL,
  alias_connection_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider, alias_connection_id),
  FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE,
  CHECK (provider IN ('codex', 'claude', 'xai')),
  CHECK (alias_connection_id <> connection_id)
);

CREATE TABLE subscription_connection_quota (
  account_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  quota jsonb NOT NULL DEFAULT '{"windows":[],"modelCooldowns":{}}'::jsonb,
  selection_count bigint NOT NULL DEFAULT 0,
  last_selected_at timestamptz,
  observed_refresh_generation bigint,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id),
  FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(quota) = 'object' AND jsonb_typeof(quota->'windows') = 'array'
    AND jsonb_typeof(quota->'modelCooldowns') = 'object'
    AND selection_count >= 0 AND revision > 0),
  CHECK (observed_refresh_generation IS NULL OR observed_refresh_generation > 0)
);

CREATE TABLE subscription_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id uuid,
  codex_primary_connection_id uuid,
  claude_primary_connection_id uuid,
  xai_primary_connection_id uuid,
  rotation jsonb,
  providers jsonb,
  cross_provider_failover boolean,
  fallback_order jsonb,
  personal_connections_allowed boolean,
  personal_fallback_allowed boolean,
  locked_settings text[] NOT NULL DEFAULT '{}',
  version bigint NOT NULL DEFAULT 1,
  updated_by_subject_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, codex_primary_connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE SET NULL (codex_primary_connection_id),
  FOREIGN KEY (account_id, claude_primary_connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE SET NULL (claude_primary_connection_id),
  FOREIGN KEY (account_id, xai_primary_connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE SET NULL (xai_primary_connection_id),
  UNIQUE NULLS NOT DISTINCT (account_id, workspace_id),
  CHECK (version > 0),
  CHECK ((rotation IS NULL OR jsonb_typeof(rotation) = 'object')
    AND (providers IS NULL OR jsonb_typeof(providers) = 'object')),
  CHECK (fallback_order IS NULL OR jsonb_typeof(fallback_order) = 'object'),
  CHECK (workspace_id IS NULL OR cardinality(locked_settings) = 0),
  CHECK (workspace_id IS NOT NULL OR (rotation IS NOT NULL AND providers IS NOT NULL
    AND cross_provider_failover IS NOT NULL AND fallback_order IS NOT NULL
    AND personal_connections_allowed IS NOT NULL AND personal_fallback_allowed IS NOT NULL))
);
CREATE INDEX subscription_settings_workspace_idx ON subscription_settings(account_id, workspace_id) WHERE workspace_id IS NOT NULL;

CREATE TABLE subscription_person_preferences (
  account_id uuid NOT NULL,
  organization_membership_id uuid NOT NULL,
  personal_fallback_opt_in boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, organization_membership_id),
  FOREIGN KEY (organization_membership_id, account_id) REFERENCES organization_memberships(id, account_id) ON DELETE CASCADE,
  CHECK (version > 0)
);

CREATE TABLE subscription_session_bindings (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  provider text NOT NULL,
  connection_id uuid,
  model_id text NOT NULL,
  choice text NOT NULL DEFAULT 'automatic',
  only_this_model boolean NOT NULL DEFAULT false,
  last_model_call_at timestamptz,
  last_switch_reason text,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE SET NULL (connection_id),
  CHECK (provider IN ('codex', 'claude', 'xai') AND choice IN ('automatic', 'explicit') AND version > 0),
  CHECK (length(btrim(model_id)) BETWEEN 1 AND 512),
  CHECK (last_switch_reason IS NULL OR last_switch_reason IN ('initial','reselected_cold','failover_same_provider','failover_cross_provider','return_to_preferred','explicit_choice','revoked')),
  -- A deleted explicit target remains an explicit, unavailable pin. It must
  -- not silently become an automatic account choice through ON DELETE SET NULL.
  CHECK (choice IN ('automatic', 'explicit'))
);
CREATE INDEX subscription_session_bindings_connection_idx ON subscription_session_bindings(account_id, provider, connection_id);

CREATE TABLE subscription_leases (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  holder_id text NOT NULL,
  generation bigint NOT NULL,
  leased_until timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, turn_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CHECK (provider IN ('codex', 'claude', 'xai') AND length(btrim(holder_id)) BETWEEN 1 AND 256 AND generation > 0)
);
CREATE INDEX subscription_leases_connection_expiry_idx ON subscription_leases(account_id, connection_id, leased_until);

CREATE TABLE subscription_capacity_waiters (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  provider text NOT NULL,
  wait_reason text NOT NULL,
  policy_hash text,
  reset_kind text,
  refresh_attempt integer NOT NULL DEFAULT 0,
  resumed_update_id uuid,
  earliest_reset_at timestamptz,
  generation bigint NOT NULL DEFAULT 1,
  wake_revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  CHECK (provider IN ('codex', 'claude', 'xai') AND length(btrim(wait_reason)) BETWEEN 1 AND 128),
  CHECK (refresh_attempt >= 0 AND generation > 0 AND wake_revision > 0)
);
CREATE INDEX subscription_capacity_waiters_recovery_idx ON subscription_capacity_waiters(provider, earliest_reset_at, wake_revision);

CREATE TABLE subscription_turn_failures (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider text NOT NULL,
  failure_kind text NOT NULL,
  recovery_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, turn_id, connection_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, session_id) REFERENCES sessions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, turn_id) REFERENCES session_turns(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, provider, connection_id) REFERENCES subscription_connections(account_id, provider, id) ON DELETE CASCADE,
  CHECK (provider IN ('codex', 'claude', 'xai') AND length(btrim(failure_kind)) BETWEEN 1 AND 128),
  CHECK (jsonb_typeof(recovery_evidence) = 'object')
);
CREATE INDEX subscription_turn_failures_turn_idx ON subscription_turn_failures(account_id, turn_id, provider);

CREATE TABLE subscription_apps_designations (
  account_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  updated_by_subject_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id),
  FOREIGN KEY (workspace_id, account_id) REFERENCES workspaces(id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id) ON DELETE CASCADE,
  CHECK (version > 0 AND length(btrim(updated_by_subject_id)) BETWEEN 1 AND 1024)
);
CREATE INDEX subscription_apps_designations_connection_idx ON subscription_apps_designations(account_id, connection_id);

CREATE TABLE subscription_provider_cutovers (
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  updated_by_subject_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider),
  CHECK (provider IN ('codex', 'claude', 'xai') AND version > 0)
);

ALTER TABLE model_call_facts ADD COLUMN connection_id uuid;
ALTER TABLE model_call_facts ADD CONSTRAINT model_call_facts_subscription_connection_fk
  FOREIGN KEY (account_id, connection_id) REFERENCES subscription_connections(account_id, id)
  ON DELETE SET NULL (connection_id) NOT VALID;

-- The one common personal-row authorization seam. Callers must first establish
-- an exact transaction capability; the two human identities are explicit and
-- may not be inferred from an empty subject or an arbitrary workspace.
CREATE FUNCTION opengeni_private.subscription_personal_connection_visible(
  p_account_id uuid, p_connection_id uuid, p_owner_membership_id uuid,
  p_session_owner_subject_id text, p_turn_human_subject_id text, p_provider text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
  SELECT p_session_owner_subject_id IS NOT NULL
    AND p_turn_human_subject_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'personal_access'
        AND capability.account_id = p_account_id
        AND capability.connection_id = p_connection_id
        AND capability.provider = p_provider
        AND capability.session_owner_subject_id = p_session_owner_subject_id
        AND capability.turn_human_subject_id = p_turn_human_subject_id
    )
    AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.id = p_owner_membership_id AND membership.account_id = p_account_id
        AND membership.subject_id = p_session_owner_subject_id AND membership.status = 'active'
    )
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_personal_connection_visible(uuid, uuid, uuid, text, text, text) FROM PUBLIC;

-- People-scoped shared connections are authorized for the exact live session
-- and turn, not by a caller-provided subject GUC alone.
CREATE FUNCTION opengeni_private.authorize_subscription_session_access(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_session_owner_subject_id text, p_turn_human_subject_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_turn_human_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
    OR p_session_owner_subject_id IS NULL OR p_turn_human_subject_id IS NULL
  THEN RETURN false; END IF;
  INSERT INTO opengeni_private.subscription_runtime_capabilities (
    backend_pid, transaction_id, capability_kind, account_id, workspace_id,
    session_id, turn_id, connection_id, session_owner_subject_id, turn_human_subject_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'session_access',
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_session_id,
    p_session_owner_subject_id, p_turn_human_subject_id)
  ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
  DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
    turn_id = EXCLUDED.turn_id,
    session_owner_subject_id = EXCLUDED.session_owner_subject_id,
    turn_human_subject_id = EXCLUDED.turn_human_subject_id;
  IF NOT EXISTS (
      SELECT 1 FROM sessions session
      JOIN session_turns turn ON turn.account_id = session.account_id
        AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
      JOIN organization_memberships membership ON membership.account_id = session.account_id
        AND membership.subject_id = session.owner_subject_id
      WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
        AND session.id = p_session_id AND session.owner_subject_id = p_session_owner_subject_id
        AND turn.id = p_turn_id AND turn.initiating_human_subject_id = p_turn_human_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND session_reference_visible(p_account_id, p_workspace_id, p_session_id)
    ) THEN
    DELETE FROM opengeni_private.subscription_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = 'session_access'
      AND capability.account_id = p_account_id AND capability.connection_id = p_session_id;
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', p_session_owner_subject_id, true);
  PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', p_turn_human_subject_id, true);
  RETURN true;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_session_access(uuid, uuid, uuid, uuid, text, text) FROM PUBLIC;

CREATE FUNCTION opengeni_private.authorize_subscription_personal_access(
  p_account_id uuid, p_workspace_id uuid, p_session_id uuid, p_turn_id uuid,
  p_connection_id uuid, p_provider text, p_session_owner_subject_id text,
  p_turn_human_subject_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
DECLARE accepted_snapshot jsonb;
BEGIN
  IF p_account_id IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')::uuid
    OR p_workspace_id IS DISTINCT FROM nullif(current_setting('opengeni.workspace_id', true), '')::uuid
    OR p_turn_human_subject_id IS DISTINCT FROM nullif(current_setting('opengeni.initiating_human_subject_id', true), '')
    OR p_session_owner_subject_id IS NULL OR p_turn_human_subject_id IS NULL
  THEN RETURN false; END IF;
  INSERT INTO opengeni_private.subscription_runtime_capabilities (
    backend_pid, transaction_id, capability_kind, account_id, workspace_id,
    session_id, turn_id, connection_id, provider,
    session_owner_subject_id, turn_human_subject_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'personal_access',
    p_account_id, p_workspace_id, p_session_id, p_turn_id, p_connection_id, p_provider,
    p_session_owner_subject_id, p_turn_human_subject_id)
  ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id)
  DO UPDATE SET workspace_id = EXCLUDED.workspace_id, session_id = EXCLUDED.session_id,
    turn_id = EXCLUDED.turn_id, provider = EXCLUDED.provider,
    session_owner_subject_id = EXCLUDED.session_owner_subject_id,
    turn_human_subject_id = EXCLUDED.turn_human_subject_id;

  SELECT CASE p_provider
    WHEN 'codex' THEN turn.codex_provider_account_authority_snapshot
    WHEN 'claude' THEN turn.claude_provider_account_authority_snapshot
    WHEN 'xai' THEN turn.xai_provider_account_authority_snapshot
  END INTO accepted_snapshot
  FROM sessions session
  JOIN session_turns turn ON turn.account_id = session.account_id
    AND turn.workspace_id = session.workspace_id AND turn.session_id = session.id
  JOIN subscription_connections connection ON connection.account_id = session.account_id
    AND connection.id = p_connection_id AND connection.provider = p_provider
  JOIN organization_memberships membership ON membership.id = connection.owner_organization_membership_id
    AND membership.account_id = connection.account_id
  JOIN organization_user_resource_authorities authority ON authority.id = connection.authority_id
    AND authority.account_id = connection.account_id AND authority.organization_membership_id = membership.id
    AND authority.resource_kind = 'subscription_connection' AND authority.resource_id = connection.id
    AND authority.generation = connection.authority_generation AND authority.status = 'active'
    AND authority.revoked_at IS NULL
  WHERE session.account_id = p_account_id AND session.workspace_id = p_workspace_id
    AND session.id = p_session_id AND session.owner_subject_id = p_session_owner_subject_id
    AND turn.id = p_turn_id AND turn.initiating_human_subject_id = p_turn_human_subject_id
    AND membership.subject_id = p_session_owner_subject_id AND membership.status = 'active'
    AND membership.revoked_at IS NULL AND connection.ownership = 'personal'
    AND connection.owner_subject_id = p_session_owner_subject_id
    AND connection.status = 'active'
    AND p_turn_human_subject_id = p_session_owner_subject_id
    AND (session.visibility = 'user_private'
      OR membership.personal_workspace_id = p_workspace_id);
  IF accepted_snapshot IS NULL OR accepted_snapshot->>'scope' <> 'user'
    OR accepted_snapshot->>'authorityGeneration' IS DISTINCT FROM (
      SELECT authority_generation::text FROM subscription_connections
      WHERE account_id = p_account_id AND id = p_connection_id
    ) OR NOT session_reference_visible(p_account_id, p_workspace_id, p_session_id)
  THEN
    DELETE FROM opengeni_private.subscription_runtime_capabilities capability
    WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
      AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
      AND capability.capability_kind = 'personal_access'
      AND capability.account_id = p_account_id AND capability.connection_id = p_connection_id;
    RETURN false;
  END IF;
  PERFORM pg_catalog.set_config('opengeni.session_owner_subject_id', p_session_owner_subject_id, true);
  PERFORM pg_catalog.set_config('opengeni.turn_human_subject_id', p_turn_human_subject_id, true);
  RETURN true;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.authorize_subscription_personal_access(uuid, uuid, uuid, uuid, uuid, text, text, text) FROM PUBLIC;
DO $grant_personal_check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_personal_connection_visible(uuid, uuid, uuid, text, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_subscription_personal_access(uuid, uuid, uuid, uuid, uuid, text, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.authorize_subscription_session_access(uuid, uuid, uuid, uuid, text, text) TO opengeni_app;
  END IF;
END
$grant_personal_check$;

-- Shared organization/workspace/people visibility is expressed once and is
-- provider-neutral. Workspace scope assignments are exact; people scope uses
-- the initiating session owner rather than the person who happens to manage a
-- workspace. Personal connections require the capability function above.
CREATE FUNCTION opengeni_private.subscription_connection_visible(
  p_account_id uuid, p_workspace_id uuid, p_connection_id uuid, p_ownership text, p_scope_kind text,
  p_owner_membership_id uuid, p_owner_subject_id text, p_provider text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
  SELECT p_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND CASE
      WHEN p_ownership = 'personal' THEN EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'personal_access'
          AND capability.account_id = p_account_id AND capability.connection_id = p_connection_id
          AND p_owner_subject_id = capability.session_owner_subject_id
          AND opengeni_private.subscription_personal_connection_visible(
            p_account_id, p_connection_id, p_owner_membership_id,
            capability.session_owner_subject_id, capability.turn_human_subject_id, p_provider)
      )
      WHEN p_scope_kind = 'organization' THEN true
      WHEN p_scope_kind = 'workspaces' THEN EXISTS (
        SELECT 1 FROM subscription_connection_workspaces assignment
        WHERE assignment.account_id = p_account_id AND assignment.workspace_id = p_workspace_id
          AND assignment.connection_id = p_connection_id
      )
      WHEN p_scope_kind = 'people' THEN EXISTS (
        SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
        JOIN organization_memberships membership ON membership.account_id = capability.account_id
          AND membership.subject_id = capability.session_owner_subject_id
        JOIN subscription_connection_people assignment ON assignment.account_id = p_account_id
          AND assignment.connection_id = p_connection_id
          AND assignment.organization_membership_id = membership.id
        WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
          AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
          AND capability.capability_kind = 'session_access'
          AND capability.account_id = p_account_id
          AND capability.workspace_id = p_workspace_id
          AND capability.session_id IS NOT NULL AND capability.turn_id IS NOT NULL
          AND capability.session_owner_subject_id IS NOT NULL
          AND capability.turn_human_subject_id IS NOT NULL
          AND membership.status = 'active' AND membership.revoked_at IS NULL
      )
      ELSE false
    END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_connection_visible(uuid, uuid, uuid, text, text, uuid, text, text) FROM PUBLIC;
DO $grant_visible$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_connection_visible(uuid, uuid, uuid, text, text, uuid, text, text) TO opengeni_app;
  END IF;
END
$grant_visible$;

CREATE FUNCTION opengeni_private.subscription_organization_admin(p_account_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
DECLARE allowed boolean;
BEGIN
  IF p_account_id::text IS DISTINCT FROM nullif(current_setting('opengeni.account_id', true), '')
    OR nullif(current_setting('opengeni.subject_id', true), '') IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO opengeni_private.subscription_runtime_capabilities (
    backend_pid, transaction_id, capability_kind, account_id
  ) VALUES (pg_catalog.pg_backend_pid(), pg_catalog.pg_current_xact_id(), 'lifecycle', p_account_id)
  ON CONFLICT (backend_pid, transaction_id, capability_kind, account_id, connection_id) DO NOTHING;
  SELECT EXISTS (SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = p_account_id
        AND membership.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
        AND membership.status = 'active' AND membership.revoked_at IS NULL
        AND membership.role IN ('owner', 'admin')) INTO allowed;
  DELETE FROM opengeni_private.subscription_runtime_capabilities capability
  WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
    AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
    AND capability.capability_kind = 'lifecycle' AND capability.account_id = p_account_id;
  RETURN allowed;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_organization_admin(uuid) FROM PUBLIC;
DO $grant_admin_check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_organization_admin(uuid) TO opengeni_app;
  END IF;
END
$grant_admin_check$;

CREATE FUNCTION opengeni_private.guard_subscription_connection_scope()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND (
      NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.provider IS DISTINCT FROM OLD.provider
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.ownership IS DISTINCT FROM OLD.ownership
      OR NEW.owner_organization_membership_id IS DISTINCT FROM OLD.owner_organization_membership_id
      OR NEW.owner_subject_id IS DISTINCT FROM OLD.owner_subject_id
      OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
      OR NEW.authority_resource_kind IS DISTINCT FROM OLD.authority_resource_kind
      OR NEW.authority_generation IS DISTINCT FROM OLD.authority_generation
      OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      OR NEW.allow_personal_workspaces IS DISTINCT FROM OLD.allow_personal_workspaces
      OR NEW.managed_by_workspace_id IS DISTINCT FROM OLD.managed_by_workspace_id
      OR NEW.allowed_model_ids IS DISTINCT FROM OLD.allowed_model_ids
      OR NEW.excluded_models IS DISTINCT FROM OLD.excluded_models
  ) AND NOT opengeni_private.subscription_organization_admin(OLD.account_id) THEN
    RAISE EXCEPTION 'only organization administrators may change subscription connection scope or ownership'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_connection_scope() FROM PUBLIC;
CREATE TRIGGER subscription_connections_scope_guard
  BEFORE UPDATE ON subscription_connections
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_connection_scope();

-- The turn id and session id are separate inputs on the runtime records. Keep
-- them cryptographically/relationally bound even though the legacy turn table
-- has no composite candidate key for a declarative foreign key.
CREATE FUNCTION opengeni_private.guard_subscription_turn_session_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path FROM CURRENT
AS $function$
BEGIN
  PERFORM 1 FROM session_turns turn
  WHERE turn.account_id = NEW.account_id AND turn.workspace_id = NEW.workspace_id
    AND turn.session_id = NEW.session_id AND turn.id = NEW.turn_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription turn does not belong to the referenced session'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION opengeni_private.guard_subscription_turn_session_reference() FROM PUBLIC;
CREATE TRIGGER subscription_leases_turn_session_guard
  BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_leases
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();
CREATE TRIGGER subscription_capacity_waiters_turn_session_guard
  BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_capacity_waiters
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();
CREATE TRIGGER subscription_turn_failures_turn_session_guard
  BEFORE INSERT OR UPDATE OF account_id, workspace_id, session_id, turn_id ON subscription_turn_failures
  FOR EACH ROW EXECUTE FUNCTION opengeni_private.guard_subscription_turn_session_reference();

-- Only the SECURITY DEFINER authorization seam can use the transaction-local
-- capability to inspect live membership and resource-authority rows.
CREATE POLICY subscription_core_capability_membership_read ON organization_memberships FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'organization_memberships'::regclass))
    AND EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('personal_access', 'session_access', 'lifecycle')
        AND capability.account_id = organization_memberships.account_id));
CREATE POLICY subscription_core_capability_authority_read ON organization_user_resource_authorities FOR SELECT
  USING (current_user = pg_catalog.pg_get_userbyid((SELECT relation.relowner
      FROM pg_catalog.pg_class relation WHERE relation.oid = 'organization_user_resource_authorities'::regclass))
    AND EXISTS (SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind IN ('personal_access', 'lifecycle')
        AND capability.account_id = organization_user_resource_authorities.account_id));

CREATE FUNCTION opengeni_private.subscription_people_assignment_visible(
  p_account_id uuid, p_workspace_id uuid, p_membership_id uuid,
  p_session_owner_subject_id text, p_turn_human_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
  SELECT p_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND p_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND p_session_owner_subject_id = nullif(current_setting('opengeni.session_owner_subject_id', true), '')
    AND p_turn_human_subject_id = nullif(current_setting('opengeni.turn_human_subject_id', true), '')
    AND EXISTS (
      SELECT 1 FROM opengeni_private.subscription_runtime_capabilities capability
      JOIN organization_memberships membership
        ON membership.account_id = capability.account_id
        AND membership.subject_id = capability.session_owner_subject_id
      WHERE capability.backend_pid = pg_catalog.pg_backend_pid()
        AND capability.transaction_id = pg_catalog.pg_current_xact_id_if_assigned()
        AND capability.capability_kind = 'session_access'
        AND capability.account_id = p_account_id
        AND capability.workspace_id = p_workspace_id
        AND capability.session_owner_subject_id = p_session_owner_subject_id
        AND capability.turn_human_subject_id = p_turn_human_subject_id
        AND membership.id = p_membership_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
    )
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_people_assignment_visible(uuid, uuid, uuid, text, text) FROM PUBLIC;

CREATE FUNCTION opengeni_private.subscription_person_preference_visible(
  p_account_id uuid, p_membership_id uuid,
  p_session_owner_subject_id text, p_turn_human_subject_id text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
  SELECT p_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND p_session_owner_subject_id = nullif(current_setting('opengeni.session_owner_subject_id', true), '')
    AND p_turn_human_subject_id = nullif(current_setting('opengeni.turn_human_subject_id', true), '')
    AND p_session_owner_subject_id = p_turn_human_subject_id
    AND EXISTS (
      SELECT 1 FROM organization_memberships membership
      WHERE membership.account_id = p_account_id AND membership.id = p_membership_id
        AND membership.subject_id = p_session_owner_subject_id
        AND membership.status = 'active' AND membership.revoked_at IS NULL
    )
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_person_preference_visible(uuid, uuid, text, text) FROM PUBLIC;

CREATE FUNCTION opengeni_private.subscription_apps_designation_allowed(
  p_account_id uuid, p_workspace_id uuid, p_connection_id uuid
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path FROM CURRENT
AS $function$
  SELECT p_account_id::text = nullif(current_setting('opengeni.account_id', true), '')
    AND p_workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')
    AND EXISTS (
      SELECT 1 FROM subscription_connections connection
      WHERE connection.account_id = p_account_id AND connection.id = p_connection_id
        AND connection.provider = 'codex' AND connection.ownership = 'shared'
        AND connection.status = 'active'
        AND (
          connection.scope_kind = 'organization'
          OR (connection.scope_kind = 'workspaces' AND EXISTS (
            SELECT 1 FROM subscription_connection_workspaces assignment
            WHERE assignment.account_id = connection.account_id
              AND assignment.connection_id = connection.id
              AND assignment.workspace_id = p_workspace_id
          ))
          OR (connection.scope_kind = 'people' AND EXISTS (
            SELECT 1 FROM subscription_connection_people assignment
            JOIN organization_memberships membership
              ON membership.id = assignment.organization_membership_id
              AND membership.account_id = assignment.account_id
            WHERE assignment.account_id = connection.account_id
              AND assignment.connection_id = connection.id
              AND membership.status = 'active' AND membership.revoked_at IS NULL
              AND (membership.personal_workspace_id = p_workspace_id OR EXISTS (
                SELECT 1 FROM workspace_memberships workspace_membership
                WHERE workspace_membership.account_id = p_account_id
                  AND workspace_membership.workspace_id = p_workspace_id
                  AND workspace_membership.subject_id = membership.subject_id
              ))
          ))
        )
        AND (
          opengeni_private.subscription_organization_admin(p_account_id)
          OR (connection.managed_by_workspace_id = p_workspace_id AND EXISTS (
            SELECT 1 FROM workspace_memberships manager
            WHERE manager.account_id = p_account_id AND manager.workspace_id = p_workspace_id
              AND manager.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
              AND manager.role = 'admin'
          ))
        )
    )
$function$;
REVOKE ALL ON FUNCTION opengeni_private.subscription_apps_designation_allowed(uuid, uuid, uuid) FROM PUBLIC;
DO $grant_subscription_policy_helpers$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_connection_visible(uuid, uuid, uuid, text, text, uuid, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_organization_admin(uuid) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_people_assignment_visible(uuid, uuid, uuid, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_person_preference_visible(uuid, uuid, text, text) TO opengeni_app;
    GRANT EXECUTE ON FUNCTION opengeni_private.subscription_apps_designation_allowed(uuid, uuid, uuid) TO opengeni_app;
  END IF;
END
$grant_subscription_policy_helpers$;

-- Every new table has FORCE RLS. Organization and workspace scope use the
-- standard transaction GUCs; tables referencing sessions receive the same
-- restrictive policy function as the existing session_visibility_isolation.
DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'subscription_connections','subscription_connection_workspaces','subscription_connection_people',
    'subscription_connection_aliases','subscription_connection_quota','subscription_settings',
    'subscription_person_preferences','subscription_session_bindings','subscription_leases',
    'subscription_capacity_waiters','subscription_turn_failures','subscription_apps_designations',
    'subscription_provider_cutovers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;

  CREATE POLICY subscription_connections_scope ON subscription_connections FOR SELECT
    USING ((ownership = 'shared' AND opengeni_private.subscription_organization_admin(account_id))
      OR opengeni_private.subscription_connection_visible(account_id,
        nullif(current_setting('opengeni.workspace_id', true), '')::uuid,
        id, ownership, scope_kind, owner_organization_membership_id, owner_subject_id, provider));
  CREATE POLICY subscription_connections_insert_admin ON subscription_connections FOR INSERT
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
  CREATE POLICY subscription_connections_update_scope ON subscription_connections FOR UPDATE
    USING (opengeni_private.subscription_connection_visible(account_id,
        nullif(current_setting('opengeni.workspace_id', true), '')::uuid,
        id, ownership, scope_kind, owner_organization_membership_id, owner_subject_id, provider)
      AND (opengeni_private.subscription_organization_admin(account_id)
        OR (managed_by_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
          AND EXISTS (SELECT 1 FROM workspace_memberships grant_row
            WHERE grant_row.account_id = subscription_connections.account_id
              AND grant_row.workspace_id = subscription_connections.managed_by_workspace_id
              AND grant_row.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
              AND grant_row.role = 'admin'))))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id)
      OR (managed_by_workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND ownership = 'shared'
        AND EXISTS (SELECT 1 FROM workspace_memberships grant_row
          WHERE grant_row.account_id = subscription_connections.account_id
            AND grant_row.workspace_id = subscription_connections.managed_by_workspace_id
            AND grant_row.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
            AND grant_row.role = 'admin')));
  CREATE POLICY subscription_connections_delete_admin ON subscription_connections FOR DELETE
    USING (opengeni_private.subscription_organization_admin(account_id));
  CREATE POLICY subscription_connections_membership_lifecycle ON subscription_connections FOR DELETE
    USING (current_user = pg_catalog.pg_get_userbyid((SELECT lifecycle.proowner
        FROM pg_catalog.pg_proc lifecycle
        WHERE lifecycle.oid = pg_catalog.to_regprocedure(
          'finalize_organization_retention_deletion(uuid,uuid,uuid,text)')))
      AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'organization_membership_lifecycle');
  CREATE POLICY subscription_connections_membership_lifecycle_read ON subscription_connections FOR SELECT
    USING (current_user = pg_catalog.pg_get_userbyid((SELECT lifecycle.proowner
        FROM pg_catalog.pg_proc lifecycle
        WHERE lifecycle.oid = pg_catalog.to_regprocedure(
          'finalize_organization_retention_deletion(uuid,uuid,uuid,text)')))
      AND current_setting('opengeni.organization_tenancy_lifecycle', true) = 'organization_membership_lifecycle');
  CREATE POLICY subscription_connection_workspaces_scope ON subscription_connection_workspaces FOR SELECT
    USING (account_id::text = nullif(current_setting('opengeni.account_id', true), '')
      AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), ''));
  CREATE POLICY subscription_connection_workspaces_admin ON subscription_connection_workspaces FOR ALL
    USING (opengeni_private.subscription_organization_admin(account_id))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
  CREATE POLICY subscription_connection_people_scope ON subscription_connection_people FOR SELECT
    USING (opengeni_private.subscription_people_assignment_visible(
      account_id, nullif(current_setting('opengeni.workspace_id', true), '')::uuid,
      organization_membership_id,
      nullif(current_setting('opengeni.session_owner_subject_id', true), ''),
      nullif(current_setting('opengeni.turn_human_subject_id', true), '')));
  CREATE POLICY subscription_connection_people_admin ON subscription_connection_people FOR ALL
    USING (opengeni_private.subscription_organization_admin(account_id))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
  CREATE POLICY subscription_connection_aliases_scope ON subscription_connection_aliases FOR ALL
    USING (opengeni_private.subscription_organization_admin(account_id))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id));
  CREATE POLICY subscription_connection_quota_scope ON subscription_connection_quota FOR ALL
    USING (account_id::text = nullif(current_setting('opengeni.account_id', true), '')
      AND EXISTS (SELECT 1 FROM subscription_connections connection WHERE connection.account_id = account_id AND connection.id = connection_id))
    WITH CHECK (account_id::text = nullif(current_setting('opengeni.account_id', true), '')
      AND EXISTS (SELECT 1 FROM subscription_connections connection WHERE connection.account_id = account_id AND connection.id = connection_id));
  CREATE POLICY subscription_settings_scope ON subscription_settings FOR SELECT
    USING (account_id::text = nullif(current_setting('opengeni.account_id', true), '')
      AND (workspace_id IS NULL OR workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), '')));
  CREATE POLICY subscription_settings_manager ON subscription_settings FOR ALL
    USING (opengeni_private.subscription_organization_admin(account_id)
      OR (workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM workspace_memberships grant_row
          WHERE grant_row.account_id = subscription_settings.account_id
            AND grant_row.workspace_id = subscription_settings.workspace_id
            AND grant_row.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
            AND grant_row.role = 'admin')))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id)
      OR (workspace_id = nullif(current_setting('opengeni.workspace_id', true), '')::uuid
        AND cardinality(locked_settings) = 0
        AND EXISTS (SELECT 1 FROM workspace_memberships grant_row
          WHERE grant_row.account_id = subscription_settings.account_id
            AND grant_row.workspace_id = subscription_settings.workspace_id
            AND grant_row.subject_id = nullif(current_setting('opengeni.subject_id', true), '')
            AND grant_row.role = 'admin')));
  CREATE POLICY subscription_person_preferences_scope ON subscription_person_preferences FOR ALL
    USING (opengeni_private.subscription_person_preference_visible(
      account_id, organization_membership_id,
      nullif(current_setting('opengeni.session_owner_subject_id', true), ''),
      nullif(current_setting('opengeni.turn_human_subject_id', true), '')))
    WITH CHECK (opengeni_private.subscription_person_preference_visible(
      account_id, organization_membership_id,
      nullif(current_setting('opengeni.session_owner_subject_id', true), ''),
      nullif(current_setting('opengeni.turn_human_subject_id', true), '')));
  CREATE POLICY subscription_apps_designations_scope ON subscription_apps_designations FOR SELECT
    USING (account_id::text = nullif(current_setting('opengeni.account_id', true), '')
      AND workspace_id::text = nullif(current_setting('opengeni.workspace_id', true), ''));
  CREATE POLICY subscription_apps_designations_admin ON subscription_apps_designations FOR ALL
    USING (opengeni_private.subscription_apps_designation_allowed(account_id, workspace_id, connection_id))
    WITH CHECK (opengeni_private.subscription_apps_designation_allowed(account_id, workspace_id, connection_id));
  CREATE POLICY subscription_provider_cutovers_scope ON subscription_provider_cutovers FOR SELECT
    USING (account_id::text = nullif(current_setting('opengeni.account_id', true), ''));
  CREATE POLICY subscription_provider_cutovers_admin ON subscription_provider_cutovers FOR ALL
    USING (opengeni_private.subscription_organization_admin(account_id))
    WITH CHECK (opengeni_private.subscription_organization_admin(account_id));

  FOREACH table_name IN ARRAY ARRAY['subscription_session_bindings','subscription_leases','subscription_capacity_waiters','subscription_turn_failures'] LOOP
    EXECUTE format('CREATE POLICY session_visibility_isolation ON %I AS RESTRICTIVE FOR ALL USING (session_reference_visible(account_id, workspace_id, session_id)) WITH CHECK (session_reference_visible(account_id, workspace_id, session_id))', table_name);
    EXECUTE format('CREATE POLICY subscription_account_workspace_scope ON %I FOR ALL USING (account_id::text = nullif(current_setting(''opengeni.account_id'', true), '''') AND workspace_id::text = nullif(current_setting(''opengeni.workspace_id'', true), '''')) WITH CHECK (account_id::text = nullif(current_setting(''opengeni.account_id'', true), '''') AND workspace_id::text = nullif(current_setting(''opengeni.workspace_id'', true), ''''))', table_name);
  END LOOP;
END;
$rls$;

-- Provider-neutral settings resolver. It returns normalized values and a
-- source map using organization defaults and unlocked workspace overrides.
CREATE FUNCTION subscription_effective_settings(p_account_id uuid, p_workspace_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path FROM CURRENT
AS $function$
  WITH org AS (
    SELECT * FROM subscription_settings WHERE account_id = p_account_id AND workspace_id IS NULL
  ), ws AS (
    SELECT * FROM subscription_settings WHERE account_id = p_account_id AND workspace_id = p_workspace_id
  ), keys AS (
  SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.rotation) AS entry(key)
    UNION SELECT entry.key FROM ws, LATERAL jsonb_object_keys(ws.rotation) AS entry(key)
  ), rotation_entries AS (
    SELECT keys.key,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN ws.rotation->keys.key ELSE org.rotation->keys.key END AS setting,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN CASE keys.key WHEN 'codex' THEN ws.codex_primary_connection_id
          WHEN 'claude' THEN ws.claude_primary_connection_id
          WHEN 'xai' THEN ws.xai_primary_connection_id END
        ELSE CASE keys.key WHEN 'codex' THEN org.codex_primary_connection_id
          WHEN 'claude' THEN org.claude_primary_connection_id
          WHEN 'xai' THEN org.xai_primary_connection_id END END AS primary_connection_id,
      CASE WHEN ws.rotation ? keys.key AND NOT ('rotation' = ANY(coalesce(org.locked_settings, '{}')))
        THEN 'workspace' ELSE 'organization' END AS source
    FROM keys CROSS JOIN org LEFT JOIN ws ON true
  ), rot AS (
    SELECT coalesce(jsonb_object_agg(key,
      CASE WHEN setting->>'mode' = 'primary_first'
        THEN setting || jsonb_build_object('primaryConnectionId', primary_connection_id::text)
        ELSE setting END), '{}'::jsonb) AS value,
      coalesce(jsonb_object_agg(key, source), '{}'::jsonb) AS sources
    FROM rotation_entries
  ), provider_keys AS (
    SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.providers) AS entry(key)
    UNION SELECT entry.key FROM ws, LATERAL jsonb_object_keys(ws.providers) AS entry(key)
  ), prov AS (
    SELECT coalesce(jsonb_object_agg(provider_keys.key,
      '{"useOrganizationAccounts":true,"enabled":true}'::jsonb
        || coalesce(org.providers->provider_keys.key, '{}'::jsonb)
        || CASE WHEN ws.providers ? provider_keys.key AND NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))
          THEN ws.providers->provider_keys.key ELSE '{}'::jsonb END), '{}'::jsonb) value,
      coalesce(jsonb_object_agg(provider_keys.key,
      CASE WHEN ws.providers ? provider_keys.key AND NOT ('providers' = ANY(coalesce(org.locked_settings, '{}')))
        THEN 'workspace' ELSE 'organization' END), '{}'::jsonb) sources
    FROM provider_keys CROSS JOIN org LEFT JOIN ws ON true
  ), fallback_keys AS (
    SELECT entry.key FROM org, LATERAL jsonb_object_keys(org.fallback_order) AS entry(key)
    UNION SELECT entry.key FROM ws, LATERAL jsonb_object_keys(ws.fallback_order) AS entry(key)
  ), fallback AS (
    SELECT coalesce(jsonb_object_agg(fallback_keys.key,
      CASE WHEN ws.fallback_order ? fallback_keys.key
        AND NOT ('fallbackOrder' = ANY(coalesce(org.locked_settings, '{}')))
        THEN ws.fallback_order->fallback_keys.key ELSE org.fallback_order->fallback_keys.key END), '{}'::jsonb) value,
      coalesce(jsonb_object_agg(fallback_keys.key,
      CASE WHEN ws.fallback_order ? fallback_keys.key
        AND NOT ('fallbackOrder' = ANY(coalesce(org.locked_settings, '{}')))
        THEN 'workspace' ELSE 'organization' END), '{}'::jsonb) sources
    FROM fallback_keys CROSS JOIN org LEFT JOIN ws ON true
  )
  SELECT jsonb_build_object(
    'values', jsonb_build_object(
    'rotation', rot.value, 'providers', prov.value,
    'crossProviderFailover', CASE WHEN ws.cross_provider_failover IS NOT NULL
      AND NOT ('crossProviderFailover' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.cross_provider_failover ELSE coalesce(org.cross_provider_failover, false) END,
    'fallbackOrder', fallback.value,
    'personalConnectionsAllowed', CASE WHEN ws.personal_connections_allowed IS NOT NULL
      AND NOT ('personalConnectionsAllowed' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.personal_connections_allowed ELSE coalesce(org.personal_connections_allowed, true) END,
    'personalFallbackAllowed', CASE WHEN ws.personal_fallback_allowed IS NOT NULL
      AND NOT ('personalFallbackAllowed' = ANY(coalesce(org.locked_settings, '{}')))
      THEN ws.personal_fallback_allowed ELSE coalesce(org.personal_fallback_allowed, false) END
    ),
    'sources', jsonb_build_object(
      'rotation', rot.sources, 'providers', prov.sources,
      'crossProviderFailover', CASE WHEN ws.cross_provider_failover IS NOT NULL AND NOT ('crossProviderFailover' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END,
      'fallbackOrder', fallback.sources,
      'personalConnectionsAllowed', CASE WHEN ws.personal_connections_allowed IS NOT NULL AND NOT ('personalConnectionsAllowed' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END,
      'personalFallbackAllowed', CASE WHEN ws.personal_fallback_allowed IS NOT NULL AND NOT ('personalFallbackAllowed' = ANY(coalesce(org.locked_settings, '{}'))) THEN 'workspace' ELSE 'organization' END)
  ) FROM org CROSS JOIN rot CROSS JOIN prov CROSS JOIN fallback LEFT JOIN ws ON true
$function$;
REVOKE ALL ON FUNCTION subscription_effective_settings(uuid, uuid) FROM PUBLIC;
DO $grant_effective$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT EXECUTE ON FUNCTION subscription_effective_settings(uuid, uuid) TO opengeni_app;
  END IF;
END
$grant_effective$;

-- The generic resource authority covers all providers. Revoke personal rows
-- on leave using the existing retention/removal lifecycle and keep historic
-- provider-specific resource kinds supported for old records.
-- Preserve the audited 0263 lifecycle function while extending its accepted
-- resource inventory and deleting generic subscription connections only
-- inside the finalizer's validated, claimed retention transaction.
DO $membership_lifecycle$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef(
    'finalize_organization_retention_deletion(uuid,uuid,uuid,text)'::regprocedure
  );
  IF definition IS NULL THEN
    RAISE EXCEPTION 'organization membership retention function signature changed';
  END IF;
  definition := replace(definition,
    '  deleted_xai integer := 0;',
    '  deleted_xai integer := 0;
  deleted_claude integer := 0;
  deleted_subscriptions integer := 0;');
  definition := replace(definition,
    '''codex_subscription'', ''connected_machine'', ''connection'', ''document'',
      ''rig'', ''variable_set'', ''xai_subscription''',
    '''claude_subscription'', ''codex_subscription'', ''connected_machine'', ''connection'', ''document'',
      ''rig'', ''subscription_connection'', ''variable_set'', ''xai_subscription''');
  definition := replace(definition,
    '  DELETE FROM ' || 'rigs resource',
    '  DELETE FROM claude_subscription_credentials resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = ''claude_subscription''
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.organization_user_resource_authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_claude = ROW_COUNT;

  DELETE FROM subscription_connections resource
  USING organization_user_resource_authorities authority
  WHERE authority.account_id = p_account_id
    AND authority.organization_membership_id = p_membership_id
    AND authority.resource_kind = ''subscription_connection''
    AND authority.resource_id = resource.id
    AND resource.account_id = authority.account_id
    AND resource.authority_id = authority.id
    AND resource.owner_organization_membership_id = authority.organization_membership_id;
  GET DIAGNOSTICS deleted_subscriptions = ROW_COUNT;

  DELETE FROM ' || 'rigs resource');
  definition := replace(definition,
    '''xaiSubscriptions'', deleted_xai, ''connectedMachinesTombstoned''',
    '''xaiSubscriptions'', deleted_xai, ''claudeSubscriptions'', deleted_claude,
      ''subscriptionConnections'', deleted_subscriptions, ''connectedMachinesTombstoned''');
  EXECUTE definition;
END
$membership_lifecycle$;

-- Grants only expose these new relations through FORCE-RLS policies. No
-- production path reads or writes them in M2.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opengeni_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
      subscription_connections, subscription_connection_workspaces,
      subscription_connection_people, subscription_connection_aliases,
      subscription_connection_quota, subscription_settings,
      subscription_person_preferences, subscription_session_bindings,
      subscription_leases, subscription_capacity_waiters,
      subscription_turn_failures, subscription_apps_designations,
      subscription_provider_cutovers TO opengeni_app;
  END IF;
END
$grants$;

-- Pin lookups to the trusted data/private schemas and explicitly place pg_temp
-- last. Otherwise PostgreSQL implicitly checks the caller's temporary schema
-- before an unqualified relation referenced by a SECURITY DEFINER function.
DO $subscription_core_search_paths$
DECLARE data_schema text := current_schema();
BEGIN
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_personal_connection_visible(uuid,uuid,uuid,text,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.authorize_subscription_session_access(uuid,uuid,uuid,uuid,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.authorize_subscription_personal_access(uuid,uuid,uuid,uuid,uuid,text,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_connection_visible(uuid,uuid,uuid,text,text,uuid,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_organization_admin(uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_people_assignment_visible(uuid,uuid,uuid,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_person_preference_visible(uuid,uuid,text,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.subscription_apps_designation_allowed(uuid,uuid,uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION opengeni_private.guard_subscription_turn_session_reference() SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema);
  EXECUTE format('ALTER FUNCTION %I.subscription_effective_settings(uuid,uuid) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema, data_schema);
  EXECUTE format('ALTER FUNCTION %I.finalize_organization_retention_deletion(uuid,uuid,uuid,text) SET search_path = pg_catalog, %I, opengeni_private, pg_temp', data_schema, data_schema);
END
$subscription_core_search_paths$;
