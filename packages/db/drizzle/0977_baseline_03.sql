-- deployment-mode: rolling
-- Opengeni baseline part 3 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

COMMENT ON TABLE organization_codex_rotation_settings IS 'Organization-wide Codex allocator serialization point and active cursor.';

CREATE TABLE organization_company_profile_agent_policies (
    account_id uuid NOT NULL,
    mode text DEFAULT 'suggest'::text NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    updated_by_membership_id uuid,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_company_profile_agent_policies_mode_check CHECK ((mode = ANY (ARRAY['off'::text, 'suggest'::text, 'automatic'::text]))),
    CONSTRAINT organization_company_profile_agent_policies_version_check CHECK ((version >= 0))
);

ALTER TABLE ONLY organization_company_profile_agent_policies FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_company_profile_agent_policies IS 'Organization-owner policy for agent-authored company-profile changes; default suggest preserves per-change confirmation, automatic permits exact owner-initiated turns to activate through the company-profile lifecycle.';

CREATE TABLE organization_company_profile_agent_policy_events (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    actor_membership_id uuid NOT NULL,
    requested_mode text NOT NULL,
    expected_version bigint NOT NULL,
    result_mode text NOT NULL,
    result_version bigint NOT NULL,
    result_updated_at timestamp with time zone NOT NULL,
    changed boolean NOT NULL,
    CONSTRAINT organization_company_profile_agent_policy_events_mode_check CHECK (((requested_mode = ANY (ARRAY['off'::text, 'suggest'::text, 'automatic'::text])) AND (result_mode = ANY (ARRAY['off'::text, 'suggest'::text, 'automatic'::text])))),
    CONSTRAINT organization_company_profile_agent_policy_events_version_check CHECK (((expected_version >= 0) AND (result_version > 0)))
);

ALTER TABLE ONLY organization_company_profile_agent_policy_events FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_integration_policies (
    account_id uuid NOT NULL,
    mode text NOT NULL,
    allowed_integration_keys jsonb NOT NULL,
    revision bigint NOT NULL,
    personal_integration_setup text DEFAULT 'members'::text NOT NULL,
    CONSTRAINT organization_integration_policie_allowed_integration_keys_check CHECK ((jsonb_typeof(allowed_integration_keys) = 'array'::text)),
    CONSTRAINT organization_integration_policies_mode_check CHECK ((mode = ANY (ARRAY['unrestricted'::text, 'restricted'::text]))),
    CONSTRAINT organization_integration_policies_personal_setup_check CHECK ((personal_integration_setup = ANY (ARRAY['members'::text, 'admins'::text]))),
    CONSTRAINT organization_integration_policies_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY organization_integration_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_integration_policy_operations (
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    request jsonb NOT NULL,
    result jsonb NOT NULL
);

ALTER TABLE ONLY organization_integration_policy_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_invitation_binding_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    target_subject_id text NOT NULL,
    resulting_revision bigint NOT NULL,
    bound_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_invitation_binding_events_revision_check CHECK ((resulting_revision > 1)),
    CONSTRAINT organization_invitation_binding_events_subject_check CHECK (((target_subject_id = btrim(target_subject_id)) AND (target_subject_id ~~ 'user:%'::text) AND ((octet_length(convert_to(target_subject_id, 'UTF8'::name)) >= 6) AND (octet_length(convert_to(target_subject_id, 'UTF8'::name)) <= 1024))))
);

ALTER TABLE ONLY organization_invitation_binding_events FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_invitation_binding_events IS 'Immutable exact-subject and revision evidence for verified-email invitation binding.';

CREATE TABLE organization_membership_lifecycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_membership_id uuid,
    target_membership_id uuid,
    kind text NOT NULL,
    prior_authorization_revision bigint,
    resulting_authorization_revision bigint,
    reason text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_service_subject text,
    CONSTRAINT organization_membership_lifecycle_events_actor_kind_check CHECK ((((actor_membership_id IS NOT NULL) AND (actor_service_subject IS NULL)) OR ((actor_membership_id IS NULL) AND (actor_service_subject IS NOT NULL) AND (actor_service_subject ~ '^api_key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))),
    CONSTRAINT organization_membership_lifecycle_events_kind_check CHECK ((kind = ANY (ARRAY['invite'::text, 'accept'::text, 'revoke_invitation'::text, 'change_role'::text, 'suspend'::text, 'reactivate'::text, 'offboard'::text, 'retention'::text]))),
    CONSTRAINT organization_membership_lifecycle_events_reason_check CHECK (((reason IS NULL) OR (octet_length(convert_to(reason, 'UTF8'::name)) <= 512)))
);

ALTER TABLE ONLY organization_membership_lifecycle_events FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_membership_lifecycle_events IS 'Immutable value-bounded organization membership lifecycle audit evidence.';

CREATE TABLE organization_membership_operation_receipts (
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    action text NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_membership_operation_receipts_action_check CHECK ((action = ANY (ARRAY['invite'::text, 'accept'::text, 'revoke_invitation'::text, 'change_role'::text, 'suspend'::text, 'reactivate'::text, 'offboard'::text, 'retention'::text, 'create_workspace'::text]))),
    CONSTRAINT organization_membership_operation_receipts_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY organization_membership_operation_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_membership_operation_receipts IS 'Immutable input-bound idempotency receipts for organization membership lifecycle commands.';

CREATE TABLE organization_model_defaults (
    account_id uuid NOT NULL,
    session_defaults jsonb,
    allowed_providers text[],
    allowed_models text[],
    model_compaction_thresholds jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    realtime_voice jsonb DEFAULT '{}'::jsonb NOT NULL,
    realtime_default_model text,
    CONSTRAINT organization_model_defaults_allowlist_bounds_check CHECK (((COALESCE(cardinality(allowed_providers), 0) <= 64) AND (COALESCE(cardinality(allowed_models), 0) <= 256))),
    CONSTRAINT organization_model_defaults_compaction_check CHECK ((jsonb_typeof(model_compaction_thresholds) = 'object'::text)),
    CONSTRAINT organization_model_defaults_session_defaults_check CHECK (((session_defaults IS NULL) OR (jsonb_typeof(session_defaults) = 'object'::text)))
);

ALTER TABLE ONLY organization_model_defaults FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_model_provider_connection_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider_kind text NOT NULL,
    operation_id uuid NOT NULL,
    request_hash text NOT NULL,
    result_status text NOT NULL,
    result_version integer NOT NULL,
    result_created_at timestamp with time zone NOT NULL,
    result_updated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    result_endpoint text,
    result_auth_method text DEFAULT 'api_key'::text NOT NULL,
    CONSTRAINT organization_model_provider_connection_ope_result_version_check CHECK ((result_version > 0)),
    CONSTRAINT organization_model_provider_connection_oper_result_status_check CHECK ((result_status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT organization_model_provider_connection_opera_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT organization_model_provider_connection_operations_auth_chk CHECK (((result_auth_method = ANY (ARRAY['api_key'::text, 'entra_client_secret'::text, 'entra_deployment_identity'::text])) AND ((result_auth_method = 'api_key'::text) OR (provider_kind = 'azure_openai'::text)))),
    CONSTRAINT organization_model_provider_connection_operations_endpoint_chk CHECK ((((provider_kind = 'azure_openai'::text) = (result_endpoint IS NOT NULL)) AND ((result_endpoint IS NULL) OR (result_endpoint ~ '^https://[a-z0-9-]+\.openai\.azure\.com/openai/v1$'::text)))),
    CONSTRAINT organization_model_provider_connection_operations_provider_kind CHECK ((provider_kind = ANY (ARRAY['vercel_gateway'::text, 'openrouter'::text, 'anthropic'::text, 'claude_subscription'::text, 'opper'::text, 'elevenlabs'::text, 'openai'::text, 'azure_openai'::text])))
);

ALTER TABLE ONLY organization_model_provider_connection_operations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_model_provider_connection_operations IS 'Durable secret-free idempotency receipts for organization provider connection mutations.';

CREATE TABLE organization_model_provider_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider_kind text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    credential_encrypted text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    operation_id uuid NOT NULL,
    request_hash text NOT NULL,
    updated_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_model_ids text[],
    allowed_workspace_ids uuid[],
    allow_personal_workspaces boolean DEFAULT true NOT NULL,
    access_policy_version integer DEFAULT 1 NOT NULL,
    access_policy_updated_by text,
    access_policy_updated_at timestamp with time zone,
    claude_usage_snapshot jsonb,
    endpoint text,
    auth_method text DEFAULT 'api_key'::text NOT NULL,
    CONSTRAINT organization_model_provider_connect_updated_by_subject_id_check CHECK (((octet_length(updated_by_subject_id) >= 1) AND (octet_length(updated_by_subject_id) <= 1024))),
    CONSTRAINT organization_model_provider_connections_access_policy_shape CHECK (((access_policy_version > 0) AND (COALESCE(cardinality(allowed_model_ids), 0) <= 500) AND (COALESCE(cardinality(allowed_workspace_ids), 0) <= 500) AND (array_position(allowed_model_ids, NULL::text) IS NULL) AND (array_position(allowed_workspace_ids, NULL::uuid) IS NULL))),
    CONSTRAINT organization_model_provider_connections_auth_method_chk CHECK (((auth_method = ANY (ARRAY['api_key'::text, 'entra_client_secret'::text, 'entra_deployment_identity'::text])) AND ((auth_method = 'api_key'::text) OR (provider_kind = 'azure_openai'::text)))),
    CONSTRAINT organization_model_provider_connections_endpoint_chk CHECK ((((provider_kind = 'azure_openai'::text) = (endpoint IS NOT NULL)) AND ((endpoint IS NULL) OR (endpoint ~ '^https://[a-z0-9-]+\.openai\.azure\.com/openai/v1$'::text)))),
    CONSTRAINT organization_model_provider_connections_provider_kind_chk CHECK ((provider_kind = ANY (ARRAY['vercel_gateway'::text, 'openrouter'::text, 'anthropic'::text, 'claude_subscription'::text, 'opper'::text, 'elevenlabs'::text, 'openai'::text, 'azure_openai'::text]))),
    CONSTRAINT organization_model_provider_connections_request_hash_check CHECK ((request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT organization_model_provider_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT organization_model_provider_connections_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY organization_model_provider_connections FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_model_provider_connections IS 'Encrypted organization-owned Vercel AI Gateway/OpenRouter credentials inherited by shared workspaces only.';

CREATE TABLE organization_model_provider_custom_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    provider_kind text NOT NULL,
    upstream_model_id text NOT NULL,
    label text,
    version integer DEFAULT 1 NOT NULL,
    create_operation_id uuid NOT NULL,
    create_request_hash text NOT NULL,
    delete_operation_id uuid,
    delete_request_hash text,
    created_by_subject_id text NOT NULL,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_model_provider_custom__created_by_subject_id_check CHECK (((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024))),
    CONSTRAINT organization_model_provider_custom_mo_create_request_hash_check CHECK ((create_request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT organization_model_provider_custom_mode_upstream_model_id_check CHECK ((((octet_length(upstream_model_id) >= 1) AND (octet_length(upstream_model_id) <= 238)) AND (upstream_model_id ~ '^[!-~]+$'::text) AND (upstream_model_id !~ '[|]'::text))),
    CONSTRAINT organization_model_provider_custom_models_check CHECK ((((delete_operation_id IS NULL) AND (delete_request_hash IS NULL)) OR ((delete_operation_id IS NOT NULL) AND (delete_request_hash ~ '^[a-f0-9]{64}$'::text) AND (retired_at IS NOT NULL)))),
    CONSTRAINT organization_model_provider_custom_models_label_check CHECK (((label IS NULL) OR (((octet_length(label) >= 1) AND (octet_length(label) <= 128)) AND (label !~ '[\r\n|]'::text)))),
    CONSTRAINT organization_model_provider_custom_models_provider_kind_chk CHECK ((provider_kind = ANY (ARRAY['vercel_gateway'::text, 'openrouter'::text, 'anthropic'::text, 'claude_subscription'::text, 'opper'::text, 'openai'::text, 'azure_openai'::text]))),
    CONSTRAINT organization_model_provider_custom_models_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY organization_model_provider_custom_models FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_model_provider_custom_models IS 'Retained organization provider model generations; active rows are fresh-selection authority.';

CREATE TABLE organization_plans (
    account_id uuid NOT NULL,
    plan_key text NOT NULL,
    status text NOT NULL,
    stripe_subscription_id text,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_plans_period CHECK ((((current_period_start IS NULL) AND (current_period_end IS NULL)) OR ((current_period_start IS NOT NULL) AND (current_period_end IS NOT NULL) AND isfinite(current_period_start) AND isfinite(current_period_end) AND (current_period_end > current_period_start)))),
    CONSTRAINT organization_plans_status_check CHECK ((status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text, 'paused'::text, 'incomplete'::text, 'incomplete_expired'::text]))),
    CONSTRAINT organization_plans_subscription CHECK (((stripe_subscription_id IS NULL) OR ((length(btrim(stripe_subscription_id)) >= 1) AND (length(btrim(stripe_subscription_id)) <= 200))))
);

ALTER TABLE ONLY organization_plans FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_privacy_preferences (
    account_id uuid NOT NULL,
    default_visibility text DEFAULT 'workspace_shared'::text NOT NULL,
    admins_see_private_schedules boolean DEFAULT true NOT NULL,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    personal_workspaces_enabled boolean DEFAULT true NOT NULL,
    CONSTRAINT organization_privacy_preferences_default_visibility_chk CHECK ((default_visibility = ANY (ARRAY['workspace_shared'::text, 'user_private'::text])))
);

ALTER TABLE ONLY organization_privacy_preferences FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_private_session_setting_events (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    actor_membership_id uuid,
    requested_enabled boolean NOT NULL,
    expected_version bigint NOT NULL,
    result_enabled boolean NOT NULL,
    result_version bigint NOT NULL,
    result_updated_at timestamp with time zone NOT NULL,
    changed boolean NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_subject_id text,
    CONSTRAINT organization_private_session_setting_events_actor_check CHECK (((actor_membership_id IS NOT NULL) OR ((actor_subject_id IS NOT NULL) AND ((actor_subject_id ~~ 'api_key:%'::text) OR (actor_subject_id = 'service:session-tenancy-activation'::text))))),
    CONSTRAINT organization_private_session_setting_events_versions_check CHECK (((expected_version >= 0) AND (result_version > 0)))
);

ALTER TABLE ONLY organization_private_session_setting_events FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_private_session_settings (
    account_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_membership_id uuid,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_private_session_settings_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY organization_private_session_settings FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_private_session_settings IS 'Organization owner/admin product setting for new private sessions in shared workspaces; the 0303 readiness receipt remains the separate operator prerequisite.';

CREATE TABLE organization_profile_events (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    actor_membership_id uuid NOT NULL,
    previous_name text NOT NULL,
    requested_name text NOT NULL,
    expected_updated_at timestamp with time zone NOT NULL,
    result_updated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_profile_events_name_check CHECK (((octet_length(btrim(requested_name)) >= 1) AND (octet_length(btrim(requested_name)) <= 480)))
);

ALTER TABLE ONLY organization_profile_events FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_recovery_approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    operation_revision bigint NOT NULL,
    policy_id uuid NOT NULL,
    custodian_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    canonical_identity_id uuid NOT NULL,
    auth_user_id text NOT NULL,
    login_binding_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    identity_revision bigint NOT NULL,
    auth_revision bigint NOT NULL,
    subject_revision bigint NOT NULL,
    login_binding_revision bigint NOT NULL,
    custodian_acceptance_id uuid NOT NULL,
    reauth_operation_id uuid NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_approvals_revision_check CHECK (((operation_revision > 0) AND (membership_authorization_revision > 0) AND (identity_revision > 0) AND (auth_revision > 0) AND (subject_revision > 0) AND (login_binding_revision > 0)))
);

ALTER TABLE ONLY organization_recovery_approvals FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_recovery_command_receipts (
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    action text NOT NULL,
    actor_membership_id uuid NOT NULL,
    actor_identity_id uuid NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_receipts_action_check CHECK ((action = ANY (ARRAY['configure_policy'::text, 'accept_custody'::text, 'disable_policy'::text, 'start_operation'::text, 'approve_operation'::text, 'cancel_operation'::text, 'execute_operation'::text]))),
    CONSTRAINT organization_recovery_receipts_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT organization_recovery_receipts_result_check CHECK (((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 65536)))
);

ALTER TABLE ONLY organization_recovery_command_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_recovery_command_receipts IS 'Append-only exact-command recovery receipts; request actor-lease ids are excluded from semantic digests.';

CREATE TABLE organization_recovery_custodian_acceptances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    custodian_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    canonical_identity_id uuid NOT NULL,
    auth_user_id text NOT NULL,
    login_binding_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    identity_revision bigint NOT NULL,
    auth_revision bigint NOT NULL,
    subject_revision bigint NOT NULL,
    login_binding_revision bigint NOT NULL,
    reauth_operation_id uuid NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_acceptances_revision_check CHECK (((membership_authorization_revision > 0) AND (identity_revision > 0) AND (auth_revision > 0) AND (subject_revision > 0) AND (login_binding_revision > 0)))
);

ALTER TABLE ONLY organization_recovery_custodian_acceptances FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_recovery_custodians (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    ordinal integer NOT NULL,
    membership_id uuid NOT NULL,
    canonical_identity_id uuid NOT NULL,
    enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_custodians_ordinal_check CHECK (((ordinal >= 1) AND (ordinal <= 3)))
);

ALTER TABLE ONLY organization_recovery_custodians FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_recovery_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    policy_id uuid,
    operation_id uuid,
    command_operation_id uuid,
    event_type text NOT NULL,
    actor_membership_id uuid,
    actor_identity_id uuid,
    event_revision bigint NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_events_evidence_check CHECK (((jsonb_typeof(evidence) = 'object'::text) AND (octet_length((evidence)::text) <= 8192))),
    CONSTRAINT organization_recovery_events_revision_check CHECK ((event_revision > 0)),
    CONSTRAINT organization_recovery_events_type_check CHECK ((event_type = ANY (ARRAY['policy_configured'::text, 'custody_accepted'::text, 'policy_activated'::text, 'policy_disabled'::text, 'operation_started'::text, 'operation_approved'::text, 'quorum_started'::text, 'operation_cancelled'::text, 'operation_executed'::text, 'operation_expired'::text, 'operation_superseded'::text])))
);

ALTER TABLE ONLY organization_recovery_events FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_recovery_notification_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    outbox_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    provider text NOT NULL,
    claim_owner text NOT NULL,
    attempt_number integer NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    phase text NOT NULL,
    provider_message_id text,
    error_class text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_attempts_claim_check CHECK ((((length(btrim(claim_owner)) >= 1) AND (length(btrim(claim_owner)) <= 256)) AND ((attempt_number >= 1) AND (attempt_number <= 5)))),
    CONSTRAINT organization_recovery_attempts_error_check CHECK ((((phase = 'failed'::text) AND (error_class IS NOT NULL)) OR ((phase <> 'failed'::text) AND (error_class IS NULL)))),
    CONSTRAINT organization_recovery_attempts_phase_check CHECK ((phase = ANY (ARRAY['provider_started'::text, 'sent'::text, 'failed'::text, 'outcome_unknown'::text, 'claim_expired'::text, 'reconciled_sent'::text, 'reconciled_retry'::text]))),
    CONSTRAINT organization_recovery_attempts_provider_check CHECK (((provider = lower(btrim(provider))) AND ((length(provider) >= 1) AND (length(provider) <= 64))))
);

ALTER TABLE ONLY organization_recovery_notification_attempts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_recovery_notification_attempts IS 'Append-only bounded delivery claims, terminal outcomes, stale-claim evidence, and explicit ambiguous-outcome reconciliation.';

CREATE TABLE organization_recovery_notification_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    batch_id uuid NOT NULL,
    recipient_membership_id uuid NOT NULL,
    recipient_identity_id uuid NOT NULL,
    audience text NOT NULL,
    notification_type text NOT NULL,
    idempotency_key text NOT NULL,
    payload_digest text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_outbox_digest_check CHECK ((payload_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT organization_recovery_outbox_payload_check CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 8192))),
    CONSTRAINT organization_recovery_outbox_type_check CHECK ((notification_type = 'recovery_quorum_started'::text))
);

ALTER TABLE ONLY organization_recovery_notification_outbox FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_recovery_notification_outbox IS 'Immutable provider-neutral notification work; external I/O occurs only after provider_started is journaled.';

CREATE TABLE organization_recovery_operations (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    policy_revision bigint NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    state text DEFAULT 'collecting'::text NOT NULL,
    target_membership_id uuid NOT NULL,
    target_identity_id uuid NOT NULL,
    target_auth_user_id text NOT NULL,
    target_membership_authorization_revision bigint NOT NULL,
    target_identity_revision bigint NOT NULL,
    target_auth_revision bigint NOT NULL,
    target_subject_revision bigint NOT NULL,
    started_by_custodian_id uuid NOT NULL,
    started_by_identity_id uuid NOT NULL,
    quorum_at timestamp with time zone,
    executable_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    notification_batch_id uuid,
    notification_count integer,
    notification_digest text,
    executed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_operations_revision_check CHECK (((policy_revision > 0) AND (revision > 0) AND (target_membership_authorization_revision > 0) AND (target_identity_revision > 0) AND (target_auth_revision > 0) AND (target_subject_revision > 0))),
    CONSTRAINT organization_recovery_operations_state_check CHECK ((state = ANY (ARRAY['collecting'::text, 'cooling'::text, 'executed'::text, 'cancelled'::text, 'expired'::text, 'superseded'::text]))),
    CONSTRAINT organization_recovery_operations_terminal_check CHECK ((((state = 'executed'::text) AND (executed_at IS NOT NULL) AND (cancelled_at IS NULL) AND (superseded_at IS NULL)) OR ((state = 'cancelled'::text) AND (cancelled_at IS NOT NULL) AND (executed_at IS NULL) AND (superseded_at IS NULL)) OR ((state = 'superseded'::text) AND (superseded_at IS NOT NULL) AND (executed_at IS NULL) AND (cancelled_at IS NULL)) OR ((state = ANY (ARRAY['collecting'::text, 'cooling'::text, 'expired'::text])) AND (executed_at IS NULL) AND (cancelled_at IS NULL) AND (superseded_at IS NULL)))),
    CONSTRAINT organization_recovery_operations_time_check CHECK (((expires_at = (created_at + '30 days'::interval)) AND (((quorum_at IS NULL) AND (executable_at IS NULL) AND (notification_batch_id IS NULL) AND (notification_count IS NULL) AND (notification_digest IS NULL)) OR ((quorum_at IS NOT NULL) AND (executable_at = (quorum_at + '7 days'::interval)) AND (notification_batch_id IS NOT NULL) AND (notification_count > 0) AND (notification_digest ~ '^[0-9a-f]{64}$'::text)))))
);

ALTER TABLE ONLY organization_recovery_operations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_recovery_operations IS 'CAS-governed quorum recovery operations with fixed seven-day cooldown and promotion-only execution.';

CREATE TABLE organization_recovery_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    revision bigint NOT NULL,
    configured_by_membership_id uuid NOT NULL,
    configured_by_identity_id uuid NOT NULL,
    configured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_policies_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY organization_recovery_policies FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_recovery_policies IS 'Immutable revisioned three-custodian organization recovery policy evidence.';

CREATE TABLE organization_recovery_policy_heads (
    account_id uuid NOT NULL,
    current_policy_id uuid NOT NULL,
    revision bigint NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_recovery_policy_heads_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY organization_recovery_policy_heads FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_service_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    role text DEFAULT 'admin'::text NOT NULL,
    created_by_subject_id text,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_service_accounts_creator_check CHECK (((created_by_subject_id IS NULL) OR ((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024)))),
    CONSTRAINT organization_service_accounts_description_check CHECK (((description IS NULL) OR ((length(description) >= 1) AND (length(description) <= 500)))),
    CONSTRAINT organization_service_accounts_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 200))),
    CONSTRAINT organization_service_accounts_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);

ALTER TABLE ONLY organization_service_accounts FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_shared_workspace_administration_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_subject_id text NOT NULL
);

ALTER TABLE ONLY organization_shared_workspace_administration_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_user_resource_authorities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    origin_workspace_id uuid,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_user_resource_authorities_generation_check CHECK ((generation > 0)),
    CONSTRAINT organization_user_resource_authorities_kind_check CHECK (((resource_kind = lower(btrim(resource_kind))) AND ((length(resource_kind) >= 1) AND (length(resource_kind) <= 64)) AND (resource_kind ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text))),
    CONSTRAINT organization_user_resource_authorities_revocation_check CHECK ((((status = 'revoked'::text) AND (revoked_at IS NOT NULL)) OR ((status <> 'revoked'::text) AND (revoked_at IS NULL)))),
    CONSTRAINT organization_user_resource_authorities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'retained'::text, 'revoked'::text])))
);

ALTER TABLE ONLY organization_user_resource_authorities FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_resource_authorities IS 'Stable organization+membership user-resource authority identity; inert in Slice A.';

COMMENT ON COLUMN organization_user_resource_authorities.origin_workspace_id IS 'Non-authoritative provenance only; deletion clears this fact without transferring authority.';

CREATE TABLE organization_user_resource_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid,
    action text NOT NULL,
    mode text NOT NULL,
    context text NOT NULL,
    authority_epoch integer,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_user_resource_grants_action_check CHECK (((action = lower(btrim(action))) AND ((length(action) >= 1) AND (length(action) <= 64)) AND (action ~ '^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$'::text))),
    CONSTRAINT organization_user_resource_grants_context_check CHECK ((context = ANY (ARRAY['user_private'::text, 'workspace_shared'::text]))),
    CONSTRAINT organization_user_resource_grants_generation_check CHECK ((generation > 0)),
    CONSTRAINT organization_user_resource_grants_mode_check CHECK ((mode = ANY (ARRAY['once'::text, 'session'::text, 'always'::text]))),
    CONSTRAINT organization_user_resource_grants_revocation_check CHECK ((((status = 'revoked'::text) AND (revoked_at IS NOT NULL)) OR ((status <> 'revoked'::text) AND (revoked_at IS NULL)))),
    CONSTRAINT organization_user_resource_grants_session_fence_check CHECK ((((mode = 'always'::text) AND (session_id IS NULL) AND (authority_epoch IS NULL)) OR ((mode = ANY (ARRAY['once'::text, 'session'::text])) AND (session_id IS NOT NULL) AND (authority_epoch IS NOT NULL) AND (authority_epoch > 0)))),
    CONSTRAINT organization_user_resource_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'consumed'::text, 'revoked'::text, 'expired'::text])))
);

ALTER TABLE ONLY organization_user_resource_grants FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_resource_grants IS 'Opaque once/session/always user-resource grant identities; inert in Slice A.';

CREATE TABLE organization_user_retention_deletion_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    reason_code text,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_user_retention_deletion_events_kind_check CHECK ((kind = ANY (ARRAY['claimed'::text, 'failed'::text, 'completed'::text]))),
    CONSTRAINT organization_user_retention_deletion_events_reason_check CHECK ((((kind = 'failed'::text) AND (reason_code IS NOT NULL) AND (reason_code ~ '^[a-z0-9_]{1,64}$'::text)) OR ((kind = ANY (ARRAY['claimed'::text, 'completed'::text])) AND (reason_code IS NULL))))
);

ALTER TABLE ONLY organization_user_retention_deletion_events FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_retention_deletion_events IS 'Immutable content-free claim, failure and completion evidence for membership retention deletion.';

CREATE TABLE organization_user_retention_deletions (
    account_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    retention_until timestamp with time zone NOT NULL,
    state text DEFAULT 'claimed'::text NOT NULL,
    claim_operation_id uuid NOT NULL,
    claim_expires_at timestamp with time zone NOT NULL,
    attempt_count integer DEFAULT 1 NOT NULL,
    database_result jsonb,
    database_finalized_at timestamp with time zone,
    result jsonb,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_retention_deletions_db_finalized_chk CHECK ((((database_finalized_at IS NULL) AND (database_result IS NULL)) OR ((database_finalized_at IS NOT NULL) AND (database_result IS NOT NULL)))),
    CONSTRAINT organization_user_retention_deletions_attempt_check CHECK ((attempt_count > 0)),
    CONSTRAINT organization_user_retention_deletions_completion_check CHECK ((((state = 'completed'::text) AND (completed_at IS NOT NULL) AND (result IS NOT NULL)) OR ((state <> 'completed'::text) AND (completed_at IS NULL) AND (result IS NULL)))),
    CONSTRAINT organization_user_retention_deletions_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'failed'::text, 'completed'::text])))
);

ALTER TABLE ONLY organization_user_retention_deletions FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_retention_deletions IS 'Mutable, claim-fenced state for bounded destructive retention of one expired offboarded member.';

CREATE TABLE organization_user_retention_object_deletion_receipts (
    account_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    object_kind text NOT NULL,
    source_id text NOT NULL,
    object_bucket text NOT NULL,
    operation_id uuid NOT NULL,
    deleted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY organization_user_retention_object_deletion_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_retention_object_deletion_receipts IS 'Immutable content-free proof that one exact-bucket/key prepared retention cleanup obligation was deleted from external storage.';

CREATE TABLE organization_user_retention_object_obligations (
    account_id uuid NOT NULL,
    membership_id uuid NOT NULL,
    object_kind text NOT NULL,
    source_id text NOT NULL,
    object_bucket text NOT NULL,
    object_key text NOT NULL,
    prepared_operation_id uuid NOT NULL,
    object_key_hash text NOT NULL,
    prepared_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_user_retention_object_obligations_hash_check CHECK ((object_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT organization_user_retention_object_obligations_shape_check CHECK (((object_kind = ANY (ARRAY['file'::text, 'session_recording'::text, 'browser_state_artifact'::text, 'browser_state_upload'::text, 'transcription_recording_object'::text, 'video_staging_reference'::text, 'workspace_artifact_version'::text, 'editable_artifact_blob'::text, 'workspace_capture_manifest'::text, 'workspace_capture_tree_index'::text, 'workspace_capture_blob'::text])) AND ((octet_length(source_id) >= 1) AND (octet_length(source_id) <= 2048)) AND ((octet_length(convert_to(object_bucket, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(object_bucket, 'UTF8'::name)) <= 1024)) AND ((octet_length(convert_to(object_key, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(object_key, 'UTF8'::name)) <= 4096))))
);

ALTER TABLE ONLY organization_user_retention_object_obligations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_retention_object_obligations IS 'Immutable exact-bucket/key cleanup obligations prepared by database-first retention finalization; protected lifecycle capability only.';

CREATE TABLE organization_user_retention_policies (
    account_id uuid NOT NULL,
    mode text DEFAULT 'retain'::text NOT NULL,
    retention_days integer,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_membership_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_user_retention_policies_duration_check CHECK ((((mode = 'retain'::text) AND (retention_days IS NULL)) OR ((mode = 'delete_after'::text) AND (retention_days IS NOT NULL) AND ((retention_days >= 30) AND (retention_days <= 90))))),
    CONSTRAINT organization_user_retention_policies_mode_check CHECK ((mode = ANY (ARRAY['retain'::text, 'delete_after'::text]))),
    CONSTRAINT organization_user_retention_policies_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY organization_user_retention_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_user_setup_delivery_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    delivery_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    claim_holder_id uuid NOT NULL,
    claimed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    claim_expires_at timestamp with time zone NOT NULL,
    provider_started_at timestamp with time zone,
    result text,
    error_class text,
    provider_message_id text,
    settled_at timestamp with time zone,
    CONSTRAINT organization_user_setup_delivery_attempts_bounds_check CHECK (((attempt_number > 0) AND (claim_expires_at > claimed_at) AND ((result IS NULL) OR (result = ANY (ARRAY['sent'::text, 'failed'::text, 'outcome_unknown'::text, 'revoked'::text]))) AND ((error_class IS NULL) OR ((octet_length(convert_to(error_class, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(error_class, 'UTF8'::name)) <= 64))) AND ((provider_message_id IS NULL) OR ((octet_length(convert_to(provider_message_id, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(provider_message_id, 'UTF8'::name)) <= 255))))),
    CONSTRAINT organization_user_setup_delivery_attempts_settlement_check CHECK ((((result IS NULL) AND (settled_at IS NULL)) OR ((result IS NOT NULL) AND (settled_at IS NOT NULL))))
);

ALTER TABLE ONLY organization_user_setup_delivery_attempts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_setup_delivery_attempts IS 'Lifecycle-only immutable-attempt journal for invitation setup delivery provider boundaries.';

CREATE TABLE organization_user_setup_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    invitation_id uuid NOT NULL,
    token_digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    completion_operation_id uuid,
    completion_request_fingerprint text,
    completed_auth_user_id text,
    completion_result jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT organization_user_setup_intents_completion_check CHECK ((((status = 'pending'::text) AND (completion_operation_id IS NULL) AND (completion_request_fingerprint IS NULL) AND (completed_auth_user_id IS NULL) AND (completion_result IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completion_operation_id IS NOT NULL) AND (completion_request_fingerprint IS NOT NULL) AND (completion_request_fingerprint ~ '^[0-9a-f]{64}$'::text) AND (completed_auth_user_id IS NOT NULL) AND (completion_result IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT organization_user_setup_intents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text]))),
    CONSTRAINT organization_user_setup_intents_token_check CHECK ((token_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY organization_user_setup_intents FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE organization_user_setup_intents IS 'Invitation-bound hashed one-time account setup authority; no plaintext bearer or password is stored.';

CREATE TABLE organization_webhook_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    webhook_id uuid NOT NULL,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    failed_at timestamp with time zone,
    last_status integer,
    last_error text,
    claim_id uuid,
    claim_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_webhook_deliveries_attempts_chk CHECK ((attempts >= 0)),
    CONSTRAINT organization_webhook_deliveries_claim_chk CHECK (((claim_id IS NULL) = (claim_until IS NULL))),
    CONSTRAINT organization_webhook_deliveries_error_chk CHECK (((last_error IS NULL) OR (char_length(last_error) <= 2000))),
    CONSTRAINT organization_webhook_deliveries_payload_chk CHECK ((octet_length((payload)::text) <= 16384)),
    CONSTRAINT organization_webhook_deliveries_terminal_chk CHECK (((delivered_at IS NULL) OR (failed_at IS NULL)))
);

ALTER TABLE ONLY organization_webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    url text NOT NULL,
    secret_encrypted text NOT NULL,
    event_types text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    description text,
    workspace_filter jsonb,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organization_webhooks_description_chk CHECK (((description IS NULL) OR (char_length(description) <= 500))),
    CONSTRAINT organization_webhooks_event_types_chk CHECK ((((cardinality(event_types) >= 1) AND (cardinality(event_types) <= 32)) AND (event_types <@ ARRAY['turn.completed'::text, 'turn.failed'::text, 'turn.cancelled'::text, 'session.status.changed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'session.notification.posted'::text, 'session.notification.withdrawn'::text, 'recording.started'::text, 'recording.finished'::text, 'recording.transcript.ready'::text, 'recording.transcript.failed'::text, 'recording.transcript.current_changed'::text, 'recording.speakers.updated'::text, 'recording.notes.updated'::text, 'recording.deleted'::text]))),
    CONSTRAINT organization_webhooks_filter_chk CHECK (((workspace_filter IS NULL) OR ((jsonb_typeof(workspace_filter) = 'object'::text) AND ((workspace_filter - 'externalSource'::text) = '{}'::jsonb) AND (workspace_filter ? 'externalSource'::text) AND ((jsonb_typeof((workspace_filter -> 'externalSource'::text)) = 'string'::text) AND ((octet_length((workspace_filter ->> 'externalSource'::text)) >= 1) AND (octet_length((workspace_filter ->> 'externalSource'::text)) <= 200)))))),
    CONSTRAINT organization_webhooks_subject_chk CHECK (((created_by_subject_id IS NULL) OR ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)))),
    CONSTRAINT organization_webhooks_url_chk CHECK ((((char_length(url) >= 8) AND (char_length(url) <= 2048)) AND ((url ~~ 'https://%'::text) OR (url ~~ 'http://%'::text))))
);

ALTER TABLE ONLY organization_webhooks FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_workspace_lifecycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_membership_id uuid,
    workspace_id uuid NOT NULL,
    target_organization_membership_id uuid,
    target_workspace_membership_id uuid,
    kind text NOT NULL,
    role text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    actor_service_subject text,
    CONSTRAINT organization_workspace_lifecycle_actor_check CHECK ((((actor_membership_id IS NOT NULL) AND (actor_service_subject IS NULL)) OR ((actor_membership_id IS NULL) AND (actor_service_subject IS NOT NULL) AND (actor_service_subject ~ '^api_key:[0-9a-f-]{36}$'::text)))),
    CONSTRAINT organization_workspace_lifecycle_events_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'rename'::text, 'grant'::text, 'revoke'::text, 'update'::text]))),
    CONSTRAINT organization_workspace_lifecycle_events_role_check CHECK ((((kind = 'grant'::text) AND (role = ANY (ARRAY['viewer'::text, 'member'::text, 'admin'::text, 'custom'::text]))) OR ((kind <> 'grant'::text) AND (role IS NULL))))
);

ALTER TABLE ONLY organization_workspace_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_workspace_operation_receipts (
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    action text NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT organization_workspace_operation_receipts_action_check CHECK ((action = ANY (ARRAY['create'::text, 'rename'::text, 'grant'::text, 'revoke'::text, 'update'::text]))),
    CONSTRAINT organization_workspace_operation_receipts_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY organization_workspace_operation_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE personal_document_once_consumption_receipts (
    grant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    document_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_generation bigint NOT NULL,
    consumed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_document_once_consumption_receipts_generation_chk CHECK (((authority_generation > 0) AND (grant_generation > 0)))
);

ALTER TABLE ONLY personal_document_once_consumption_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE personal_github_repository_selection_heads (
    connection_id uuid NOT NULL,
    account_id uuid NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    provider_principal_id text NOT NULL,
    credential_binding_id uuid NOT NULL,
    connection_authority_generation bigint NOT NULL,
    generation bigint NOT NULL,
    updated_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_github_repository_selection_heads_generation_chk CHECK (((connection_authority_generation > 0) AND (generation > 0) AND ((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 512)) AND (provider_principal_id ~ '^[1-9][0-9]*$'::text)))
);

ALTER TABLE ONLY personal_github_repository_selection_heads FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE personal_github_repository_selection_heads IS 'Owner-only monotonic authority head for an explicit personal GitHub repository set.';

CREATE TABLE personal_github_repository_selection_operations (
    connection_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    account_id uuid NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    request_digest bytea NOT NULL,
    resulting_generation bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_github_repository_selection_operations_shape_chk CHECK (((resulting_generation > 0) AND ((octet_length(idempotency_key) >= 1) AND (octet_length(idempotency_key) <= 200)) AND ((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 512)) AND (octet_length(request_digest) = 32)))
);

ALTER TABLE ONLY personal_github_repository_selection_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE personal_github_repository_selections (
    connection_id uuid NOT NULL,
    repository_id bigint NOT NULL,
    account_id uuid NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    canonical_full_name text NOT NULL,
    canonical_https_uri text NOT NULL,
    default_branch text NOT NULL,
    visibility text NOT NULL,
    private boolean NOT NULL,
    archived boolean NOT NULL,
    disabled boolean NOT NULL,
    permissions jsonb NOT NULL,
    selected_access text NOT NULL,
    selection_generation bigint NOT NULL,
    selected_by_subject_id text NOT NULL,
    selected_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    verified_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_github_repository_selections_shape_chk CHECK (((repository_id > 0) AND (selection_generation > 0) AND (selected_access = ANY (ARRAY['read'::text, 'write'::text])) AND (visibility = ANY (ARRAY['public'::text, 'private'::text, 'internal'::text])) AND (private = (visibility = 'private'::text)) AND ((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 512)) AND (canonical_full_name ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$'::text) AND ((octet_length(canonical_full_name) >= 3) AND (octet_length(canonical_full_name) <= 140)) AND ((octet_length(default_branch) >= 1) AND (octet_length(default_branch) <= 255)) AND (canonical_https_uri = ('https://github.com/'::text || canonical_full_name)) AND (jsonb_typeof(permissions) = 'object'::text) AND (permissions ?& ARRAY['pull'::text, 'push'::text, 'admin'::text, 'maintain'::text, 'triage'::text]) AND ((permissions - ARRAY['pull'::text, 'push'::text, 'admin'::text, 'maintain'::text, 'triage'::text]) = '{}'::jsonb) AND (jsonb_typeof((permissions -> 'pull'::text)) = 'boolean'::text) AND (jsonb_typeof((permissions -> 'push'::text)) = 'boolean'::text) AND (jsonb_typeof((permissions -> 'admin'::text)) = 'boolean'::text) AND (jsonb_typeof((permissions -> 'maintain'::text)) = 'boolean'::text) AND (jsonb_typeof((permissions -> 'triage'::text)) = 'boolean'::text) AND (((permissions -> 'pull'::text) = 'true'::jsonb) OR ((permissions -> 'push'::text) = 'true'::jsonb) OR ((permissions -> 'admin'::text) = 'true'::jsonb) OR ((permissions -> 'maintain'::text) = 'true'::jsonb) OR ((permissions -> 'triage'::text) = 'true'::jsonb)) AND ((selected_access <> 'write'::text) OR ((NOT archived) AND (NOT disabled) AND (((permissions -> 'push'::text) = 'true'::jsonb) OR ((permissions -> 'admin'::text) = 'true'::jsonb) OR ((permissions -> 'maintain'::text) = 'true'::jsonb))))))
);

ALTER TABLE ONLY personal_github_repository_selections FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE personal_github_repository_selections IS 'Only explicitly selected personal GitHub repositories; never a private discovery catalog.';

CREATE TABLE personal_resource_once_consumption_receipts (
    grant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_generation bigint NOT NULL,
    consumed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT personal_resource_once_consumption_receipts_generation_chk CHECK (((execution_generation > 0) AND (authority_generation > 0) AND (grant_generation > 0)))
);

ALTER TABLE ONLY personal_resource_once_consumption_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE personal_resource_once_consumption_receipts IS 'Unique first-use receipt binding one consumed once grant to its exact accepted attempt.';

CREATE TABLE pr_review_app_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    provider text NOT NULL,
    provider_base_url text NOT NULL,
    app_id text,
    credential_kind text NOT NULL,
    credential_encrypted text,
    access_token_expires_at timestamp with time zone,
    webhook_auth_kind text NOT NULL,
    webhook_username text,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    installation_id text,
    provider_account_login text,
    provider_account_type text,
    github_actor_id text,
    authority_kind text,
    authority_checked_at timestamp with time zone,
    authority_expires_at timestamp with time zone,
    authority_nonce text,
    CONSTRAINT pr_review_app_registrations_credential_chk CHECK ((((provider = 'github'::text) AND (credential_kind = 'github_app'::text) AND (credential_encrypted IS NOT NULL) AND (app_id IS NOT NULL) AND (installation_id IS NULL)) OR ((provider = 'github'::text) AND (credential_kind = 'managed_github_app'::text) AND (credential_encrypted IS NULL) AND (app_id IS NOT NULL) AND (installation_id IS NOT NULL) AND (provider_account_type = ANY (ARRAY['User'::text, 'Organization'::text])) AND (github_actor_id ~ '^[1-9][0-9]*$'::text) AND (authority_kind = ANY (ARRAY['personal_owner'::text, 'organization_owner'::text])) AND (authority_checked_at IS NOT NULL) AND (authority_expires_at IS NOT NULL) AND (authority_expires_at > authority_checked_at) AND ((octet_length(authority_nonce) >= 16) AND (octet_length(authority_nonce) <= 256))) OR ((provider = ANY (ARRAY['gitlab'::text, 'azure_devops'::text])) AND (credential_kind = 'provider_token'::text) AND (credential_encrypted IS NOT NULL) AND (installation_id IS NULL)))),
    CONSTRAINT pr_review_app_registrations_provider_chk CHECK ((provider = ANY (ARRAY['github'::text, 'gitlab'::text, 'azure_devops'::text]))),
    CONSTRAINT pr_review_app_registrations_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text]))),
    CONSTRAINT pr_review_app_registrations_webhook_auth_chk CHECK ((((provider = 'github'::text) AND (webhook_auth_kind = 'hmac_sha256'::text)) OR ((provider = 'gitlab'::text) AND (webhook_auth_kind = 'shared_token'::text)) OR ((provider = 'azure_devops'::text) AND (webhook_auth_kind = 'basic'::text) AND (webhook_username IS NOT NULL))))
);

ALTER TABLE ONLY pr_review_app_registrations FORCE ROW LEVEL SECURITY;

CREATE TABLE pr_review_managed_github_authority_nonces (
    authority_nonce text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    installation_id text NOT NULL,
    authority_expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT pr_review_managed_github_authority_nonces_identity_chk CHECK ((((octet_length(authority_nonce) >= 16) AND (octet_length(authority_nonce) <= 256)) AND (installation_id ~ '^[1-9][0-9]*$'::text) AND (authority_expires_at > consumed_at)))
);

ALTER TABLE ONLY pr_review_managed_github_authority_nonces FORCE ROW LEVEL SECURITY;

CREATE TABLE pr_review_managed_github_routes (
    binding_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    registration_id uuid NOT NULL,
    source_id uuid NOT NULL,
    installation_id text NOT NULL,
    provider_repository_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pr_review_managed_github_routes_identity_chk CHECK (((installation_id ~ '^[1-9][0-9]*$'::text) AND (provider_repository_id ~ '^[1-9][0-9]*$'::text)))
);

CREATE TABLE pr_review_repository_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trigger_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    registration_id uuid NOT NULL,
    provider text NOT NULL,
    repository_uri text NOT NULL,
    repository_full_name text NOT NULL,
    provider_repository_id text NOT NULL,
    installation_id text,
    project_id text,
    model text,
    additional_instructions text,
    status text DEFAULT 'active'::text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pr_review_repository_bindings_provider_chk CHECK ((provider = ANY (ARRAY['github'::text, 'gitlab'::text, 'azure_devops'::text]))),
    CONSTRAINT pr_review_repository_bindings_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);

ALTER TABLE ONLY pr_review_repository_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE preference_registry_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    stable_key text NOT NULL,
    scope text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    status text DEFAULT 'proposed'::text NOT NULL,
    scope_version integer DEFAULT 1 NOT NULL,
    activation_version integer DEFAULT 0 NOT NULL,
    active_revision_id uuid,
    active_revision bigint,
    active_content_hash text,
    superseded_by_preference_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT preference_registry_preferences_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT preference_registry_preferences_head_shape_chk CHECK ((((active_revision_id IS NULL) AND (active_revision IS NULL) AND (active_content_hash IS NULL)) OR ((active_revision_id IS NOT NULL) AND (active_revision > 0) AND (active_content_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT preference_registry_preferences_key_chk CHECK ((((length(stable_key) >= 1) AND (length(stable_key) <= 96)) AND (stable_key = lower(btrim(stable_key))) AND (stable_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (stable_key !~ '--'::text))),
    CONSTRAINT preference_registry_preferences_scope_shape_chk CHECK ((((scope = 'organization'::text) AND (scope_workspace_id IS NULL) AND (scope_subject_id IS NULL)) OR ((scope = 'workspace'::text) AND (scope_workspace_id IS NOT NULL) AND (scope_subject_id IS NULL)) OR ((scope = 'user'::text) AND (scope_workspace_id IS NULL) AND (scope_subject_id IS NOT NULL)))),
    CONSTRAINT preference_registry_preferences_status_chk CHECK ((status = ANY (ARRAY['proposed'::text, 'active'::text, 'inactive'::text, 'rejected'::text, 'superseded'::text]))),
    CONSTRAINT preference_registry_preferences_versions_chk CHECK (((scope_version > 0) AND (activation_version >= 0)))
);

ALTER TABLE ONLY preference_registry_preferences FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE preference_registry_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE preference_registry_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    preference_id uuid NOT NULL,
    revision bigint DEFAULT nextval('preference_registry_revision_seq'::regclass) NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    content text NOT NULL,
    content_hash text NOT NULL,
    precedence_rank integer DEFAULT 0 NOT NULL,
    conflict_strategy text NOT NULL,
    conflicts_with jsonb DEFAULT '[]'::jsonb NOT NULL,
    provenance_source text NOT NULL,
    provenance_source_id text,
    trust text NOT NULL,
    expires_at timestamp with time zone,
    corrects_revision_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    skill_files jsonb,
    skill_activation_mode text,
    skill_removal_operation_id uuid,
    CONSTRAINT preference_registry_revisions_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT preference_registry_revisions_hash_chk CHECK (((content_hash ~ '^[0-9a-f]{64}$'::text) AND (content_hash = encode(sha256(convert_to(content, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT preference_registry_revisions_precedence_chk CHECK ((((precedence_rank >= '-1000'::integer) AND (precedence_rank <= 1000)) AND (conflict_strategy = ANY (ARRAY['override'::text, 'merge'::text, 'reject'::text, 'inform'::text])) AND (jsonb_typeof(conflicts_with) = 'array'::text) AND (jsonb_array_length(conflicts_with) <= 32))),
    CONSTRAINT preference_registry_revisions_provenance_chk CHECK (((provenance_source = ANY (ARRAY['human'::text, 'onboarding'::text, 'knowledge_proposal'::text, 'imported_document'::text, 'slack'::text, 'meeting_transcript'::text, 'call_transcript'::text, 'agent'::text, 'portable_skill'::text])) AND (trust = ANY (ARRAY['untrusted_proposal'::text, 'personal'::text, 'workspace_managed'::text, 'organization_managed'::text])) AND ((provenance_source_id IS NULL) OR ((length(provenance_source_id) >= 1) AND (length(provenance_source_id) <= 512))) AND ((provenance_source = ANY (ARRAY['human'::text, 'onboarding'::text])) OR (provenance_source_id IS NOT NULL)))),
    CONSTRAINT preference_registry_revisions_revision_chk CHECK ((revision > 0)),
    CONSTRAINT preference_registry_revisions_skill_activation_mode_check CHECK ((skill_activation_mode = ANY (ARRAY['workspace_managed'::text, 'session_selected'::text]))),
    CONSTRAINT preference_registry_revisions_text_chk CHECK ((((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120)) AND ((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 1024)) AND (length(btrim(content)) > 0) AND (length(content) <= 2097152))),
    CONSTRAINT preference_registry_skill_files_chk CHECK (((skill_files IS NULL) OR (skill_files_valid(skill_files) AND (content = (jsonb_path_query_first(skill_files, '$[*]?(@."path" == "SKILL.md")."content"'::jsonpath) #>> '{}'::text[])))))
);

ALTER TABLE ONLY preference_registry_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE private_session_create_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    owner_membership_id uuid NOT NULL,
    parent_session_id uuid,
    actor_turn_id uuid,
    actor_attempt_id uuid,
    actor_execution_generation integer,
    CONSTRAINT private_session_create_capability_lane_check CHECK ((((parent_session_id IS NULL) AND (actor_turn_id IS NULL) AND (actor_attempt_id IS NULL) AND (actor_execution_generation IS NULL)) OR ((parent_session_id IS NOT NULL) AND (actor_turn_id IS NOT NULL) AND (actor_attempt_id IS NOT NULL) AND (actor_execution_generation > 0))))
);

ALTER TABLE ONLY private_session_create_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_chunks (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    track_number integer NOT NULL,
    chunk_number integer NOT NULL,
    byte_length integer NOT NULL,
    sha256 text NOT NULL,
    start_milliseconds integer NOT NULL,
    duration_milliseconds integer NOT NULL,
    object_key text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    uploaded_at timestamp with time zone,
    CONSTRAINT recording_chunks_values_chk CHECK ((((chunk_number >= 0) AND (chunk_number <= 100000)) AND (byte_length > 0) AND (sha256 ~ '^[0-9a-f]{64}$'::text) AND (start_milliseconds >= 0) AND (duration_milliseconds >= 0) AND ((octet_length(object_key) >= 1) AND (octet_length(object_key) <= 1024)) AND (((state = 'pending'::text) AND (uploaded_at IS NULL)) OR ((state = 'uploaded'::text) AND (uploaded_at IS NOT NULL)))))
);

ALTER TABLE ONLY recording_chunks FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    visibility text NOT NULL,
    type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recording_events_type_chk CHECK ((type = ANY (ARRAY['recording.started'::text, 'recording.finished'::text, 'recording.transcript.ready'::text, 'recording.transcript.failed'::text, 'recording.transcript.current_changed'::text, 'recording.speakers.updated'::text, 'recording.notes.updated'::text, 'recording.deleted'::text]))),
    CONSTRAINT recording_events_values_chk CHECK ((((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 1024)) AND (jsonb_typeof(data) = 'object'::text) AND (octet_length((data)::text) <= 16384))),
    CONSTRAINT recording_events_visibility_chk CHECK ((visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))
);

ALTER TABLE ONLY recording_events FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_live_segments (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    track_number integer NOT NULL,
    segment_number integer NOT NULL,
    start_milliseconds integer NOT NULL,
    end_milliseconds integer NOT NULL,
    text text NOT NULL,
    sequence bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_live_segments_values_chk CHECK (((segment_number >= 0) AND (start_milliseconds >= 0) AND (end_milliseconds >= start_milliseconds) AND (octet_length(text) <= 65536)))
);

ALTER TABLE ONLY recording_live_segments FORCE ROW LEVEL SECURITY;

ALTER TABLE recording_live_segments ALTER COLUMN sequence ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME recording_live_segments_sequence_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE recording_notes (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    updated_by_subject_id text NOT NULL,
    updated_by_session_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT recording_notes_kind_chk CHECK ((kind = ANY (ARRAY['notepad'::text, 'notes'::text]))),
    CONSTRAINT recording_notes_values_chk CHECK (((octet_length(body) <= 262144) AND (revision >= 1) AND ((octet_length(updated_by_subject_id) >= 1) AND (octet_length(updated_by_subject_id) <= 1024))))
);

ALTER TABLE ONLY recording_notes FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_people (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    display_name text NOT NULL,
    member_subject_id text,
    email text,
    external_ref text,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    voice_consent text,
    voice_consent_by_subject_id text,
    voice_consented_at timestamp with time zone,
    CONSTRAINT recording_people_values_chk CHECK ((((char_length(btrim(display_name)) >= 1) AND (char_length(btrim(display_name)) <= 200)) AND ((member_subject_id IS NULL) OR ((octet_length(member_subject_id) >= 1) AND (octet_length(member_subject_id) <= 1024))) AND ((email IS NULL) OR ((octet_length(email) >= 3) AND (octet_length(email) <= 320))) AND ((external_ref IS NULL) OR ((octet_length(external_ref) >= 1) AND (octet_length(external_ref) <= 512))) AND ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)))),
    CONSTRAINT recording_people_voice_consent_chk CHECK ((((voice_consent IS NULL) AND (voice_consent_by_subject_id IS NULL) AND (voice_consented_at IS NULL)) OR ((voice_consent = ANY (ARRAY['self'::text, 'attested'::text])) AND ((octet_length(voice_consent_by_subject_id) >= 1) AND (octet_length(voice_consent_by_subject_id) <= 1024)) AND (voice_consented_at IS NOT NULL))))
);

ALTER TABLE ONLY recording_people FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_segment_edits (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    version_id uuid NOT NULL,
    segment_index integer NOT NULL,
    speaker_label text,
    text text,
    edited_by_subject_id text NOT NULL,
    edited_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recording_segment_edits_values_chk CHECK (((segment_index >= 0) AND ((speaker_label IS NOT NULL) OR (text IS NOT NULL)) AND ((speaker_label IS NULL) OR ((octet_length(speaker_label) >= 1) AND (octet_length(speaker_label) <= 128))) AND ((text IS NULL) OR (octet_length(text) <= 65536)) AND ((octet_length(edited_by_subject_id) >= 1) AND (octet_length(edited_by_subject_id) <= 1024))))
);

ALTER TABLE ONLY recording_segment_edits FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_speaker_assignments (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    version_id uuid NOT NULL,
    speaker_label text NOT NULL,
    person_id uuid,
    display_name text,
    source text NOT NULL,
    confidence real,
    assigned_by_subject_id text,
    assigned_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recording_speaker_assignments_source_chk CHECK ((source = ANY (ARRAY['confirmed'::text, 'suggested'::text, 'carried_over'::text, 'track'::text]))),
    CONSTRAINT recording_speaker_assignments_values_chk CHECK ((((octet_length(speaker_label) >= 1) AND (octet_length(speaker_label) <= 128)) AND ((person_id IS NOT NULL) OR (display_name IS NOT NULL)) AND ((display_name IS NULL) OR ((char_length(btrim(display_name)) >= 1) AND (char_length(btrim(display_name)) <= 200))) AND ((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))) AND ((assigned_by_subject_id IS NULL) OR ((octet_length(assigned_by_subject_id) >= 1) AND (octet_length(assigned_by_subject_id) <= 1024)))))
);

ALTER TABLE ONLY recording_speaker_assignments FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_speaker_voices (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    version_id uuid NOT NULL,
    speaker_label text NOT NULL,
    channel text NOT NULL,
    model text NOT NULL,
    embedding real[] NOT NULL,
    speech_milliseconds integer NOT NULL,
    learned_person_id uuid,
    CONSTRAINT recording_speaker_voices_values_chk CHECK ((((octet_length(speaker_label) >= 1) AND (octet_length(speaker_label) <= 128)) AND (channel = ANY (ARRAY['microphone'::text, 'call'::text, 'room'::text])) AND ((octet_length(model) >= 1) AND (octet_length(model) <= 128)) AND ((cardinality(embedding) >= 1) AND (cardinality(embedding) <= 1024)) AND (speech_milliseconds >= 0)))
);

ALTER TABLE ONLY recording_speaker_voices FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_tracks (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    track_number integer NOT NULL,
    kind text DEFAULT 'audio'::text NOT NULL,
    source text NOT NULL,
    mime_type text NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    total_bytes bigint DEFAULT 0 NOT NULL,
    duration_milliseconds integer DEFAULT 0 NOT NULL,
    prepared_object_key text,
    prepared_bytes bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    live_provider_id text,
    live_model text,
    live_streamed_milliseconds integer DEFAULT 0 NOT NULL,
    live_cost_usd_micros bigint,
    prepared_sha256 text,
    video_width integer,
    video_height integer,
    video_frame_count integer,
    CONSTRAINT recording_tracks_kind_chk CHECK ((kind = ANY (ARRAY['audio'::text, 'video'::text]))),
    CONSTRAINT recording_tracks_source_chk CHECK ((source = ANY (ARRAY['microphone'::text, 'system'::text, 'mixed'::text, 'upload'::text, 'browser_tab'::text]))),
    CONSTRAINT recording_tracks_values_chk CHECK ((((track_number >= 0) AND (track_number <= 7)) AND ((octet_length(mime_type) >= 1) AND (octet_length(mime_type) <= 128)) AND (chunk_count >= 0) AND (total_bytes >= 0) AND (duration_milliseconds >= 0) AND ((prepared_object_key IS NULL) = (prepared_bytes IS NULL)) AND ((prepared_object_key IS NULL) OR ((octet_length(prepared_object_key) >= 1) AND (octet_length(prepared_object_key) <= 1024))) AND ((prepared_bytes IS NULL) OR (prepared_bytes > 0)))),
    CONSTRAINT recording_tracks_video_chk CHECK ((((prepared_sha256 IS NULL) OR (prepared_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((video_width IS NULL) OR ((video_width >= 1) AND (video_width <= 100000))) AND ((video_height IS NULL) OR ((video_height >= 1) AND (video_height <= 100000))) AND ((video_frame_count IS NULL) OR (video_frame_count >= 1)) AND ((kind = 'video'::text) OR ((video_width IS NULL) AND (video_height IS NULL) AND (video_frame_count IS NULL)))))
);

ALTER TABLE ONLY recording_tracks FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_transcript_segments (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    version_id uuid NOT NULL,
    segment_index integer NOT NULL,
    start_milliseconds integer NOT NULL,
    end_milliseconds integer NOT NULL,
    track_number integer,
    speaker_label text,
    text text NOT NULL,
    words jsonb,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, text)) STORED,
    CONSTRAINT recording_transcript_segments_values_chk CHECK (((segment_index >= 0) AND (start_milliseconds >= 0) AND (end_milliseconds >= start_milliseconds) AND ((track_number IS NULL) OR ((track_number >= 0) AND (track_number <= 7))) AND ((speaker_label IS NULL) OR ((octet_length(speaker_label) >= 1) AND (octet_length(speaker_label) <= 128))) AND (octet_length(text) <= 65536) AND ((words IS NULL) OR (jsonb_typeof(words) = 'array'::text))))
);

ALTER TABLE ONLY recording_transcript_segments FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_transcript_versions (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    version_number integer NOT NULL,
    provider_id text NOT NULL,
    model text NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    languages text[] DEFAULT '{}'::text[] NOT NULL,
    diarized boolean DEFAULT false NOT NULL,
    diarization text,
    audio_milliseconds integer DEFAULT 0 NOT NULL,
    segment_count integer DEFAULT 0 NOT NULL,
    cost_usd_micros bigint,
    requested_by_subject_id text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    processing_owner uuid,
    processing_started_at timestamp with time zone,
    error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    credit_attribution jsonb,
    credit_cost_micros bigint,
    CONSTRAINT recording_transcript_versions_state_chk CHECK ((state = ANY (ARRAY['queued'::text, 'processing'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT recording_transcript_versions_values_chk CHECK (((version_number >= 1) AND ((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 128)) AND ((octet_length(model) >= 1) AND (octet_length(model) <= 128)) AND (jsonb_typeof(options) = 'object'::text) AND (octet_length((options)::text) <= 16384) AND (cardinality(languages) <= 16) AND (audio_milliseconds >= 0) AND (segment_count >= 0) AND ((diarization IS NULL) OR (diarization = ANY (ARRAY['provider'::text, 'ours'::text, 'tracks'::text, 'none'::text]))) AND ((cost_usd_micros IS NULL) OR (cost_usd_micros >= 0)) AND (attempt_count >= 0) AND ((octet_length(requested_by_subject_id) >= 1) AND (octet_length(requested_by_subject_id) <= 1024)) AND ((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 128))) AND ((processing_owner IS NULL) = (processing_started_at IS NULL)) AND ((NOT is_current) OR (state = 'complete'::text)) AND ((state = ANY (ARRAY['complete'::text, 'failed'::text])) = (completed_at IS NOT NULL))))
);

ALTER TABLE ONLY recording_transcript_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_voice_rejections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    recording_id uuid NOT NULL,
    person_id uuid NOT NULL,
    model text NOT NULL,
    embedding real[] NOT NULL,
    rejected_by_subject_id text NOT NULL,
    rejected_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recording_voice_rejections_values_chk CHECK ((((octet_length(model) >= 1) AND (octet_length(model) <= 128)) AND ((cardinality(embedding) >= 1) AND (cardinality(embedding) <= 1024)) AND ((octet_length(rejected_by_subject_id) >= 1) AND (octet_length(rejected_by_subject_id) <= 1024))))
);

ALTER TABLE ONLY recording_voice_rejections FORCE ROW LEVEL SECURITY;

CREATE TABLE recording_voiceprints (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    person_id uuid NOT NULL,
    channel text NOT NULL,
    model text NOT NULL,
    embedding real[] NOT NULL,
    speech_milliseconds bigint DEFAULT 0 NOT NULL,
    sample_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT recording_voiceprints_values_chk CHECK (((channel = ANY (ARRAY['microphone'::text, 'call'::text, 'room'::text])) AND ((octet_length(model) >= 1) AND (octet_length(model) <= 128)) AND ((cardinality(embedding) >= 1) AND (cardinality(embedding) <= 1024)) AND (speech_milliseconds >= 0) AND (sample_count >= 0)))
);

ALTER TABLE ONLY recording_voiceprints FORCE ROW LEVEL SECURITY;

CREATE TABLE recordings (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    visibility text DEFAULT 'user_private'::text NOT NULL,
    title text NOT NULL,
    state text DEFAULT 'capturing'::text NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    capture_ended_at timestamp with time zone,
    duration_milliseconds integer DEFAULT 0 NOT NULL,
    external_ref text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    transcription jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    purpose text DEFAULT 'meeting'::text NOT NULL,
    error_code text,
    error_message text,
    audio_deleted_at timestamp with time zone,
    CONSTRAINT recordings_purpose_chk CHECK (((purpose = ANY (ARRAY['meeting'::text, 'browser'::text, 'dictation'::text])) AND ((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 128))) AND ((error_message IS NULL) OR ((octet_length(error_message) >= 1) AND (octet_length(error_message) <= 2048))))),
    CONSTRAINT recordings_state_chk CHECK ((state = ANY (ARRAY['capturing'::text, 'processing'::text, 'ready'::text, 'failed'::text, 'deleting'::text]))),
    CONSTRAINT recordings_values_chk CHECK ((((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 1024)) AND ((char_length(title) >= 1) AND (char_length(title) <= 300)) AND (duration_milliseconds >= 0) AND ((external_ref IS NULL) OR ((octet_length(external_ref) >= 1) AND (octet_length(external_ref) <= 512))) AND (jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 16384) AND (jsonb_typeof(transcription) = 'object'::text) AND (octet_length((transcription)::text) <= 16384) AND ((state = 'capturing'::text) = (capture_ended_at IS NULL)))),
    CONSTRAINT recordings_visibility_chk CHECK ((visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))
);

ALTER TABLE ONLY recordings FORCE ROW LEVEL SECURITY;

CREATE TABLE retained_screenshot_artifacts (
    artifact_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    attempt_id uuid,
    settlement_key text NOT NULL,
    tool_call_id text NOT NULL,
    tool_output_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    media_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    retention_expires_at timestamp with time zone NOT NULL,
    ready_at timestamp with time zone,
    cleanup_reason text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    quota_state text DEFAULT 'reserved'::text NOT NULL,
    maintenance_claim_id uuid,
    maintenance_claimed_at timestamp with time zone,
    private_file_owner_subject_id text DEFAULT NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text),
    CONSTRAINT retained_screenshot_artifacts_claim_shape_chk CHECK ((((status = ANY (ARRAY['reconciling'::text, 'cleanup_pending'::text])) AND (maintenance_claim_id IS NOT NULL) AND (maintenance_claimed_at IS NOT NULL)) OR ((status <> ALL (ARRAY['reconciling'::text, 'cleanup_pending'::text])) AND (maintenance_claim_id IS NULL) AND (maintenance_claimed_at IS NULL)))),
    CONSTRAINT retained_screenshot_artifacts_cleanup_reason_chk CHECK ((((status = ANY (ARRAY['pending'::text, 'reconciling'::text, 'ready'::text])) AND (cleanup_reason IS NULL)) OR ((status = ANY (ARRAY['cleanup_queued'::text, 'cleanup_pending'::text, 'failed'::text, 'expired'::text, 'deleted'::text])) AND (cleanup_reason IS NOT NULL)))),
    CONSTRAINT retained_screenshot_artifacts_dimensions_chk CHECK ((((width >= 1) AND (width <= 16384)) AND ((height >= 1) AND (height <= 16384)) AND (((width)::bigint * (height)::bigint) <= 67108864))),
    CONSTRAINT retained_screenshot_artifacts_media_type_v2_chk CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
    CONSTRAINT retained_screenshot_artifacts_quota_state_chk CHECK ((quota_state = ANY (ARRAY['reserved'::text, 'ready'::text, 'released'::text]))),
    CONSTRAINT retained_screenshot_artifacts_ready_shape_chk CHECK ((((status = 'ready'::text) AND (ready_at IS NOT NULL)) OR ((status = ANY (ARRAY['pending'::text, 'reconciling'::text])) AND (ready_at IS NULL)) OR (status = ANY (ARRAY['cleanup_queued'::text, 'cleanup_pending'::text, 'failed'::text, 'expired'::text, 'deleted'::text])))),
    CONSTRAINT retained_screenshot_artifacts_sha256_chk CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT retained_screenshot_artifacts_size_chk CHECK (((size_bytes > 0) AND (size_bytes <= 33554432))),
    CONSTRAINT retained_screenshot_artifacts_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'reconciling'::text, 'ready'::text, 'cleanup_queued'::text, 'cleanup_pending'::text, 'failed'::text, 'expired'::text, 'deleted'::text]))),
    CONSTRAINT retained_screenshot_artifacts_status_quota_chk CHECK ((((status = ANY (ARRAY['pending'::text, 'reconciling'::text])) AND (quota_state = 'reserved'::text)) OR ((status = 'ready'::text) AND (quota_state = 'ready'::text)) OR ((status = ANY (ARRAY['cleanup_queued'::text, 'cleanup_pending'::text])) AND (quota_state = ANY (ARRAY['reserved'::text, 'ready'::text]))) OR ((status = ANY (ARRAY['failed'::text, 'expired'::text, 'deleted'::text])) AND (quota_state = 'released'::text))))
);

ALTER TABLE ONLY retained_screenshot_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE rig_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    rig_id uuid NOT NULL,
    base_version_id uuid,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    proposed_by text,
    verification jsonb,
    result_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payload_codec_version integer,
    verification_codec_version integer,
    CONSTRAINT rig_changes_kind_check CHECK ((kind = ANY (ARRAY['setup_append'::text, 'definition_edit'::text]))),
    CONSTRAINT rig_changes_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'verifying'::text, 'merged'::text, 'rejected'::text, 'failed'::text])))
);

ALTER TABLE ONLY rig_changes FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN rig_changes.payload IS 'Canonical lossless rig-change payload; public summaries are separate projections.';

COMMENT ON COLUMN rig_changes.verification IS 'Canonical lossless rig-verification result; public summaries are separate projections.';

CREATE TABLE rig_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    rig_id uuid NOT NULL,
    version integer NOT NULL,
    image text,
    setup_script text,
    checks jsonb DEFAULT '[]'::jsonb NOT NULL,
    credential_hooks jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_variable_set_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    changelog text,
    created_by text,
    active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    provider_images jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT rig_versions_provider_images_object_chk CHECK ((jsonb_typeof(provider_images) = 'object'::text))
);

ALTER TABLE ONLY rig_versions FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN rig_versions.image IS 'Legacy audit field only. Runtime ignores it and new non-null values are rejected.';

CREATE TABLE rigs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    authority_id uuid,
    owner_organization_membership_id uuid,
    origin_workspace_id uuid,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT rigs_authority_scope_check CHECK ((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text, 'user'::text]))),
    CONSTRAINT rigs_authority_shape_check CHECK ((((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text])) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (authority_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL)))),
    CONSTRAINT rigs_generation_check CHECK ((generation > 0)),
    CONSTRAINT rigs_revocation_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT rigs_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY rigs FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN rigs.authority_scope IS 'Explicit owner scope: organization, workspace, or organization+user.';

CREATE TABLE sandbox_checkpoint_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sandbox_group_id uuid NOT NULL,
    source_lease_id uuid NOT NULL,
    source_lease_epoch integer NOT NULL,
    source_instance_id text,
    source_workspace_generation integer,
    provenance text NOT NULL,
    provider_backend text NOT NULL,
    provider_binding_key text NOT NULL,
    provider_binding jsonb NOT NULL,
    object_kind text NOT NULL,
    object_id text NOT NULL,
    archive_base64 text NOT NULL,
    archive_sha256 text NOT NULL,
    archive_bytes integer NOT NULL,
    descriptor jsonb NOT NULL,
    descriptor_revision text NOT NULL,
    state text DEFAULT 'candidate'::text NOT NULL,
    delete_after timestamp with time zone,
    delete_attempts integer DEFAULT 0 NOT NULL,
    delete_claim_id uuid,
    delete_claimed_at timestamp with time zone,
    last_delete_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    deleted_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sandbox_checkpoint_artifacts_archive_check CHECK (((archive_bytes > 0) AND (octet_length(archive_base64) > 0) AND (archive_sha256 ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(descriptor) = 'object'::text) AND ((octet_length(descriptor_revision) >= 1) AND (octet_length(descriptor_revision) <= 256)) AND (translate(encode(decode(archive_base64, 'base64'::text), 'base64'::text), '
'::text, ''::text) = archive_base64) AND (octet_length(decode(archive_base64, 'base64'::text)) = archive_bytes) AND (encode(digest(decode(archive_base64, 'base64'::text), 'sha256'::text), 'hex'::text) = archive_sha256) AND ((descriptor ->> 'version'::text) = '2'::text) AND ((descriptor ->> 'kind'::text) = 'provider_snapshot'::text) AND ((descriptor ->> 'revision'::text) = descriptor_revision) AND ((descriptor ->> 'archiveSha256'::text) = archive_sha256) AND
CASE
    WHEN ((descriptor ->> 'archiveBytes'::text) ~ '^[1-9][0-9]*$'::text) THEN (((descriptor ->> 'archiveBytes'::text))::bigint = archive_bytes)
    ELSE false
END AND ((descriptor ->> 'snapshotId'::text) = object_id) AND (((object_kind = 'modal_filesystem_snapshot'::text) AND ((descriptor ->> 'provider'::text) = 'modal_snapshot_filesystem'::text) AND ((descriptor ->> 'workspacePersistence'::text) = 'snapshot_filesystem'::text)) OR ((object_kind = 'modal_directory_snapshot'::text) AND ((descriptor ->> 'provider'::text) = 'modal_snapshot_directory'::text) AND ((descriptor ->> 'workspacePersistence'::text) = 'snapshot_directory'::text))))),
    CONSTRAINT sandbox_checkpoint_artifacts_delete_claim_check CHECK ((((state = 'deleting'::text) AND (delete_claim_id IS NOT NULL) AND (delete_claimed_at IS NOT NULL)) OR ((state <> 'deleting'::text) AND (delete_claim_id IS NULL) AND (delete_claimed_at IS NULL)))),
    CONSTRAINT sandbox_checkpoint_artifacts_provider_check CHECK (((provider_backend = 'modal'::text) AND ((octet_length(provider_binding_key) >= 1) AND (octet_length(provider_binding_key) <= 1024)) AND (jsonb_typeof(provider_binding) = 'object'::text) AND ((provider_binding_key)::jsonb = provider_binding) AND (provider_binding_key = format('{"version":1,"serverUrl":%s,"workspaceName":%s,"environment":%s}'::text, (to_jsonb((provider_binding ->> 'serverUrl'::text)))::text, (to_jsonb((provider_binding ->> 'workspaceName'::text)))::text, (to_jsonb((provider_binding ->> 'environment'::text)))::text)) AND (provider_binding = jsonb_build_object('version', 1, 'serverUrl', (provider_binding ->> 'serverUrl'::text), 'workspaceName', (provider_binding ->> 'workspaceName'::text), 'environment', (provider_binding ->> 'environment'::text))) AND (COALESCE(octet_length((provider_binding ->> 'serverUrl'::text)), 0) > 0) AND (COALESCE(octet_length((provider_binding ->> 'workspaceName'::text)), 0) > 0) AND ((provider_binding ->> 'environment'::text) IS NOT NULL) AND (object_kind = ANY (ARRAY['modal_filesystem_snapshot'::text, 'modal_directory_snapshot'::text])) AND ((octet_length(object_id) >= 1) AND (octet_length(object_id) <= 1024)))),
    CONSTRAINT sandbox_checkpoint_artifacts_source_check CHECK (((source_lease_epoch >= 0) AND (((provenance = 'native_capture'::text) AND (source_workspace_generation IS NOT NULL) AND (source_workspace_generation >= 0) AND (source_instance_id IS NOT NULL) AND ((octet_length(source_instance_id) >= 1) AND (octet_length(source_instance_id) <= 512))) OR ((provenance = 'legacy_provider_adopted'::text) AND (source_workspace_generation IS NULL) AND (source_instance_id IS NULL))))),
    CONSTRAINT sandbox_checkpoint_artifacts_state_check CHECK ((state = ANY (ARRAY['candidate'::text, 'current'::text, 'previous'::text, 'delete_pending'::text, 'deleting'::text, 'delete_failed'::text, 'deleted'::text])))
);

ALTER TABLE ONLY sandbox_checkpoint_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE sandbox_lease_holders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    kind text NOT NULL,
    holder_id text NOT NULL,
    subject_id uuid,
    last_heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    viewer_subject_id text,
    viewer_authority_epoch integer,
    CONSTRAINT sandbox_lease_holders_kind_check CHECK ((kind = ANY (ARRAY['turn'::text, 'viewer'::text, 'direct'::text, 'process'::text, 'interaction'::text]))),
    CONSTRAINT sandbox_lease_holders_viewer_authority_check CHECK ((((viewer_authority_epoch IS NULL) OR (viewer_authority_epoch > 0)) AND ((viewer_subject_id IS NULL) OR ((length(btrim(viewer_subject_id)) >= 1) AND (length(btrim(viewer_subject_id)) <= 512)))))
);

ALTER TABLE ONLY sandbox_lease_holders FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN sandbox_lease_holders.viewer_subject_id IS 'Authenticated subject that attached this viewer holder. Identity only - never a secret value. NULL for non-viewer holders and pre-0281 rows.';

COMMENT ON COLUMN sandbox_lease_holders.viewer_authority_epoch IS 'Session authority epoch observed when the viewer attached; the stream token minted for this holder carries the same claim.';

CREATE TABLE sandbox_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sandbox_group_id uuid NOT NULL,
    liveness text DEFAULT 'cold'::text NOT NULL,
    refcount integer DEFAULT 0 NOT NULL,
    turn_holders integer DEFAULT 0 NOT NULL,
    viewer_holders integer DEFAULT 0 NOT NULL,
    instance_id text,
    backend text NOT NULL,
    os text DEFAULT 'linux'::text NOT NULL,
    data_plane_url text,
    lease_epoch integer DEFAULT 0 NOT NULL,
    resume_backend_id text,
    resume_state jsonb,
    last_meter_at timestamp with time zone,
    last_meter_tick integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    terminal_data_plane_url text,
    image text,
    rig_version_id uuid,
    workspace_generation integer DEFAULT 0 NOT NULL,
    archive_generation integer,
    provider_created_at timestamp with time zone,
    provider_deadline_at timestamp with time zone,
    rotation_requested_at timestamp with time zone,
    rotation_reason text,
    current_checkpoint_artifact_id uuid,
    previous_checkpoint_artifact_id uuid,
    archive_capture_id uuid,
    archive_capture_generation integer,
    archive_capture_started_at timestamp with time zone,
    archive_capture_deadline_at timestamp with time zone,
    archive_capture_operation_id uuid,
    archive_capture_provider_request_id uuid,
    archive_capture_provider_replay_safe boolean DEFAULT false NOT NULL,
    archive_capture_attempt integer,
    archive_capture_published_at timestamp with time zone,
    reaper_hold_id uuid,
    reaper_hold_until timestamp with time zone,
    reaper_hold_reason text,
    archive_capture_takeover_safe boolean DEFAULT false NOT NULL,
    controller_data_plane_url text,
    shared_preparation_lease_epoch integer,
    shared_preparation_instance_id text,
    shared_preparation_spec_hash text,
    shared_preparation_status text,
    shared_preparation_claim_id uuid,
    shared_preparation_owner_attempt_id uuid,
    shared_preparation_attempt integer,
    shared_preparation_revision integer DEFAULT 0 NOT NULL,
    shared_preparation_started_at timestamp with time zone,
    shared_preparation_deadline_at timestamp with time zone,
    shared_preparation_settled_at timestamp with time zone,
    unobservable_command_drain_ids uuid[],
    unobservable_command_checked_at timestamp with time zone,
    archive_capture_last_attempt_at timestamp with time zone,
    public_recovery jsonb,
    provider_create_attempt jsonb,
    provider_create_recovery_after timestamp with time zone,
    holders_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    command_containment_reason text,
    archive_capture_concurrent_capture_id uuid,
    deadline_forced_admission_ids uuid[],
    idle_checkpoint_attempted_at timestamp with time zone,
    untracked_writer_since timestamp with time zone,
    group_end_requested_at timestamp with time zone,
    compute_asleep_since timestamp with time zone,
    CONSTRAINT sandbox_leases_archive_capture_check CHECK ((((archive_capture_id IS NULL) AND (archive_capture_operation_id IS NULL) AND (archive_capture_provider_request_id IS NULL) AND (archive_capture_provider_replay_safe = false) AND (archive_capture_takeover_safe = false) AND (archive_capture_attempt IS NULL) AND (archive_capture_generation IS NULL) AND (archive_capture_started_at IS NULL) AND (archive_capture_deadline_at IS NULL) AND (archive_capture_published_at IS NULL)) OR ((archive_capture_id IS NOT NULL) AND (archive_capture_operation_id IS NOT NULL) AND (archive_capture_provider_request_id IS NOT NULL) AND ((archive_capture_provider_replay_safe = false) OR (archive_capture_takeover_safe = true)) AND (archive_capture_attempt IS NOT NULL) AND (archive_capture_attempt > 0) AND (archive_capture_generation IS NOT NULL) AND (archive_capture_generation = workspace_generation) AND (archive_capture_started_at IS NOT NULL) AND (archive_capture_deadline_at IS NOT NULL) AND (archive_capture_deadline_at > archive_capture_started_at) AND ((archive_capture_published_at IS NULL) OR (liveness = 'draining'::text))))),
    CONSTRAINT sandbox_leases_archive_generation_check CHECK (((archive_generation IS NULL) OR ((archive_generation >= 0) AND (archive_generation <= workspace_generation)))),
    CONSTRAINT sandbox_leases_checkpoint_distinct_check CHECK (((current_checkpoint_artifact_id IS NULL) OR (previous_checkpoint_artifact_id IS NULL) OR (current_checkpoint_artifact_id <> previous_checkpoint_artifact_id))),
    CONSTRAINT sandbox_leases_command_containment_reason_check CHECK (((command_containment_reason IS NULL) OR (command_containment_reason = ANY (ARRAY['idle_containment'::text, 'provider_deadline_containment'::text, 'quiescence_containment'::text])))),
    CONSTRAINT sandbox_leases_liveness_check CHECK ((liveness = ANY (ARRAY['cold'::text, 'warming'::text, 'warm'::text, 'draining'::text]))),
    CONSTRAINT sandbox_leases_provider_deadline_check CHECK ((((provider_created_at IS NULL) AND (provider_deadline_at IS NULL)) OR ((provider_created_at IS NOT NULL) AND (provider_deadline_at IS NOT NULL) AND (provider_deadline_at > provider_created_at)))),
    CONSTRAINT sandbox_leases_reaper_hold_check CHECK ((((reaper_hold_id IS NULL) AND (reaper_hold_until IS NULL) AND (reaper_hold_reason IS NULL)) OR ((reaper_hold_id IS NOT NULL) AND (reaper_hold_until IS NOT NULL) AND (reaper_hold_reason IS NOT NULL) AND ((length(reaper_hold_reason) >= 1) AND (length(reaper_hold_reason) <= 500))))),
    CONSTRAINT sandbox_leases_refcount_check CHECK ((refcount >= 0)),
    CONSTRAINT sandbox_leases_rotation_check CHECK ((((rotation_requested_at IS NULL) AND (rotation_reason IS NULL)) OR ((rotation_requested_at IS NOT NULL) AND (rotation_reason IS NOT NULL) AND (rotation_reason = ANY (ARRAY['provider_deadline'::text, 'operator'::text, 'teardown_claim'::text]))))),
    CONSTRAINT sandbox_leases_shared_preparation_check CHECK ((((shared_preparation_status IS NULL) AND (shared_preparation_lease_epoch IS NULL) AND (shared_preparation_instance_id IS NULL) AND (shared_preparation_spec_hash IS NULL) AND (shared_preparation_claim_id IS NULL) AND (shared_preparation_owner_attempt_id IS NULL) AND (shared_preparation_attempt IS NULL) AND (shared_preparation_started_at IS NULL) AND (shared_preparation_deadline_at IS NULL) AND (shared_preparation_settled_at IS NULL)) OR ((shared_preparation_status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text])) AND (shared_preparation_lease_epoch IS NOT NULL) AND (shared_preparation_lease_epoch >= 0) AND (NULLIF(btrim(shared_preparation_instance_id), ''::text) IS NOT NULL) AND (shared_preparation_spec_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (shared_preparation_claim_id IS NOT NULL) AND (shared_preparation_owner_attempt_id IS NOT NULL) AND (shared_preparation_attempt IS NOT NULL) AND (shared_preparation_attempt > 0) AND (shared_preparation_started_at IS NOT NULL) AND (shared_preparation_deadline_at > shared_preparation_started_at) AND (((shared_preparation_status = 'running'::text) AND (shared_preparation_settled_at IS NULL)) OR ((shared_preparation_status = ANY (ARRAY['completed'::text, 'failed'::text])) AND (shared_preparation_settled_at IS NOT NULL)))))),
    CONSTRAINT sandbox_leases_turn_holders_check CHECK ((turn_holders >= 0)),
    CONSTRAINT sandbox_leases_viewer_holders_check CHECK ((viewer_holders >= 0)),
    CONSTRAINT sandbox_leases_workspace_generation_check CHECK ((workspace_generation >= 0)),
    CONSTRAINT sandbox_provider_create_attempt_shape CHECK (((provider_create_attempt IS NULL) OR (((jsonb_typeof(provider_create_attempt) = 'object'::text) AND ((provider_create_attempt ->> 'version'::text) = '1'::text) AND (length((provider_create_attempt ->> 'operationId'::text)) > 0) AND (length((provider_create_attempt ->> 'providerBindingKey'::text)) > 0) AND (length((provider_create_attempt ->> 'appId'::text)) > 0) AND ((provider_create_attempt ->> 'providerName'::text) = ('opengeni-create-'::text || (provider_create_attempt ->> 'operationId'::text))) AND ((provider_create_attempt ->> 'requestSha256'::text) ~ '^[a-f0-9]{64}$'::text) AND (jsonb_typeof((provider_create_attempt -> 'leaseEpoch'::text)) = 'number'::text) AND (provider_create_attempt ? 'instanceId'::text) AND (((provider_create_attempt -> 'instanceId'::text) = 'null'::jsonb) OR ((jsonb_typeof((provider_create_attempt -> 'instanceId'::text)) = 'string'::text) AND (length((provider_create_attempt ->> 'instanceId'::text)) > 0)))) IS TRUE))),
    CONSTRAINT sandbox_public_recovery_shape CHECK (((public_recovery IS NULL) OR COALESCE(((jsonb_typeof(public_recovery) = 'object'::text) AND ((public_recovery ->> 'version'::text) = '1'::text) AND ((public_recovery ->> 'status'::text) = ANY (ARRAY['accepted'::text, 'verified'::text, 'failed'::text])) AND ((public_recovery ->> 'sessionId'::text) IS NOT NULL) AND ((public_recovery ->> 'operationId'::text) IS NOT NULL) AND ((public_recovery ->> 'subjectId'::text) IS NOT NULL) AND (jsonb_typeof((public_recovery -> 'selection'::text)) = 'object'::text)), false)))
);

ALTER TABLE ONLY sandbox_leases FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN sandbox_leases.shared_preparation_spec_hash IS 'Non-secret immutable setup specification coordinated once for the exact lease epoch and provider instance.';

COMMENT ON COLUMN sandbox_leases.shared_preparation_revision IS 'Monotonic durable join cursor. Waiters treat notifications as hints and always re-read this lease row.';

CREATE TABLE sandbox_pty_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    exec_session_id integer,
    lease_epoch integer NOT NULL,
    cols integer NOT NULL,
    rows integer NOT NULL,
    shell text NOT NULL,
    cwd text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    opened_by text NOT NULL,
    last_input_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    lease_id uuid,
    sandbox_group_id uuid,
    retained_process_id uuid,
    open_admission_id uuid,
    provider_backend text,
    provider_instance_id text,
    route_kind text,
    route_target_id uuid,
    route_epoch integer,
    CONSTRAINT sandbox_pty_sessions_open_identity_check CHECK (((status <> 'open'::text) OR ((lease_id IS NOT NULL) AND (sandbox_group_id IS NOT NULL) AND (retained_process_id IS NOT NULL) AND (open_admission_id IS NOT NULL) AND (exec_session_id > 0) AND (lease_epoch >= 0) AND ((octet_length(provider_backend) >= 1) AND (octet_length(provider_backend) <= 64)) AND ((octet_length(provider_instance_id) >= 1) AND (octet_length(provider_instance_id) <= 512)) AND (route_kind = ANY (ARRAY['home'::text, 'active'::text])) AND ((route_kind = 'active'::text) OR (route_target_id IS NULL)) AND (route_epoch >= 0)))),
    CONSTRAINT sandbox_pty_sessions_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);

ALTER TABLE ONLY sandbox_pty_sessions FORCE ROW LEVEL SECURITY;

CREATE TABLE sandbox_retained_processes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    sandbox_group_id uuid NOT NULL,
    parent_admission_id uuid NOT NULL,
    holder_id text NOT NULL,
    owner_actor_kind text NOT NULL,
    owner_actor_id uuid NOT NULL,
    owner_turn_id uuid,
    owner_attempt_id uuid,
    owner_execution_generation integer,
    lease_epoch integer NOT NULL,
    provider_backend text NOT NULL,
    provider_instance_id text NOT NULL,
    route_kind text NOT NULL,
    route_target_id uuid,
    route_epoch integer NOT NULL,
    provider_session_id integer NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    exit_code integer,
    settlement_reason text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    reconcile_after timestamp with time zone DEFAULT now() NOT NULL,
    reconcile_claim_id uuid,
    reconcile_claimed_at timestamp with time zone,
    reconcile_attempts integer DEFAULT 0 NOT NULL,
    last_reconcile_outcome text,
    reconcile_proof_outcome text,
    reconcile_proof_exit_code integer,
    reconcile_proof_reason text,
    reconcile_proof_observed_at timestamp with time zone,
    provider_binding_key text,
    provider_binding jsonb,
    initiator_kind text DEFAULT 'legacy_unattributed'::text NOT NULL,
    initiator_subject_id text DEFAULT 'unattributed-legacy'::text NOT NULL,
    initiating_human_subject_id text,
    initiator_organization_membership_id uuid,
    initiator_authorization_revision bigint,
    authority_epoch integer,
    authority_visibility text,
    authority_owner_organization_membership_id uuid,
    provider_command jsonb,
    provider_command_input_index bigint DEFAULT 0 NOT NULL,
    supervision_retention_xid xid8 DEFAULT pg_current_xact_id(),
    supervision_receipt jsonb,
    supervision_output_captured boolean DEFAULT false NOT NULL,
    cancellation_requested_at timestamp with time zone,
    cancellation_reason text,
    deadline_cancellation_requested_at timestamp with time zone,
    reconciler_version smallint DEFAULT 1 NOT NULL,
    CONSTRAINT sandbox_retained_processes_identity_check CHECK (((lease_epoch >= 0) AND (route_epoch >= 0) AND (provider_session_id > 0) AND ((octet_length(holder_id) >= 1) AND (octet_length(holder_id) <= 256)) AND ((octet_length(provider_backend) >= 1) AND (octet_length(provider_backend) <= 64)) AND ((octet_length(provider_instance_id) >= 1) AND (octet_length(provider_instance_id) <= 512)) AND (route_kind = ANY (ARRAY['home'::text, 'active'::text])) AND ((route_kind = 'active'::text) OR (route_target_id IS NULL)))),
    CONSTRAINT sandbox_retained_processes_initiator_check CHECK ((((initiator_kind = 'legacy_unattributed'::text) AND (initiator_subject_id = 'unattributed-legacy'::text) AND (initiating_human_subject_id IS NULL) AND (initiator_organization_membership_id IS NULL) AND (initiator_authorization_revision IS NULL)) OR ((initiator_kind = ANY (ARRAY['subject'::text, 'service'::text])) AND ((length(btrim(initiator_subject_id)) >= 1) AND (length(btrim(initiator_subject_id)) <= 1024)) AND (initiator_subject_id <> 'unattributed-legacy'::text) AND ((initiating_human_subject_id IS NULL) OR ((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024))) AND ((initiator_organization_membership_id IS NULL) OR (initiating_human_subject_id IS NOT NULL)) AND ((initiator_authorization_revision IS NULL) OR ((initiator_authorization_revision > 0) AND (initiator_organization_membership_id IS NOT NULL)))))),
    CONSTRAINT sandbox_retained_processes_owner_check CHECK ((((owner_actor_kind = 'turn'::text) AND (owner_actor_id = owner_attempt_id) AND (owner_turn_id IS NOT NULL) AND (owner_attempt_id IS NOT NULL) AND (owner_execution_generation > 0)) OR ((owner_actor_kind = 'direct'::text) AND (owner_turn_id IS NULL) AND (owner_attempt_id IS NULL) AND (owner_execution_generation IS NULL)))),
    CONSTRAINT sandbox_retained_processes_provider_binding_check CHECK ((((provider_binding_key IS NULL) AND (provider_binding IS NULL)) OR ((provider_backend = 'modal'::text) AND ((octet_length(provider_binding_key) >= 1) AND (octet_length(provider_binding_key) <= 1024)) AND (jsonb_typeof(provider_binding) = 'object'::text) AND ((provider_binding_key)::jsonb = provider_binding) AND (provider_binding_key = format('{"version":1,"serverUrl":%s,"workspaceName":%s,"environment":%s}'::text, (to_jsonb((provider_binding ->> 'serverUrl'::text)))::text, (to_jsonb((provider_binding ->> 'workspaceName'::text)))::text, (to_jsonb((provider_binding ->> 'environment'::text)))::text)) AND (provider_binding = jsonb_build_object('version', 1, 'serverUrl', (provider_binding ->> 'serverUrl'::text), 'workspaceName', (provider_binding ->> 'workspaceName'::text), 'environment', (provider_binding ->> 'environment'::text))) AND (COALESCE(octet_length((provider_binding ->> 'serverUrl'::text)), 0) > 0) AND (COALESCE(octet_length((provider_binding ->> 'workspaceName'::text)), 0) > 0) AND ((provider_binding ->> 'environment'::text) IS NOT NULL)))),
    CONSTRAINT sandbox_retained_processes_provider_command_chk CHECK (((provider_command IS NULL) OR (((provider_backend = 'modal'::text) AND (jsonb_typeof(provider_command) = 'object'::text) AND ((provider_command ->> 'kind'::text) = ANY (ARRAY['modal-control-v1'::text, 'modal-router-v1'::text])) AND ((provider_command ->> 'sandboxId'::text) = provider_instance_id) AND (length((provider_command ->> 'taskId'::text)) > 0) AND (length((provider_command ->> 'execId'::text)) > 0)) IS TRUE))),
    CONSTRAINT sandbox_retained_processes_provider_input_index_chk CHECK (((provider_command_input_index >= 0) AND (provider_command_input_index <= '9007199254740991'::bigint))),
    CONSTRAINT sandbox_retained_processes_reason_check CHECK (((settlement_reason IS NULL) OR ((octet_length(settlement_reason) >= 1) AND (octet_length(settlement_reason) <= 512)))),
    CONSTRAINT sandbox_retained_processes_reconcile_attempts_check CHECK ((reconcile_attempts >= 0)),
    CONSTRAINT sandbox_retained_processes_reconcile_claim_check CHECK ((((reconcile_claim_id IS NULL) AND (reconcile_claimed_at IS NULL)) OR ((reconcile_claim_id IS NOT NULL) AND (reconcile_claimed_at IS NOT NULL)))),
    CONSTRAINT sandbox_retained_processes_reconcile_outcome_check CHECK (((last_reconcile_outcome IS NULL) OR ((octet_length(last_reconcile_outcome) >= 1) AND (octet_length(last_reconcile_outcome) <= 64)))),
    CONSTRAINT sandbox_retained_processes_reconcile_proof_check CHECK ((((reconcile_proof_outcome IS NULL) AND (reconcile_proof_exit_code IS NULL) AND (reconcile_proof_reason IS NULL) AND (reconcile_proof_observed_at IS NULL)) OR ((reconcile_proof_outcome = 'exited'::text) AND (reconcile_proof_exit_code IS NOT NULL) AND (reconcile_proof_reason = 'provider_exit_banner'::text) AND (reconcile_proof_observed_at IS NOT NULL)) OR ((reconcile_proof_outcome = 'lost'::text) AND (reconcile_proof_exit_code IS NULL) AND (reconcile_proof_reason = ANY (ARRAY['provider_session_lost_banner'::text, 'provider_instance_not_found'::text, 'provider_instance_terminated'::text])) AND (reconcile_proof_observed_at IS NOT NULL)))),
    CONSTRAINT sandbox_retained_processes_reconciler_version_check CHECK ((reconciler_version >= 1)),
    CONSTRAINT sandbox_retained_processes_settlement_check CHECK ((((state = 'active'::text) AND (settled_at IS NULL) AND (exit_code IS NULL)) OR ((state = 'exited'::text) AND (settled_at IS NOT NULL)) OR ((state = 'lost'::text) AND (settled_at IS NOT NULL) AND (exit_code IS NULL)))),
    CONSTRAINT sandbox_retained_processes_tenancy_check CHECK ((((authority_epoch IS NULL) AND (authority_visibility IS NULL) AND (authority_owner_organization_membership_id IS NULL)) OR ((authority_epoch IS NOT NULL) AND (authority_visibility IS NOT NULL) AND (authority_epoch > 0) AND (authority_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND ((authority_visibility <> 'user_private'::text) OR (authority_owner_organization_membership_id IS NOT NULL)))))
);

ALTER TABLE ONLY sandbox_retained_processes FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN sandbox_retained_processes.initiator_kind IS 'Causal principal kind frozen when the process was retained. A legacy_unattributed process keeps running; only its next workspace mutation is refused.';

CREATE TABLE sandbox_session_envelopes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    envelope_codec_version integer
);

ALTER TABLE ONLY sandbox_session_envelopes FORCE ROW LEVEL SECURITY;

CREATE TABLE sandbox_workspace_mutation_admissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    sandbox_group_id uuid NOT NULL,
    session_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_id uuid NOT NULL,
    turn_id uuid,
    attempt_id uuid,
    execution_generation integer,
    holder_kind text NOT NULL,
    holder_id text NOT NULL,
    lease_epoch integer NOT NULL,
    provider_backend text NOT NULL,
    provider_instance_id text NOT NULL,
    route_kind text NOT NULL,
    route_target_id uuid,
    route_epoch integer NOT NULL,
    workspace_generation integer NOT NULL,
    operation text NOT NULL,
    provider_outcome text,
    admitted_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    initiator_kind text DEFAULT 'legacy_unattributed'::text NOT NULL,
    initiator_subject_id text DEFAULT 'unattributed-legacy'::text NOT NULL,
    initiating_human_subject_id text,
    initiator_organization_membership_id uuid,
    initiator_authorization_revision bigint,
    authority_epoch integer,
    authority_visibility text,
    authority_owner_organization_membership_id uuid,
    CONSTRAINT sandbox_workspace_mutation_admissions_actor_check CHECK ((((actor_kind = 'turn'::text) AND (actor_id = attempt_id) AND (turn_id IS NOT NULL) AND (attempt_id IS NOT NULL) AND (execution_generation IS NOT NULL) AND (holder_kind = 'turn'::text)) OR ((actor_kind = 'direct'::text) AND (turn_id IS NULL) AND (attempt_id IS NULL) AND (execution_generation IS NULL) AND (holder_kind = 'direct'::text)) OR ((actor_kind = 'process'::text) AND (turn_id IS NULL) AND (attempt_id IS NULL) AND (execution_generation IS NULL) AND (holder_kind = 'process'::text)))),
    CONSTRAINT sandbox_workspace_mutation_admissions_generation_check CHECK (((workspace_generation > 0) AND (lease_epoch >= 0) AND (route_epoch >= 0) AND ((execution_generation IS NULL) OR (execution_generation > 0)))),
    CONSTRAINT sandbox_workspace_mutation_admissions_initiator_check CHECK ((((initiator_kind = 'legacy_unattributed'::text) AND (initiator_subject_id = 'unattributed-legacy'::text) AND (initiating_human_subject_id IS NULL) AND (initiator_organization_membership_id IS NULL) AND (initiator_authorization_revision IS NULL)) OR ((initiator_kind = ANY (ARRAY['subject'::text, 'service'::text])) AND ((length(btrim(initiator_subject_id)) >= 1) AND (length(btrim(initiator_subject_id)) <= 1024)) AND (initiator_subject_id <> 'unattributed-legacy'::text) AND ((initiating_human_subject_id IS NULL) OR ((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024))) AND ((initiator_organization_membership_id IS NULL) OR (initiating_human_subject_id IS NOT NULL)) AND ((initiator_authorization_revision IS NULL) OR ((initiator_authorization_revision > 0) AND (initiator_organization_membership_id IS NOT NULL)))))),
    CONSTRAINT sandbox_workspace_mutation_admissions_operation_check CHECK (((octet_length(operation) >= 1) AND (octet_length(operation) <= 128))),
    CONSTRAINT sandbox_workspace_mutation_admissions_outcome_check CHECK (((provider_outcome IS NULL) OR (provider_outcome = ANY (ARRAY['resolved'::text, 'rejected'::text, 'retained'::text])))),
    CONSTRAINT sandbox_workspace_mutation_admissions_route_check CHECK (((actor_kind = ANY (ARRAY['turn'::text, 'direct'::text, 'process'::text])) AND (holder_kind = ANY (ARRAY['turn'::text, 'direct'::text, 'process'::text])) AND ((octet_length(holder_id) >= 1) AND (octet_length(holder_id) <= 256)) AND ((octet_length(provider_backend) >= 1) AND (octet_length(provider_backend) <= 64)) AND ((octet_length(provider_instance_id) >= 1) AND (octet_length(provider_instance_id) <= 512)) AND (route_kind = ANY (ARRAY['home'::text, 'active'::text])) AND ((route_kind = 'active'::text) OR (route_target_id IS NULL)))),
    CONSTRAINT sandbox_workspace_mutation_admissions_settlement_check CHECK ((((provider_outcome IS NULL) AND (settled_at IS NULL)) OR ((provider_outcome = 'retained'::text) AND (settled_at IS NULL)) OR ((provider_outcome = ANY (ARRAY['resolved'::text, 'rejected'::text])) AND (settled_at IS NOT NULL)))),
    CONSTRAINT sandbox_workspace_mutation_admissions_tenancy_check CHECK ((((authority_epoch IS NULL) AND (authority_visibility IS NULL) AND (authority_owner_organization_membership_id IS NULL)) OR ((authority_epoch IS NOT NULL) AND (authority_visibility IS NOT NULL) AND (authority_epoch > 0) AND (authority_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND ((authority_visibility <> 'user_private'::text) OR (authority_owner_organization_membership_id IS NOT NULL)))))
);

ALTER TABLE ONLY sandbox_workspace_mutation_admissions FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN sandbox_workspace_mutation_admissions.initiator_kind IS 'Causal principal kind for this admission: subject | service, or the legacy_unattributed sentinel for a pre-0277 row whose authority was never recorded. The sentinel is refused by new admission and is never written by a post-0277 writer.';

COMMENT ON COLUMN sandbox_workspace_mutation_admissions.authority_epoch IS 'Session tenancy authority epoch observed when the operation was admitted. Identity and epoch only - never a secret value.';

CREATE TABLE sandboxes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    enrollment_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sandboxes_kind_check CHECK ((kind = ANY (ARRAY['modal'::text, 'selfhosted'::text]))),
    CONSTRAINT sandboxes_selfhosted_enrollment_chk CHECK ((((kind = 'selfhosted'::text) AND (enrollment_id IS NOT NULL)) OR ((kind <> 'selfhosted'::text) AND (enrollment_id IS NULL))))
);

ALTER TABLE ONLY sandboxes FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_blocker_reviews (
    task_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    reviewed_run_id uuid,
    state text DEFAULT 'clear'::text NOT NULL,
    reason text,
    message text,
    blocked_run_id uuid,
    blocked_since timestamp with time zone,
    notice_session_id uuid,
    notice_key text,
    notice_pending text,
    notice_payload jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_task_blocker_reviews_message_check CHECK (((message IS NULL) OR ((char_length(message) >= 1) AND (char_length(message) <= 1000)))),
    CONSTRAINT scheduled_task_blocker_reviews_notice_chk CHECK ((((notice_session_id IS NULL) = (notice_key IS NULL)) AND ((notice_pending IS NULL) OR (notice_session_id IS NOT NULL)) AND ((NOT (notice_pending IS DISTINCT FROM 'post'::text)) = (notice_payload IS NOT NULL)))),
    CONSTRAINT scheduled_task_blocker_reviews_notice_key_check CHECK (((notice_key IS NULL) OR (notice_key ~ '^[A-Za-z0-9._:-]{1,120}$'::text))),
    CONSTRAINT scheduled_task_blocker_reviews_notice_payload_check CHECK (((notice_payload IS NULL) OR ((jsonb_typeof(notice_payload) = 'object'::text) AND (octet_length((notice_payload)::text) <= 4096)))),
    CONSTRAINT scheduled_task_blocker_reviews_notice_pending_check CHECK (((notice_pending IS NULL) OR (notice_pending = ANY (ARRAY['post'::text, 'withdraw'::text])))),
    CONSTRAINT scheduled_task_blocker_reviews_reason_check CHECK (((reason IS NULL) OR ((char_length(reason) >= 1) AND (char_length(reason) <= 128)))),
    CONSTRAINT scheduled_task_blocker_reviews_state_check CHECK ((state = ANY (ARRAY['clear'::text, 'notified'::text, 'paused'::text]))),
    CONSTRAINT scheduled_task_blocker_reviews_state_chk CHECK ((((state = 'clear'::text) AND (reason IS NULL) AND (message IS NULL) AND (blocked_run_id IS NULL) AND (blocked_since IS NULL)) OR ((state <> 'clear'::text) AND (reason IS NOT NULL) AND (message IS NOT NULL) AND (blocked_run_id IS NOT NULL) AND (blocked_since IS NOT NULL))))
);

ALTER TABLE ONLY scheduled_task_blocker_reviews FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_connection_authority_snapshots (
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    execution_digest text NOT NULL,
    server_id text NOT NULL,
    connection_id uuid NOT NULL,
    connection_generation bigint NOT NULL,
    origin_workspace_id uuid NOT NULL,
    provider_domain text NOT NULL,
    connection_kind text NOT NULL,
    selected_kind text,
    connection_type text,
    owner_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    grant_context text NOT NULL,
    grant_session_id uuid,
    grant_authority_epoch integer,
    target_session_id uuid,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    selection_sources text[] NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    snapshot_digest bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_task_connection_authority_session_chk CHECK ((((target_session_id IS NULL) AND (session_authority_epoch IS NULL) AND (grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL) AND (session_visibility = 'workspace_shared'::text)) OR ((target_session_id IS NOT NULL) AND (session_authority_epoch > 0) AND (((grant_mode = ANY (ARRAY['once'::text, 'session'::text])) AND (grant_session_id = target_session_id) AND (grant_authority_epoch = session_authority_epoch)) OR ((grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)))))),
    CONSTRAINT scheduled_task_connection_authority_shape_chk CHECK (((task_authority_revision > 0) AND (execution_digest ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 256)) AND (connection_generation > 0) AND ((selected_kind IS NULL) OR (selected_kind = ANY (ARRAY['oauth2'::text, 'api_key'::text, 'app_install'::text, 'delegated'::text]))) AND ((connection_type IS NULL) OR (connection_type = ANY (ARRAY['mcp'::text, 'github_personal'::text]))) AND (membership_authorization_revision > 0) AND (authority_generation > 0) AND (grant_generation > 0) AND (grant_mode = ANY (ARRAY['once'::text, 'session'::text, 'always'::text])) AND (grant_context = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (grant_context = session_visibility) AND (session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (cardinality(selection_sources) > 0)))
);

ALTER TABLE ONLY scheduled_task_connection_authority_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_connection_authority_snapshots IS 'Credential-free immutable common-user Connection authority for one scheduled task revision.';

CREATE TABLE scheduled_task_event_inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    event_id uuid NOT NULL,
    trigger_ids uuid[] NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    occurrence_id uuid,
    CONSTRAINT scheduled_task_event_inbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'batched'::text, 'skipped'::text]))),
    CONSTRAINT scheduled_task_event_inbox_trigger_ids_check CHECK (((cardinality(trigger_ids) >= 1) AND (cardinality(trigger_ids) <= 16)))
);

ALTER TABLE ONLY scheduled_task_event_inbox FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_event_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    trigger_ids uuid[] NOT NULL,
    event_count integer NOT NULL,
    event_ids uuid[] NOT NULL,
    events jsonb NOT NULL,
    gap_before boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    start_attempts integer DEFAULT 0 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    CONSTRAINT scheduled_task_event_occurrences_event_count_check CHECK ((event_count >= 1)),
    CONSTRAINT scheduled_task_event_occurrences_event_ids_check CHECK (((cardinality(event_ids) >= 1) AND (cardinality(event_ids) <= 50))),
    CONSTRAINT scheduled_task_event_occurrences_events_check CHECK (((jsonb_typeof(events) = 'array'::text) AND (octet_length((events)::text) <= 65536))),
    CONSTRAINT scheduled_task_event_occurrences_last_error_check CHECK (((last_error IS NULL) OR (char_length(last_error) <= 1000))),
    CONSTRAINT scheduled_task_event_occurrences_start_attempts_check CHECK ((start_attempts >= 0)),
    CONSTRAINT scheduled_task_event_occurrences_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'started'::text]))),
    CONSTRAINT scheduled_task_event_occurrences_status_chk CHECK (((status = 'started'::text) = (started_at IS NOT NULL))),
    CONSTRAINT scheduled_task_event_occurrences_trigger_ids_check CHECK (((cardinality(trigger_ids) >= 1) AND (cardinality(trigger_ids) <= 16)))
);

ALTER TABLE ONLY scheduled_task_event_occurrences FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_event_settings (
    task_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    max_runs_per_hour integer DEFAULT 30 NOT NULL,
    once boolean DEFAULT false NOT NULL,
    completed_at timestamp with time zone,
    armed_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatch_due_at timestamp with time zone,
    throttled_since timestamp with time zone,
    throttle_notified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scheduled_task_event_settings_completion_chk CHECK ((once OR (completed_at IS NULL))),
    CONSTRAINT scheduled_task_event_settings_max_runs_per_hour_check CHECK (((max_runs_per_hour >= 1) AND (max_runs_per_hour <= 1000)))
);

ALTER TABLE ONLY scheduled_task_event_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_personal_resource_authorities (
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    target_session_id uuid,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    execution_digest text NOT NULL,
    resource_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_task_personal_resource_authorities_digest_chk CHECK ((execution_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scheduled_task_personal_resource_authorities_revision_chk CHECK (((task_authority_revision > 0) AND (membership_authorization_revision > 0) AND (resource_count > 0))),
    CONSTRAINT scheduled_task_personal_resource_authorities_session_chk CHECK ((((target_session_id IS NULL) AND (session_authority_epoch IS NULL)) OR ((target_session_id IS NOT NULL) AND (session_authority_epoch > 0)))),
    CONSTRAINT scheduled_task_personal_resource_authorities_subject_chk CHECK (((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024))),
    CONSTRAINT scheduled_task_personal_resource_authorities_visibility_chk CHECK ((session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))
);

ALTER TABLE ONLY scheduled_task_personal_resource_authorities FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_personal_resource_authorities IS 'Immutable causal-human and membership header for one scheduled-task authority revision.';

CREATE TABLE scheduled_task_personal_resource_snapshots (
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    resource_version_id uuid,
    selection_sources text[] NOT NULL,
    action text NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    target_workspace_id uuid NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    grant_context text NOT NULL,
    grant_session_id uuid,
    grant_authority_epoch integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_task_personal_resource_snapshots_action_chk CHECK ((((resource_kind = 'variable_set'::text) AND (action = 'variable_set.use'::text)) OR ((resource_kind = 'rig'::text) AND (action = 'rig.use'::text)))),
    CONSTRAINT scheduled_task_personal_resource_snapshots_generation_chk CHECK (((task_authority_revision > 0) AND (membership_authorization_revision > 0) AND (authority_generation > 0) AND (grant_generation > 0))),
    CONSTRAINT scheduled_task_personal_resource_snapshots_grant_fence_chk CHECK ((((grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((grant_mode = ANY (ARRAY['once'::text, 'session'::text])) AND (grant_session_id IS NOT NULL) AND (grant_authority_epoch = session_authority_epoch)))),
    CONSTRAINT scheduled_task_personal_resource_snapshots_kind_chk CHECK ((((resource_kind = 'variable_set'::text) AND (resource_version_id IS NULL)) OR ((resource_kind = 'rig'::text) AND (resource_version_id IS NOT NULL)))),
    CONSTRAINT scheduled_task_personal_resource_snapshots_sources_chk CHECK ((cardinality(selection_sources) > 0))
);

ALTER TABLE ONLY scheduled_task_personal_resource_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_personal_resource_snapshots IS 'Server-derived exact personal Variable Set/Rig authority frozen at scheduled-task write.';

CREATE TABLE scheduled_task_reusable_connection_materializations (
    task_id uuid NOT NULL,
    run_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    source_task_authority_revision bigint NOT NULL,
    target_task_authority_revision bigint NOT NULL,
    source_execution_digest text NOT NULL,
    target_execution_digest text NOT NULL,
    materialized_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_reusable_connection_revision_chk CHECK (((source_task_authority_revision > 0) AND ((target_task_authority_revision = source_task_authority_revision) OR (target_task_authority_revision = (source_task_authority_revision + 1))) AND (source_execution_digest ~ '^[0-9a-f]{64}$'::text) AND (target_execution_digest ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY scheduled_task_reusable_connection_materializations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_reusable_connection_materializations IS 'Idempotent receipt for the first reusable-session authority revision and session binding.';

CREATE TABLE scheduled_task_revision_authorities (
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    execution_digest text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    claude_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    subscription_authority jsonb,
    authority_inserted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT scheduled_task_revision_authorities_claude_authority_snapshot_c CHECK (claude_provider_account_authority_snapshot_v1_valid(claude_provider_account_authority_snapshot)),
    CONSTRAINT scheduled_task_revision_authorities_shape_chk CHECK (((task_authority_revision > 0) AND (membership_authorization_revision > 0) AND ((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 4096)) AND (execution_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT scheduled_task_revision_authorities_subscription_authority_v2_c CHECK (((subscription_authority IS NULL) OR subscription_personal_authority_v2_valid(subscription_authority)))
);

ALTER TABLE ONLY scheduled_task_revision_authorities FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_run_connection_authority_snapshots (
    run_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    execution_digest text NOT NULL,
    server_id text NOT NULL,
    connection_id uuid NOT NULL,
    connection_generation bigint NOT NULL,
    origin_workspace_id uuid NOT NULL,
    provider_domain text NOT NULL,
    connection_kind text NOT NULL,
    selected_kind text,
    connection_type text,
    owner_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_id uuid,
    grant_generation bigint,
    grant_mode text,
    grant_context text,
    grant_session_id uuid,
    grant_authority_epoch integer,
    target_session_id uuid,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    selection_sources text[] NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    snapshot_digest bytea NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    bound_at timestamp with time zone,
    CONSTRAINT scheduled_run_connection_authority_shape_chk CHECK (((task_authority_revision > 0) AND (execution_digest ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 256)) AND (connection_generation > 0) AND ((selected_kind IS NULL) OR (selected_kind = ANY (ARRAY['oauth2'::text, 'api_key'::text, 'app_install'::text, 'delegated'::text]))) AND ((connection_type IS NULL) OR (connection_type = ANY (ARRAY['mcp'::text, 'atlassian'::text, 'github_personal'::text]))) AND (membership_authorization_revision > 0) AND (authority_generation > 0) AND (session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (cardinality(selection_sources) > 0) AND ((((canonical_snapshot ->> 'authoritySource'::text) = 'sender'::text) AND (grant_id IS NULL) AND (grant_generation IS NULL) AND (grant_mode IS NULL) AND (grant_context IS NULL) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR (((canonical_snapshot ->> 'authoritySource'::text) IS DISTINCT FROM 'sender'::text) AND (grant_id IS NOT NULL) AND (grant_generation > 0) AND (grant_mode = ANY (ARRAY['once'::text, 'session'::text, 'always'::text])) AND (grant_context = session_visibility)))))
);

ALTER TABLE ONLY scheduled_task_run_connection_authority_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_run_connection_authority_snapshots IS 'Exact stable-occurrence copy bound once to the resulting scheduled session and logical turn.';

CREATE TABLE scheduled_task_run_personal_resource_admissions (
    run_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    target_session_id uuid,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    execution_digest text NOT NULL,
    resource_count integer NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_task_run_personal_resource_admissions_digest_chk CHECK ((execution_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scheduled_task_run_personal_resource_admissions_revision_chk CHECK (((task_authority_revision > 0) AND (membership_authorization_revision > 0) AND (resource_count > 0)))
);

ALTER TABLE ONLY scheduled_task_run_personal_resource_admissions FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_run_personal_resource_admissions IS 'Accepted occurrence binding to one immutable task authority revision before dispatch.';

CREATE TABLE scheduled_task_run_personal_resource_once_receipts (
    grant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_generation bigint NOT NULL,
    consumed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT scheduled_run_once_receipts_generation_chk CHECK (((authority_generation > 0) AND (grant_generation > 0)))
);

ALTER TABLE ONLY scheduled_task_run_personal_resource_once_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_run_personal_resource_once_receipts IS 'Unique once-grant ownership for one admitted scheduled occurrence across attempt retries.';

CREATE TABLE scheduled_task_run_personal_resource_snapshots (
    run_id uuid NOT NULL,
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    resource_version_id uuid,
    selection_sources text[] NOT NULL,
    action text NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    target_workspace_id uuid NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    grant_context text NOT NULL,
    grant_session_id uuid,
    grant_authority_epoch integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY scheduled_task_run_personal_resource_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE scheduled_task_run_personal_resource_snapshots IS 'Exact occurrence copy used to fence queued/recovering scheduled work against widening.';

CREATE TABLE scheduled_task_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    trigger_type text NOT NULL,
    scheduled_at timestamp with time zone,
    fired_at timestamp with time zone DEFAULT now() NOT NULL,
    session_id uuid,
    trigger_event_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    producer_key text,
    action_kind text DEFAULT 'agent_turn'::text NOT NULL,
    knowledge_sync_run_id uuid,
    knowledge_summary jsonb,
    completed_at timestamp with time zone,
    task_authority_revision bigint,
    task_execution_digest text,
    accepted_execution_snapshot jsonb,
    accepted_execution_digest text,
    admission_diagnostic jsonb,
    admission_refusal jsonb,
    CONSTRAINT scheduled_task_run_accepted_execution_shape_chk CHECK ((((accepted_execution_snapshot IS NULL) AND (accepted_execution_digest IS NULL)) OR ((accepted_execution_snapshot IS NOT NULL) AND (accepted_execution_digest ~ '^[0-9a-f]{64}$'::text) AND (accepted_execution_digest = encode(digest(convert_to((accepted_execution_snapshot)::text, 'UTF8'::name), 'sha256'::text), 'hex'::text))))),
    CONSTRAINT scheduled_task_runs_action_chk CHECK (((action_kind = ANY (ARRAY['agent_turn'::text, 'knowledge_source_sync'::text])) AND ((knowledge_summary IS NULL) OR ((jsonb_typeof(knowledge_summary) = 'object'::text) AND (octet_length(convert_to((knowledge_summary)::text, 'UTF8'::name)) <= 16384))))),
    CONSTRAINT scheduled_task_runs_execution_binding_chk CHECK ((((task_authority_revision IS NULL) AND (task_execution_digest IS NULL)) OR ((task_authority_revision > 0) AND (task_execution_digest ~ '^[0-9a-f]{64}$'::text))))
);

ALTER TABLE ONLY scheduled_task_runs FORCE ROW LEVEL SECURITY;

CREATE TABLE scheduled_task_schedule_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    task_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    temporal_schedule_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY scheduled_task_schedule_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE secret_approval_rules (
    account_id uuid NOT NULL,
    item_id uuid NOT NULL,
    field_key text DEFAULT ''::text NOT NULL,
    vault_id uuid NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT secret_approval_rules_created_by_subject_id_check CHECK (((char_length(created_by_subject_id) >= 1) AND (char_length(created_by_subject_id) <= 512))),
    CONSTRAINT secret_approval_rules_field_key_check CHECK ((char_length(field_key) <= 200))
);

ALTER TABLE ONLY secret_approval_rules FORCE ROW LEVEL SECURITY;

CREATE TABLE secret_use_approvals (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    approver_subject_id text NOT NULL,
    targets jsonb NOT NULL,
    surface text NOT NULL,
    tool_name text NOT NULL,
    destination text,
    status text DEFAULT 'pending'::text NOT NULL,
    scope text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    decided_by_subject_id text,
    used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by_subject_id text,
    CONSTRAINT secret_use_approvals_approver_subject_id_check CHECK (((char_length(approver_subject_id) >= 1) AND (char_length(approver_subject_id) <= 512))),
    CONSTRAINT secret_use_approvals_check CHECK (((status = ANY (ARRAY['approved'::text, 'used'::text, 'revoked'::text])) = (scope IS NOT NULL))),
    CONSTRAINT secret_use_approvals_decided_by_subject_id_check CHECK ((char_length(decided_by_subject_id) <= 512)),
    CONSTRAINT secret_use_approvals_destination_check CHECK (((destination IS NULL) OR (char_length(destination) <= 500))),
    CONSTRAINT secret_use_approvals_revoked_by_subject_id_check CHECK ((char_length(revoked_by_subject_id) <= 512)),
    CONSTRAINT secret_use_approvals_scope_check CHECK ((scope = ANY (ARRAY['once'::text, 'session'::text, 'window'::text]))),
    CONSTRAINT secret_use_approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'used'::text, 'revoked'::text]))),
    CONSTRAINT secret_use_approvals_surface_check CHECK (((char_length(surface) >= 1) AND (char_length(surface) <= 64))),
    CONSTRAINT secret_use_approvals_targets_check CHECK (((jsonb_typeof(targets) = 'array'::text) AND ((jsonb_array_length(targets) >= 1) AND (jsonb_array_length(targets) <= 50)))),
    CONSTRAINT secret_use_approvals_tool_name_check CHECK (((char_length(tool_name) >= 1) AND (char_length(tool_name) <= 200)))
);

ALTER TABLE ONLY secret_use_approvals FORCE ROW LEVEL SECURITY;

CREATE TABLE self_service_organization_setup_receipts (
    auth_user_id text NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    personal_workspace_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL,
    organization_name text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT self_service_organization_setup_fingerprint_check CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT self_service_organization_setup_name_check CHECK (((organization_name = btrim(organization_name)) AND ((octet_length(convert_to(organization_name, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(organization_name, 'UTF8'::name)) <= 120))))
);

ALTER TABLE ONLY self_service_organization_setup_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE self_service_organization_setup_receipts IS 'One completed organization setup per verified Better Auth user; stores idempotency evidence and the canonical personal-workspace result.';

CREATE TABLE session_admin_access (
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    granted_by_subject_id text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT session_admin_access_granted_by_subject_id_check CHECK (((char_length(granted_by_subject_id) >= 1) AND (char_length(granted_by_subject_id) <= 1024)))
);

ALTER TABLE ONLY session_admin_access FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_codemode_calls (
    operation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    catalog_digest text NOT NULL,
    request_digest text NOT NULL,
    server_id text NOT NULL,
    tool_name text NOT NULL,
    arguments jsonb NOT NULL,
    caller_subject_id text NOT NULL,
    state text DEFAULT 'queued'::text NOT NULL,
    claim_id uuid,
    result jsonb,
    error_code text,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    execution_started_at timestamp with time zone,
    claim_expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    durable_approval boolean DEFAULT false NOT NULL,
    approval_request_id uuid,
    effect_digest text,
    execution_attempt_id uuid,
    execution_attempt_generation integer,
    execution_catalog_digest text,
    CONSTRAINT session_attempt_codemode_calls_arguments_size_check CHECK (((jsonb_typeof(arguments) = 'object'::text) AND ((octet_length((arguments)::text) >= 2) AND (octet_length((arguments)::text) <= 4194304)))),
    CONSTRAINT session_attempt_codemode_calls_digests_check CHECK (((catalog_digest ~ '^[0-9a-f]{64}$'::text) AND (request_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT session_attempt_codemode_calls_generation_check CHECK ((execution_generation > 0)),
    CONSTRAINT session_attempt_codemode_calls_identity_check CHECK ((((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 256)) AND ((octet_length(tool_name) >= 1) AND (octet_length(tool_name) <= 512)) AND ((octet_length(caller_subject_id) >= 1) AND (octet_length(caller_subject_id) <= 1024)))),
    CONSTRAINT session_attempt_codemode_calls_lifecycle_check CHECK ((((state = ANY (ARRAY['queued'::text, 'waiting_for_approval'::text])) AND ((state <> 'waiting_for_approval'::text) OR (approval_request_id IS NOT NULL)) AND (claim_id IS NULL) AND (claimed_at IS NULL) AND (execution_started_at IS NULL) AND (claim_expires_at IS NULL) AND (completed_at IS NULL) AND (result IS NULL) AND (error_code IS NULL) AND (error_message IS NULL)) OR ((state = 'running'::text) AND (claim_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (completed_at IS NULL) AND (result IS NULL) AND (error_code IS NULL) AND (error_message IS NULL)) OR ((state = 'completed'::text) AND (claim_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (execution_started_at IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (result IS NOT NULL) AND (error_code IS NULL) AND (error_message IS NULL)) OR ((state = 'failed'::text) AND (claim_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (result IS NULL) AND (error_code IS NOT NULL) AND (error_message IS NOT NULL)) OR ((state = 'outcome_unknown'::text) AND (claim_id IS NOT NULL) AND (claimed_at IS NOT NULL) AND (execution_started_at IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (result IS NULL) AND (error_code IS NOT NULL) AND (error_message IS NOT NULL)) OR ((state = 'cancelled'::text) AND (claim_id IS NULL) AND (claimed_at IS NULL) AND (execution_started_at IS NULL) AND (claim_expires_at IS NULL) AND (completed_at IS NOT NULL) AND (result IS NULL) AND (error_code IS NOT NULL) AND (error_message IS NOT NULL)))),
    CONSTRAINT session_attempt_codemode_calls_result_size_check CHECK (((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND ((octet_length((result)::text) >= 2) AND (octet_length((result)::text) <= 16777216))))),
    CONSTRAINT session_codemode_continuation_check CHECK (((((execution_attempt_id IS NULL) AND (execution_attempt_generation IS NULL) AND (execution_catalog_digest IS NULL)) OR ((execution_attempt_id IS NOT NULL) AND (execution_attempt_generation IS NOT NULL) AND (execution_attempt_generation > 0) AND (execution_catalog_digest IS NOT NULL) AND (execution_catalog_digest ~ '^[0-9a-f]{64}$'::text))) AND ((approval_request_id IS NULL) OR (durable_approval AND (effect_digest IS NOT NULL) AND (effect_digest ~ '^[0-9a-f]{64}$'::text)))))
);

ALTER TABLE ONLY session_attempt_codemode_calls FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_connected_machine_authorizations (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    enrollment_id uuid NOT NULL,
    sandbox_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    enrollment_generation bigint NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch bigint NOT NULL,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY session_attempt_connected_machine_authorizations FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_interruptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    kind text NOT NULL,
    control_revision bigint NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    settled_at timestamp with time zone,
    attempt_quiesced boolean DEFAULT false NOT NULL,
    CONSTRAINT session_attempt_interruptions_kind_check CHECK ((kind = ANY (ARRAY['session_pause'::text, 'workspace_pause'::text, 'steer'::text, 'maintenance'::text, 'authority_change'::text, 'organization_membership_revoked'::text]))),
    CONSTRAINT session_attempt_interruptions_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'delivered'::text, 'acknowledged'::text, 'settled'::text, 'rejected_stale'::text])))
);

ALTER TABLE ONLY session_attempt_interruptions FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_machine_consents (
    attempt_id uuid NOT NULL,
    consent_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY session_attempt_machine_consents FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_model_context_snapshots (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    request_index integer NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    content_refs jsonb,
    CONSTRAINT session_attempt_model_context_snapshots_identity_check CHECK (((jsonb_typeof(snapshot) = 'object'::text) AND (snapshot ?& ARRAY['version'::text, 'capturedAt'::text, 'source'::text, 'requestIndex'::text, 'instructions'::text, 'layers'::text, 'tools'::text, 'skills'::text, 'tokens'::text]) AND (((snapshot ->> 'version'::text))::integer = 1) AND ((snapshot ->> 'source'::text) = 'model_request'::text) AND (jsonb_typeof((snapshot -> 'layers'::text)) = 'array'::text) AND (jsonb_typeof((snapshot -> 'tools'::text)) = 'array'::text) AND (jsonb_typeof((snapshot -> 'skills'::text)) = 'array'::text))),
    CONSTRAINT session_attempt_model_context_snapshots_request_index_check CHECK (((request_index > 0) AND (execution_generation > 0))),
    CONSTRAINT session_attempt_model_context_snapshots_size_check CHECK (((octet_length((snapshot)::text) >= 2) AND (octet_length((snapshot)::text) <= 16777216)))
);

ALTER TABLE ONLY session_attempt_model_context_snapshots FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_personal_document_admissions (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    document_count integer NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_attempt_personal_document_admissions_shape_chk CHECK (((execution_generation > 0) AND (membership_authorization_revision > 0) AND (session_authority_epoch > 0) AND (document_count >= 0) AND (session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND ((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024))))
);

ALTER TABLE ONLY session_attempt_personal_document_admissions FORCE ROW LEVEL SECURITY;

CREATE TABLE session_attempt_personal_document_snapshots (
    attempt_id uuid NOT NULL,
    document_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    target_workspace_id uuid NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    grant_context text NOT NULL,
    grant_session_id uuid,
    grant_authority_epoch integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_attempt_personal_document_snapshots_shape_chk CHECK (((execution_generation > 0) AND (membership_authorization_revision > 0) AND (authority_generation > 0) AND (target_workspace_id = workspace_id) AND (session_authority_epoch > 0) AND (grant_generation > 0) AND (session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (grant_context = session_visibility) AND (((grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((grant_mode = ANY (ARRAY['once'::text, 'session'::text])) AND (grant_session_id = session_id) AND (grant_authority_epoch = session_authority_epoch)))))
);

ALTER TABLE ONLY session_attempt_personal_document_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_attempt_personal_document_snapshots IS 'Immutable exact-attempt personal Document grants; shared-session snapshots require the grant lifecycle acknowledgement.';

CREATE TABLE session_attempt_personal_resource_admissions (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    resource_count integer NOT NULL,
    admitted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_attempt_personal_resource_admissions_generation_chk CHECK (((execution_generation > 0) AND (membership_authorization_revision > 0) AND (session_authority_epoch > 0) AND (resource_count > 0))),
    CONSTRAINT session_attempt_personal_resource_admissions_subject_chk CHECK (((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024))),
    CONSTRAINT session_attempt_personal_resource_admissions_visibility_chk CHECK ((session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))
);

ALTER TABLE ONLY session_attempt_personal_resource_admissions FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_attempt_personal_resource_admissions IS 'Exact accepted-attempt personal-resource authority receipt; no secrets or runtime materialization.';

CREATE TABLE session_attempt_personal_resource_snapshots (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    resource_version_id uuid,
    selection_sources text[] NOT NULL,
    action text NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    target_workspace_id uuid NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    grant_id uuid NOT NULL,
    grant_generation bigint NOT NULL,
    grant_mode text NOT NULL,
    grant_context text NOT NULL,
    grant_session_id uuid,
    grant_authority_epoch integer,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_attempt_personal_resource_snapshots_action_chk CHECK ((((resource_kind = 'variable_set'::text) AND (action = 'variable_set.use'::text)) OR ((resource_kind = 'rig'::text) AND (action = 'rig.use'::text)) OR ((resource_kind = 'connected_machine'::text) AND (action = 'connected_machine.use'::text)))),
    CONSTRAINT session_attempt_personal_resource_snapshots_generation_chk CHECK (((execution_generation > 0) AND (membership_authorization_revision > 0) AND (authority_generation > 0) AND (session_authority_epoch > 0) AND (grant_generation > 0))),
    CONSTRAINT session_attempt_personal_resource_snapshots_grant_fence_chk CHECK ((((grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((grant_mode = ANY (ARRAY['once'::text, 'session'::text])) AND (grant_session_id = session_id) AND (grant_authority_epoch = session_authority_epoch)))),
    CONSTRAINT session_attempt_personal_resource_snapshots_kind_chk CHECK ((((resource_kind = 'variable_set'::text) AND (resource_version_id IS NULL)) OR ((resource_kind = 'rig'::text) AND (resource_version_id IS NOT NULL)) OR ((resource_kind = 'connected_machine'::text) AND (resource_version_id IS NULL)))),
    CONSTRAINT session_attempt_personal_resource_snapshots_sources_chk CHECK ((cardinality(selection_sources) > 0)),
    CONSTRAINT session_attempt_personal_resource_snapshots_visibility_chk CHECK (((session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (grant_context = session_visibility))),
    CONSTRAINT session_attempt_personal_resource_snapshots_workspace_chk CHECK ((target_workspace_id = workspace_id))
);

ALTER TABLE ONLY session_attempt_personal_resource_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_attempt_personal_resource_snapshots IS 'Normalized immutable direct/transitive personal-resource delegation collection for one accepted attempt.';

CREATE TABLE session_attempt_tool_catalogs (
    attempt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    catalog_version integer NOT NULL,
    generation integer NOT NULL,
    digest text NOT NULL,
    catalog jsonb NOT NULL,
    created_at timestamp with time zone NOT NULL,
    content_refs jsonb,
    CONSTRAINT session_attempt_tool_catalogs_catalog_identity_check CHECK (((jsonb_typeof(catalog) = 'object'::text) AND (catalog ?& ARRAY['version'::text, 'accountId'::text, 'workspaceId'::text, 'sessionId'::text, 'turnId'::text, 'attemptId'::text, 'executionGeneration'::text, 'generation'::text, 'createdAt'::text, 'digest'::text, 'entries'::text]) AND ((catalog ->> 'accountId'::text) = (account_id)::text) AND ((catalog ->> 'workspaceId'::text) = (workspace_id)::text) AND ((catalog ->> 'sessionId'::text) = (session_id)::text) AND ((catalog ->> 'turnId'::text) = (turn_id)::text) AND ((catalog ->> 'attemptId'::text) = (attempt_id)::text) AND (((catalog ->> 'executionGeneration'::text))::integer = execution_generation) AND (((catalog ->> 'version'::text))::integer = catalog_version) AND (((catalog ->> 'generation'::text))::integer = generation) AND ((catalog ->> 'digest'::text) = digest) AND (jsonb_typeof((catalog -> 'entries'::text)) = 'array'::text) AND (jsonb_array_length((catalog -> 'entries'::text)) <= 4096))),
    CONSTRAINT session_attempt_tool_catalogs_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT session_attempt_tool_catalogs_size_check CHECK (((octet_length((catalog)::text) >= 2) AND (octet_length((catalog)::text) <= 16777216))),
    CONSTRAINT session_attempt_tool_catalogs_version_check CHECK (((catalog_version = 1) AND (generation > 0) AND (execution_generation > 0)))
);

ALTER TABLE ONLY session_attempt_tool_catalogs FORCE ROW LEVEL SECURITY;

CREATE TABLE session_background_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    provider text NOT NULL,
    state text DEFAULT 'running'::text NOT NULL,
    retained_process_id uuid,
    control_workspace_id uuid,
    enrollment_id uuid,
    connection_instance_id text,
    op_id text,
    command_preview text DEFAULT ''::text NOT NULL,
    cancel_requested_at timestamp with time zone,
    cancel_requested_by text,
    exit_code integer,
    settlement_reason text,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    settled_at timestamp with time zone,
    reconcile_after timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reconcile_claim_id uuid,
    reconcile_claimed_at timestamp with time zone,
    reconcile_attempts integer DEFAULT 0 NOT NULL,
    last_reconcile_outcome text,
    reconcile_proof_outcome text,
    reconcile_proof_exit_code integer,
    reconcile_proof_reason text,
    reconcile_proof_observed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completion_observed_at timestamp with time zone,
    runner_failure jsonb,
    launch_turn_id uuid,
    launch_attempt_id uuid,
    launch_execution_generation integer,
    command_text text,
    output_exit_seq text,
    output_attach_generation text,
    output_consumed_at timestamp with time zone,
    output_release_observed_at timestamp with time zone,
    output_unavailable_at timestamp with time zone,
    completion_notified_at timestamp with time zone,
    background_children_stopped boolean DEFAULT false NOT NULL,
    CONSTRAINT session_background_commands_launch_identity_check CHECK ((((launch_turn_id IS NULL) AND (launch_attempt_id IS NULL) AND (launch_execution_generation IS NULL)) OR ((launch_turn_id IS NOT NULL) AND (launch_attempt_id IS NOT NULL) AND (launch_execution_generation IS NOT NULL) AND (launch_execution_generation > 0)))),
    CONSTRAINT session_background_commands_lifecycle_check CHECK ((((state = 'running'::text) AND (cancel_requested_at IS NULL) AND (cancel_requested_by IS NULL) AND (exit_code IS NULL) AND (settlement_reason IS NULL) AND (settled_at IS NULL)) OR ((state = 'stopping'::text) AND (cancel_requested_at IS NOT NULL) AND (cancel_requested_by IS NOT NULL) AND ((octet_length(btrim(cancel_requested_by)) >= 1) AND (octet_length(btrim(cancel_requested_by)) <= 1024)) AND (exit_code IS NULL) AND (settlement_reason IS NULL) AND (settled_at IS NULL)) OR ((state = 'exited'::text) AND (settled_at IS NOT NULL) AND ((octet_length(btrim(settlement_reason)) >= 1) AND (octet_length(btrim(settlement_reason)) <= 512))) OR ((state = 'lost'::text) AND (exit_code IS NULL) AND (settled_at IS NOT NULL) AND ((octet_length(btrim(settlement_reason)) >= 1) AND (octet_length(btrim(settlement_reason)) <= 512))))),
    CONSTRAINT session_background_commands_observation_check CHECK (((completion_observed_at IS NULL) OR (state = ANY (ARRAY['exited'::text, 'lost'::text])))),
    CONSTRAINT session_background_commands_output_custody_check CHECK ((((output_exit_seq IS NULL) AND (output_attach_generation IS NULL) AND (output_consumed_at IS NULL) AND (output_release_observed_at IS NULL) AND ((output_unavailable_at IS NULL) OR ((provider = 'connected_machine'::text) AND (state = 'exited'::text)))) OR ((provider = 'connected_machine'::text) AND (state = 'exited'::text) AND (output_exit_seq IS NOT NULL) AND (output_attach_generation IS NOT NULL) AND (output_consumed_at IS NOT NULL) AND (output_unavailable_at IS NULL) AND (output_exit_seq ~ '^[1-9][0-9]{0,19}$'::text) AND (output_attach_generation ~ '^[1-9][0-9]{0,19}$'::text) AND ((output_exit_seq)::numeric <= '18446744073709551615'::numeric) AND ((output_attach_generation)::numeric <= '18446744073709551615'::numeric)))),
    CONSTRAINT session_background_commands_preview_check CHECK ((octet_length(command_preview) <= 2048)),
    CONSTRAINT session_background_commands_provider_check CHECK ((provider = ANY (ARRAY['managed'::text, 'connected_machine'::text]))),
    CONSTRAINT session_background_commands_provider_identity_check CHECK ((((provider = 'managed'::text) AND (retained_process_id IS NOT NULL) AND (control_workspace_id IS NULL) AND (enrollment_id IS NULL) AND (connection_instance_id IS NULL) AND (op_id IS NULL)) OR ((provider = 'connected_machine'::text) AND (retained_process_id IS NULL) AND (control_workspace_id IS NOT NULL) AND (enrollment_id IS NOT NULL) AND (connection_instance_id IS NOT NULL) AND ((octet_length(connection_instance_id) >= 1) AND (octet_length(connection_instance_id) <= 128)) AND (op_id IS NOT NULL) AND ((octet_length(op_id) >= 1) AND (octet_length(op_id) <= 256))))),
    CONSTRAINT session_background_commands_reconcile_check CHECK (((reconcile_attempts >= 0) AND (((reconcile_claim_id IS NULL) AND (reconcile_claimed_at IS NULL)) OR ((reconcile_claim_id IS NOT NULL) AND (reconcile_claimed_at IS NOT NULL))) AND ((last_reconcile_outcome IS NULL) OR ((octet_length(last_reconcile_outcome) >= 1) AND (octet_length(last_reconcile_outcome) <= 64))) AND (((reconcile_proof_outcome IS NULL) AND (reconcile_proof_exit_code IS NULL) AND (reconcile_proof_reason IS NULL) AND (reconcile_proof_observed_at IS NULL)) OR ((reconcile_proof_outcome = 'exited'::text) AND (reconcile_proof_exit_code IS NOT NULL) AND ((octet_length(btrim(reconcile_proof_reason)) >= 1) AND (octet_length(btrim(reconcile_proof_reason)) <= 512)) AND (reconcile_proof_observed_at IS NOT NULL)) OR ((reconcile_proof_outcome = 'lost'::text) AND (reconcile_proof_exit_code IS NULL) AND ((octet_length(btrim(reconcile_proof_reason)) >= 1) AND (octet_length(btrim(reconcile_proof_reason)) <= 512)) AND (reconcile_proof_observed_at IS NOT NULL))))),
    CONSTRAINT session_background_commands_runner_failure_check CHECK (((runner_failure IS NULL) OR ((provider = 'connected_machine'::text) AND (jsonb_typeof(runner_failure) = 'object'::text) AND (octet_length((runner_failure)::text) <= 8192) AND (runner_failure ?& ARRAY['code'::text, 'retryable'::text]) AND (jsonb_typeof((runner_failure -> 'code'::text)) = 'string'::text) AND ((runner_failure ->> 'code'::text) ~ '^[A-Za-z0-9_-]{1,128}$'::text) AND ((runner_failure -> 'retryable'::text) = 'false'::jsonb) AND ((NOT (runner_failure ? 'detail'::text)) OR (jsonb_typeof((runner_failure -> 'detail'::text)) = 'object'::text))))),
    CONSTRAINT session_background_commands_state_check CHECK ((state = ANY (ARRAY['running'::text, 'stopping'::text, 'exited'::text, 'lost'::text])))
);

ALTER TABLE ONLY session_background_commands FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_background_commands IS 'Provider-neutral durable lifecycle for commands explicitly transferred from a turn to its session.';

COMMENT ON COLUMN session_background_commands.retained_process_id IS 'Managed provider link. The retained process preserves immutable launch authority and exact provider identity.';

COMMENT ON COLUMN session_background_commands.control_workspace_id IS 'Connected Machine origin workspace used in the exact physical NATS subject; never rewritten from the session workspace.';

COMMENT ON COLUMN session_background_commands.connection_instance_id IS 'Connected Machine daemon instance admitted at launch; switching the session machine never rewrites it.';

CREATE TABLE session_command_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    actor_type text NOT NULL,
    actor_subject_id text,
    actor_attempt_id uuid,
    action text NOT NULL,
    target_session_id uuid,
    target_turn_id uuid,
    operation_key text NOT NULL,
    canonical_request_hash text NOT NULL,
    applied_control_revision bigint,
    applied_queue_version integer,
    applied_turn_version integer,
    applied_draft_revision bigint,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_command_receipts_actor_check CHECK ((((actor_type = 'agent_attempt'::text) AND (actor_attempt_id IS NOT NULL) AND (actor_subject_id IS NULL)) OR ((actor_type = ANY (ARRAY['human'::text, 'operator'::text, 'service'::text])) AND (actor_subject_id IS NOT NULL) AND (actor_attempt_id IS NULL))))
);

ALTER TABLE ONLY session_command_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE session_content_blobs (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    digest text NOT NULL,
    value jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_content_blobs_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY session_content_blobs FORCE ROW LEVEL SECURITY;

CREATE TABLE session_create_idempotency_guard (
    workspace_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    outcome text NOT NULL,
    session_id uuid,
    denial_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_create_idempotency_guard_outcome_check CHECK ((outcome = ANY (ARRAY['session'::text, 'denial'::text]))),
    CONSTRAINT session_create_idempotency_guard_target_check CHECK ((((outcome = 'session'::text) AND (session_id IS NOT NULL) AND (denial_id IS NULL)) OR ((outcome = 'denial'::text) AND (session_id IS NULL) AND (denial_id IS NOT NULL))))
);

CREATE TABLE session_event_cursors (
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    last_sequence integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_meaningful_sequence integer DEFAULT 0 NOT NULL,
    CONSTRAINT session_event_cursors_meaningful_sequence_check CHECK (((last_meaningful_sequence >= 0) AND (last_meaningful_sequence <= last_sequence))),
    CONSTRAINT session_event_cursors_revision_check CHECK ((revision >= 0)),
    CONSTRAINT session_event_cursors_sequence_check CHECK ((last_sequence >= 0))
)
WITH (autovacuum_analyze_scale_factor='0', autovacuum_analyze_threshold='50000');

ALTER TABLE ONLY session_event_cursors FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_event_cursors IS 'Narrow exact per-session event cursor. Migration 0374 mirrors sessions.last_sequence; a later activation may make this row the allocator and admission gate.';

COMMENT ON COLUMN session_event_cursors.revision IS 'Monotonic count of successful event-insert statements that advanced this cursor.';

COMMENT ON COLUMN session_event_cursors.last_meaningful_sequence IS 'Exact newest conversational output or actionable boundary. Backfilled from the meaningful attention index and advanced atomically with the raw append cursor.';

CREATE TABLE session_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    sequence integer NOT NULL,
    type text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_event_id text,
    producer_id text,
    producer_seq integer,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    turn_generation integer,
    turn_attempt_id uuid,
    turn_association text,
    duplicate_of_event_id uuid,
    duplicate_reason text,
    payload_codec_version integer,
    usage_source_key text,
    tool_name text,
    tool_call_id text,
    CONSTRAINT session_events_client_event_id_bytes_check CHECK (((client_event_id IS NULL) OR (octet_length(client_event_id) <= 1024))),
    CONSTRAINT session_events_duplicate_classification_check CHECK ((((turn_association = 'duplicate'::text) AND (type = 'agent.model.usage'::text) AND (duplicate_of_event_id IS NOT NULL) AND (duplicate_of_event_id <> id) AND (NULLIF(duplicate_reason, ''::text) IS NOT NULL)) OR ((turn_association IS DISTINCT FROM 'duplicate'::text) AND (duplicate_of_event_id IS NULL) AND (duplicate_reason IS NULL)))),
    CONSTRAINT session_events_duplicate_reason_bytes_check CHECK (((duplicate_reason IS NULL) OR (octet_length(duplicate_reason) <= 4096))),
    CONSTRAINT session_events_producer_id_bytes_check CHECK (((producer_id IS NULL) OR (octet_length(producer_id) <= 1024))),
    CONSTRAINT session_events_turn_association_bytes_check CHECK (((turn_association IS NULL) OR (octet_length(turn_association) <= 64))),
    CONSTRAINT session_events_turn_association_check CHECK (((turn_association IS NULL) OR (turn_association = ANY (ARRAY['current'::text, 'late_rejected'::text, 'duplicate'::text])))),
    CONSTRAINT session_events_type_bytes_check CHECK (((octet_length(type) <= 256) AND (POSITION(('
'::text) IN (type)) = 0) AND (POSITION((''::text) IN (type)) = 0)))
);

ALTER TABLE ONLY session_events FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_events.payload IS 'Canonical lossless event payload. Explicit read/transport projections apply their own byte bounds.';

CREATE TABLE session_goal_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    goal_id uuid NOT NULL,
    disposition text NOT NULL,
    change_kind text NOT NULL,
    base_objective_revision integer NOT NULL,
    result_objective_revision integer,
    text text NOT NULL,
    success_criteria text,
    mutation_policy text NOT NULL,
    rationale text NOT NULL,
    actor text NOT NULL,
    actor_turn_id uuid,
    actor_attempt_id uuid,
    proposal_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    root_constraints jsonb DEFAULT '[]'::jsonb NOT NULL,
    rollback_of_revision_id uuid,
    CONSTRAINT session_goal_revisions_actor_chk CHECK ((actor = ANY (ARRAY['agent'::text, 'api'::text, 'scheduled_task'::text]))),
    CONSTRAINT session_goal_revisions_change_kind_chk CHECK ((change_kind = ANY (ARRAY['refinement'::text, 'adaptation'::text, 'replacement'::text]))),
    CONSTRAINT session_goal_revisions_disposition_chk CHECK ((disposition = ANY (ARRAY['applied'::text, 'proposed'::text, 'rejected'::text]))),
    CONSTRAINT session_goal_revisions_lineage_shape_chk CHECK ((((disposition = 'proposed'::text) AND (proposal_id IS NULL) AND (rollback_of_revision_id IS NULL)) OR ((disposition = 'rejected'::text) AND (proposal_id IS NOT NULL) AND (rollback_of_revision_id IS NULL)) OR ((disposition = 'applied'::text) AND (NOT ((proposal_id IS NOT NULL) AND (rollback_of_revision_id IS NOT NULL)))))),
    CONSTRAINT session_goal_revisions_policy_chk CHECK ((mutation_policy = ANY (ARRAY['review_changes'::text, 'preserve_intent'::text, 'autonomous_adaptation'::text]))),
    CONSTRAINT session_goal_revisions_revision_shape_chk CHECK ((((disposition = 'applied'::text) AND (result_objective_revision = (base_objective_revision + 1))) OR ((disposition = ANY (ARRAY['proposed'::text, 'rejected'::text])) AND (result_objective_revision IS NULL)))),
    CONSTRAINT session_goal_revisions_root_constraints_chk CHECK (((jsonb_typeof(root_constraints) = 'array'::text) AND (root_constraints = session_goal_normalize_root_constraints(root_constraints))))
);

ALTER TABLE ONLY session_goal_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE session_goals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    text text NOT NULL,
    success_criteria text,
    evidence text,
    rationale text,
    paused_reason text,
    created_by text DEFAULT 'api'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    auto_continuations integer DEFAULT 0 NOT NULL,
    no_progress_streak integer DEFAULT 0 NOT NULL,
    max_auto_continuations integer,
    last_continuation_turn_id uuid,
    version_at_last_continuation integer,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    continuation_wake_revision bigint DEFAULT 0 NOT NULL,
    continuation_observed_revision bigint DEFAULT 0 NOT NULL,
    objective_revision integer DEFAULT 1 NOT NULL,
    mutation_policy text DEFAULT 'preserve_intent'::text NOT NULL,
    root_constraints jsonb DEFAULT '[]'::jsonb NOT NULL,
    continuation_suppressed_turn_id uuid,
    CONSTRAINT session_goals_continuation_revision_check CHECK (((continuation_wake_revision >= 0) AND (continuation_observed_revision >= 0) AND (continuation_observed_revision <= continuation_wake_revision) AND (continuation_wake_revision <= '9007199254740991'::bigint) AND (continuation_observed_revision <= '9007199254740991'::bigint))),
    CONSTRAINT session_goals_mutation_policy_chk CHECK ((mutation_policy = ANY (ARRAY['review_changes'::text, 'preserve_intent'::text, 'autonomous_adaptation'::text]))),
    CONSTRAINT session_goals_objective_revision_chk CHECK ((objective_revision > 0)),
    CONSTRAINT session_goals_root_constraints_chk CHECK (((jsonb_typeof(root_constraints) = 'array'::text) AND (root_constraints = session_goal_normalize_root_constraints(root_constraints))))
);

ALTER TABLE ONLY session_goals FORCE ROW LEVEL SECURITY;

CREATE TABLE session_history_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    "position" numeric NOT NULL,
    item jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    active boolean DEFAULT true NOT NULL,
    provider_artifact_invalidated_at timestamp with time zone,
    provider_artifact_invalidation_reason text,
    provider_artifact_invalidated_by_attempt_id uuid,
    item_codec_version integer,
    item_ordered json
);

ALTER TABLE ONLY session_history_items FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_history_items.item IS 'Canonical model/history item. PostgreSQL-unsafe string code units use a reversible per-string encoding that leaves structural JSON keys queryable.';

CREATE TABLE session_history_items_repair_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    "position" numeric NOT NULL,
    item jsonb NOT NULL,
    source_created_at timestamp with time zone NOT NULL,
    repair_reason text NOT NULL,
    repaired_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE session_human_input_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    turn_generation integer NOT NULL,
    creation_attempt_id uuid NOT NULL,
    tool_call_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    questions jsonb NOT NULL,
    allow_skip boolean DEFAULT false NOT NULL,
    response jsonb,
    responded_by text,
    responded_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    skill_review_human_authorized boolean DEFAULT false NOT NULL,
    origin text DEFAULT 'tool_call'::text NOT NULL,
    CONSTRAINT session_human_input_requests_actor_bytes_check CHECK (((responded_by IS NULL) OR (octet_length(responded_by) <= 1024))),
    CONSTRAINT session_human_input_requests_generation_check CHECK ((turn_generation > 0)),
    CONSTRAINT session_human_input_requests_questions_bytes_check CHECK ((octet_length((questions)::text) <= 49152)),
    CONSTRAINT session_human_input_requests_response_bytes_check CHECK (((response IS NULL) OR (octet_length((response)::text) <= 49152))),
    CONSTRAINT session_human_input_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'answered'::text, 'skipped'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT session_human_input_requests_tool_call_bytes_check CHECK (((octet_length(tool_call_id) >= 1) AND (octet_length(tool_call_id) <= 1024)))
);

ALTER TABLE ONLY session_human_input_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE session_list_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    parent_session_filter text DEFAULT 'all'::text NOT NULL,
    search text,
    ordinary_session_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archive_mode text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT session_list_snapshots_archive_mode_valid CHECK ((archive_mode = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT session_list_snapshots_parent_filter_valid CHECK (((parent_session_filter = 'all'::text) OR (parent_session_filter = 'null'::text) OR (parent_session_filter ~ '^[0-9a-fA-F-]{36}$'::text))),
    CONSTRAINT session_list_snapshots_search_length CHECK (((search IS NULL) OR (length(search) <= 200))),
    CONSTRAINT session_list_snapshots_subject_nonempty CHECK ((length(btrim(subject_id)) > 0))
);

ALTER TABLE ONLY session_list_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_list_snapshots.ordinary_session_ids IS 'Ordered slots of one short-lived cached list page. A slot holding the reserved all-zero UUID is a redacted session identity stripped by a visibility transition; it preserves cursor offsets and resolves to no session.';

CREATE TABLE session_mcp_servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    server_id text NOT NULL,
    name text,
    url text NOT NULL,
    allowed_tools jsonb,
    timeout_ms integer,
    cache_tools_list boolean DEFAULT false NOT NULL,
    headers_encrypted jsonb DEFAULT '{}'::jsonb NOT NULL,
    credential_version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    require_approval jsonb,
    connection_ref jsonb,
    CONSTRAINT session_mcp_servers_allowed_tools_array_chk CHECK (((allowed_tools IS NULL) OR (jsonb_typeof(allowed_tools) = 'array'::text))),
    CONSTRAINT session_mcp_servers_connection_ref_object_chk CHECK (((connection_ref IS NULL) OR ((jsonb_typeof(connection_ref) = 'object'::text) AND COALESCE((jsonb_typeof((connection_ref -> 'providerDomain'::text)) = 'string'::text), false) AND COALESCE((length((connection_ref ->> 'providerDomain'::text)) > 0), false)))),
    CONSTRAINT session_mcp_servers_credential_version_positive_chk CHECK ((credential_version > 0)),
    CONSTRAINT session_mcp_servers_headers_object_chk CHECK ((jsonb_typeof(headers_encrypted) = 'object'::text)),
    CONSTRAINT session_mcp_servers_timeout_positive_chk CHECK (((timeout_ms IS NULL) OR (timeout_ms > 0)))
);

ALTER TABLE ONLY session_mcp_servers FORCE ROW LEVEL SECURITY;

CREATE TABLE session_message_search_texts (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    sequence integer NOT NULL,
    encoded boolean NOT NULL,
    text text NOT NULL
);

ALTER TABLE ONLY session_message_search_texts FORCE ROW LEVEL SECURITY;

CREATE TABLE session_pending_tool_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    attempt_id uuid NOT NULL,
    call_id text NOT NULL,
    call_type text NOT NULL,
    call_item jsonb NOT NULL,
    result_item jsonb,
    result_recorded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model_tool_output_truncation_tokens integer,
    call_item_codec_version integer,
    result_item_codec_version integer,
    event_output jsonb,
    event_output_codec_version integer,
    interruption_kind text,
    tied_reasoning_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    tied_reasoning_items_codec_version integer,
    call_item_ordered json,
    result_item_ordered json,
    tied_reasoning_items_ordered json,
    CONSTRAINT session_pending_tool_calls_event_output_codec_version_chk CHECK ((((event_output IS NULL) AND (event_output_codec_version IS NULL)) OR ((event_output IS NOT NULL) AND (event_output_codec_version = 1)))),
    CONSTRAINT session_pending_tool_calls_interruption_kind_chk CHECK (((interruption_kind IS NULL) OR (interruption_kind = ANY (ARRAY['human_input'::text, 'approval'::text, 'interaction_intervention'::text])))),
    CONSTRAINT session_pending_tool_calls_tied_reasoning_items_chk CHECK ((jsonb_typeof(tied_reasoning_items) = 'array'::text))
);

ALTER TABLE ONLY session_pending_tool_calls FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_pending_tool_calls.call_item IS 'Canonical pending SDK call item; structural JSON keys remain SQL-queryable.';

COMMENT ON COLUMN session_pending_tool_calls.result_item IS 'Canonical pending SDK result item; structural JSON keys remain SQL-queryable.';

COMMENT ON COLUMN session_pending_tool_calls.event_output IS 'Lossless {value} envelope for the exact agent.toolCall.output projection retained until live publish or recovery.';

COMMENT ON COLUMN session_pending_tool_calls.event_output_codec_version IS 'Out-of-band lossless JSON codec version for event_output; NULL denotes an older writer or no retained event output.';

CREATE TABLE session_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    session_id uuid NOT NULL,
    pinned boolean DEFAULT true NOT NULL,
    pinned_at timestamp with time zone DEFAULT now(),
    version integer DEFAULT 1 NOT NULL,
    acknowledged_sequence integer DEFAULT 0 NOT NULL,
    actively_working boolean DEFAULT false NOT NULL,
    attention_version integer DEFAULT 0 NOT NULL,
    archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    archive_version integer DEFAULT 0 NOT NULL,
    manually_unread_through integer,
    CONSTRAINT session_pins_acknowledged_sequence_floor CHECK ((acknowledged_sequence >= '-1'::integer)),
    CONSTRAINT session_pins_archive_state_consistent CHECK (((archived AND (archived_at IS NOT NULL)) OR ((NOT archived) AND (archived_at IS NULL)))),
    CONSTRAINT session_pins_archive_version_nonnegative CHECK ((archive_version >= 0)),
    CONSTRAINT session_pins_attention_version_nonnegative CHECK ((attention_version >= 0)),
    CONSTRAINT session_pins_state_consistent CHECK (((pinned AND (pinned_at IS NOT NULL)) OR ((NOT pinned) AND (pinned_at IS NULL)))),
    CONSTRAINT session_pins_subject_nonempty CHECK ((length(btrim(subject_id)) > 0)),
    CONSTRAINT session_pins_version_nonnegative CHECK ((version >= 0))
);

ALTER TABLE ONLY session_pins FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_pins.acknowledged_sequence IS 'Highest durable session event sequence this subject explicitly acknowledged; -1 is an explicit unread sentinel for a zero-sequence session, and route views never advance it.';

COMMENT ON COLUMN session_pins.actively_working IS 'Personal durable label indicating that this subject intends to continue work on the session.';

COMMENT ON COLUMN session_pins.attention_version IS 'Independent optimistic revision for acknowledged_sequence and actively_working; zero means that domain has never changed.';

CREATE TABLE session_realtime_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    realtime_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    connection_epoch integer NOT NULL,
    startup_fence_sequence integer DEFAULT 0 NOT NULL,
    state text DEFAULT 'negotiating'::text NOT NULL,
    sdp_answer text,
    failure_code text,
    provider_session_id text,
    startup_event_id text,
    startup_acknowledged_at timestamp with time zone,
    negotiated_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    promotion_mode text DEFAULT 'legacy'::text NOT NULL,
    CONSTRAINT session_realtime_connections_epoch_check CHECK ((connection_epoch >= 1)),
    CONSTRAINT session_realtime_connections_failure_check CHECK (((failure_code IS NULL) OR ((octet_length(failure_code) >= 1) AND (octet_length(failure_code) <= 128)))),
    CONSTRAINT session_realtime_connections_promotion_mode_check CHECK ((promotion_mode = ANY (ARRAY['legacy'::text, 'staged'::text]))),
    CONSTRAINT session_realtime_connections_provider_session_check CHECK (((provider_session_id IS NULL) OR ((octet_length(provider_session_id) >= 1) AND (octet_length(provider_session_id) <= 1024)))),
    CONSTRAINT session_realtime_connections_sdp_check CHECK (((sdp_answer IS NULL) OR ((octet_length(sdp_answer) >= 1) AND (octet_length(sdp_answer) <= 1048576)))),
    CONSTRAINT session_realtime_connections_startup_ack_check CHECK ((((startup_acknowledged_at IS NULL) AND (provider_session_id IS NULL) AND (startup_event_id IS NULL)) OR ((startup_acknowledged_at IS NOT NULL) AND (provider_session_id IS NOT NULL)))),
    CONSTRAINT session_realtime_connections_startup_event_check CHECK (((startup_event_id IS NULL) OR ((octet_length(startup_event_id) >= 1) AND (octet_length(startup_event_id) <= 1024)))),
    CONSTRAINT session_realtime_connections_startup_fence_check CHECK ((startup_fence_sequence >= 0)),
    CONSTRAINT session_realtime_connections_state_check CHECK ((state = ANY (ARRAY['negotiating'::text, 'ready'::text, 'active'::text, 'failed'::text, 'closed'::text]))),
    CONSTRAINT session_realtime_connections_terminal_check CHECK ((((state = 'negotiating'::text) AND (sdp_answer IS NULL) AND (failure_code IS NULL) AND (negotiated_at IS NULL) AND (closed_at IS NULL)) OR ((state = 'ready'::text) AND (sdp_answer IS NOT NULL) AND (failure_code IS NULL) AND (negotiated_at IS NOT NULL) AND (closed_at IS NULL)) OR ((state = 'active'::text) AND (sdp_answer IS NOT NULL) AND (failure_code IS NULL) AND (negotiated_at IS NOT NULL) AND (closed_at IS NULL)) OR ((state = 'failed'::text) AND (sdp_answer IS NULL) AND (failure_code IS NOT NULL) AND (closed_at IS NOT NULL)) OR ((state = 'closed'::text) AND (closed_at IS NOT NULL))))
);

ALTER TABLE ONLY session_realtime_connections FORCE ROW LEVEL SECURITY;

CREATE TABLE session_realtime_context_projections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    context text,
    source_mode_count integer NOT NULL,
    source_entry_count integer NOT NULL,
    included_entry_count integer NOT NULL,
    omitted_entry_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_realtime_context_projections_context_check CHECK (((context IS NULL) OR ((octet_length(context) >= 1) AND (octet_length(context) <= 65536)))),
    CONSTRAINT session_realtime_context_projections_counts_check CHECK (((source_mode_count >= 1) AND (source_entry_count >= 0) AND (included_entry_count >= 0) AND (omitted_entry_count >= 0) AND ((included_entry_count + omitted_entry_count) = source_entry_count) AND (((source_entry_count = 0) AND (context IS NULL)) OR ((source_entry_count > 0) AND (context IS NOT NULL)))))
);

ALTER TABLE ONLY session_realtime_context_projections FORCE ROW LEVEL SECURITY;

CREATE TABLE session_realtime_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    realtime_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    connection_epoch integer NOT NULL,
    sequence integer NOT NULL,
    direction text NOT NULL,
    kind text NOT NULL,
    role text,
    provider_event_id text,
    delegation_item_id text,
    source_update_id uuid,
    history_item_id uuid,
    turn_id uuid,
    text text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_acked_at timestamp with time zone,
    provider_acked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    text_codec_version integer,
    payload_codec_version integer,
    model_context text,
    CONSTRAINT session_realtime_entries_delegation_item_check CHECK (((delegation_item_id IS NULL) OR ((octet_length(delegation_item_id) >= 1) AND (octet_length(delegation_item_id) <= 1024)))),
    CONSTRAINT session_realtime_entries_direction_check CHECK ((direction = ANY (ARRAY['provider_in'::text, 'provider_out'::text]))),
    CONSTRAINT session_realtime_entries_epoch_check CHECK ((connection_epoch >= 1)),
    CONSTRAINT session_realtime_entries_kind_check CHECK ((kind = ANY (ARRAY['user_transcript'::text, 'assistant_transcript'::text, 'delegation_call'::text, 'delegation_progress'::text, 'delegation_result'::text, 'interruption'::text, 'session_update'::text, 'error'::text]))),
    CONSTRAINT session_realtime_entries_model_context_check CHECK (((model_context IS NULL) OR ((direction = 'provider_in'::text) AND (kind = ANY (ARRAY['delegation_call'::text, 'user_transcript'::text, 'assistant_transcript'::text])) AND opengeni_private.model_context_value_valid(model_context)))),
    CONSTRAINT session_realtime_entries_provider_event_check CHECK (((provider_event_id IS NULL) OR ((octet_length(provider_event_id) >= 1) AND (octet_length(provider_event_id) <= 1024)))),
    CONSTRAINT session_realtime_entries_role_check CHECK (((role IS NULL) OR (role = ANY (ARRAY['user'::text, 'assistant'::text])))),
    CONSTRAINT session_realtime_entries_sequence_check CHECK ((sequence >= 1)),
    CONSTRAINT session_realtime_entries_transcript_check CHECK ((((kind = 'user_transcript'::text) AND (role = 'user'::text) AND (text IS NOT NULL)) OR ((kind = 'assistant_transcript'::text) AND (role = 'assistant'::text) AND (text IS NOT NULL)) OR ((kind <> ALL (ARRAY['user_transcript'::text, 'assistant_transcript'::text])) AND (role IS NULL)))),
    CONSTRAINT session_realtime_entries_turn_check CHECK (((turn_id IS NULL) OR ((kind = 'delegation_call'::text) AND (direction = 'provider_in'::text)) OR ((kind = ANY (ARRAY['delegation_progress'::text, 'delegation_result'::text, 'error'::text])) AND (direction = 'provider_out'::text))))
);

ALTER TABLE ONLY session_realtime_entries FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_realtime_entries.model_context IS 'Application context attached to an exact provider-in delegation or finalized transcript and materialized as ordinary user-role content.';

CREATE TABLE session_realtime_modes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    browser_instance_id text NOT NULL,
    owner_key_hash text NOT NULL,
    model text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    connection_epoch integer DEFAULT 1 NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    last_heartbeat_at timestamp with time zone NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    end_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    context_projection_id uuid,
    context_projected_at timestamp with time zone,
    personal_connection_delegations jsonb DEFAULT '[]'::jsonb NOT NULL,
    mcp_account_bindings jsonb,
    connection_account_intent jsonb,
    CONSTRAINT session_realtime_modes_browser_instance_check CHECK (((octet_length(browser_instance_id) >= 1) AND (octet_length(browser_instance_id) <= 256))),
    CONSTRAINT session_realtime_modes_connection_account_intent_shape CHECK (opengeni_private.connection_account_intent_is_valid(connection_account_intent)),
    CONSTRAINT session_realtime_modes_context_projection_check CHECK ((((context_projection_id IS NULL) AND (context_projected_at IS NULL)) OR ((context_projection_id IS NOT NULL) AND (context_projected_at IS NOT NULL) AND (state = 'ended'::text)))),
    CONSTRAINT session_realtime_modes_end_reason_check CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['user_stop'::text, 'browser_unload'::text, 'lease_expired'::text, 'authority_revoked'::text])))),
    CONSTRAINT session_realtime_modes_epoch_check CHECK ((connection_epoch >= 1)),
    CONSTRAINT session_realtime_modes_lease_check CHECK ((lease_expires_at > last_heartbeat_at)),
    CONSTRAINT session_realtime_modes_model_check CHECK ((model = ANY (ARRAY['opengeni-azure/gpt-live-1'::text, 'gpt-live-1-boulder-alpha'::text, 'supergrok/grok-voice-think-fast-2.0'::text, 'opengeni-gateway/openai/gpt-realtime-2.1'::text, 'opengeni-gateway/openai/gpt-realtime-mini'::text, 'opengeni-gateway/xai/grok-voice-think-fast-2.0'::text, 'workspace-gateway/openai/gpt-realtime-2.1'::text, 'workspace-gateway/openai/gpt-realtime-mini'::text, 'workspace-gateway/xai/grok-voice-think-fast-2.0'::text, 'workspace-elevenlabs/eleven_realtime_v1_max'::text, 'workspace-elevenlabs/eleven_realtime_v1_mini'::text]))),
    CONSTRAINT session_realtime_modes_owner_key_hash_check CHECK ((owner_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT session_realtime_modes_owner_subject_check CHECK (((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 1024))),
    CONSTRAINT session_realtime_modes_state_check CHECK ((state = ANY (ARRAY['active'::text, 'ended'::text]))),
    CONSTRAINT session_realtime_modes_terminal_check CHECK ((((state = 'active'::text) AND (ended_at IS NULL) AND (end_reason IS NULL)) OR ((state = 'ended'::text) AND (ended_at IS NOT NULL) AND (end_reason IS NOT NULL)))),
    CONSTRAINT session_realtime_modes_version_check CHECK ((version >= 1))
);

ALTER TABLE ONLY session_realtime_modes FORCE ROW LEVEL SECURITY;

CREATE TABLE session_recordings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    state text NOT NULL,
    mode text NOT NULL,
    codec text NOT NULL,
    storage_key text,
    size_bytes bigint,
    duration_seconds double precision,
    width integer NOT NULL,
    height integer NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finalized_at timestamp with time zone,
    reason_codec_version integer,
    CONSTRAINT session_recordings_codec_chk CHECK ((codec = ANY (ARRAY['h264-mp4'::text, 'vp9-webm'::text]))),
    CONSTRAINT session_recordings_mode_chk CHECK ((mode = ANY (ARRAY['manual'::text, 'on-turn'::text, 'on-verify'::text]))),
    CONSTRAINT session_recordings_state_chk CHECK ((state = ANY (ARRAY['recording'::text, 'finalizing'::text, 'available'::text, 'failed'::text])))
);

ALTER TABLE ONLY session_recordings FORCE ROW LEVEL SECURITY;

CREATE TABLE session_spawn_denials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    parent_session_id uuid,
    root_session_id uuid,
    current_depth integer NOT NULL,
    attempted_depth bigint NOT NULL,
    effective_max_nested_agent_depth integer NOT NULL,
    requested_max_nested_agent_depth_override integer,
    policy_source text NOT NULL,
    policy_session_id uuid,
    subject_id text,
    code text NOT NULL,
    idempotency_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_spawn_denials_code_check CHECK ((code = ANY (ARRAY['nested_agent_depth_exceeded'::text, 'nested_agent_depth_override_forbidden'::text]))),
    CONSTRAINT session_spawn_denials_depth_check CHECK (((current_depth >= 0) AND (attempted_depth >= 0) AND (effective_max_nested_agent_depth >= 0) AND ((requested_max_nested_agent_depth_override IS NULL) OR (requested_max_nested_agent_depth_override >= 0)))),
    CONSTRAINT session_spawn_denials_policy_source_check CHECK ((policy_source = ANY (ARRAY['session'::text, 'workspace'::text, 'deployment'::text, 'default'::text])))
);

ALTER TABLE ONLY session_spawn_denials FORCE ROW LEVEL SECURITY;

CREATE TABLE session_stream_acknowledgments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sandbox_group_id uuid NOT NULL,
    subject_id text NOT NULL,
    acknowledged_unredacted boolean DEFAULT true NOT NULL,
    acknowledged_shared boolean DEFAULT false NOT NULL,
    acknowledged_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY session_stream_acknowledgments FORCE ROW LEVEL SECURITY;

CREATE TABLE session_system_update_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_session_id uuid NOT NULL,
    target_session_id uuid NOT NULL,
    dedupe_key text NOT NULL,
    kind text NOT NULL,
    classification text NOT NULL,
    source_id text NOT NULL,
    summary text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    lineage jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    update_id uuid,
    last_error text,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    personal_connection_delegations jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary_codec_version integer,
    payload_codec_version integer,
    codex_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    xai_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    mcp_account_bindings jsonb,
    claude_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    subscription_authority jsonb,
    authority_inserted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT session_system_update_outbox_claude_authority_snapshot_chk CHECK (claude_provider_account_authority_snapshot_v1_valid(claude_provider_account_authority_snapshot)),
    CONSTRAINT session_system_update_outbox_mcp_account_bindings_check CHECK (((mcp_account_bindings IS NULL) OR (jsonb_typeof(mcp_account_bindings) = 'array'::text))),
    CONSTRAINT session_system_update_outbox_subscription_authority_v2_chk CHECK (((subscription_authority IS NULL) OR subscription_personal_authority_v2_valid(subscription_authority))),
    CONSTRAINT session_system_update_outbox_xai_authority_snapshot_chk CHECK (xai_provider_account_authority_snapshot_v1_valid(xai_provider_account_authority_snapshot)),
    CONSTRAINT session_update_outbox_personal_delegations_array_chk CHECK (((jsonb_typeof(personal_connection_delegations) = 'array'::text) AND (jsonb_array_length(personal_connection_delegations) <= 128))),
    CONSTRAINT system_update_outbox_codex_authority_snapshot_chk CHECK (codex_provider_account_authority_snapshot_v1_valid(codex_provider_account_authority_snapshot)),
    CONSTRAINT system_update_outbox_kind_check CHECK ((kind = ANY (ARRAY['child_terminal_result'::text, 'child_requires_action'::text, 'child_requires_action_resolved'::text, 'child_paused'::text, 'child_waiting_capacity'::text, 'child_progress'::text]))),
    CONSTRAINT system_update_outbox_payload_kind_check CHECK (((payload ->> 'type'::text) = kind)),
    CONSTRAINT system_update_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'delivered'::text, 'failed'::text])))
);

ALTER TABLE ONLY session_system_update_outbox FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_system_update_outbox.codex_provider_account_authority_snapshot IS 'Opaque identifier-free Codex provider-account authority snapshot for child-result delivery provenance.';

COMMENT ON COLUMN session_system_update_outbox.xai_provider_account_authority_snapshot IS 'Immutable identifier-free xAI provider-account authority snapshot preserved through child-result delivery.';

CREATE TABLE session_tenancy_activations (
    account_id uuid NOT NULL,
    activation_version integer NOT NULL,
    inventory_digest text NOT NULL,
    parity_digest text NOT NULL,
    activated_by text NOT NULL,
    activated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    backfill_receipt_ids uuid[] DEFAULT ARRAY[]::uuid[] NOT NULL,
    CONSTRAINT session_tenancy_activation_backfill_receipts_check CHECK ((cardinality(backfill_receipt_ids) = ANY (ARRAY[0, 6]))),
    CONSTRAINT session_tenancy_activations_actor_check CHECK (((octet_length(activated_by) >= 1) AND (octet_length(activated_by) <= 256))),
    CONSTRAINT session_tenancy_activations_digests_check CHECK (((inventory_digest ~ '^[0-9a-f]{64}$'::text) AND (parity_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT session_tenancy_activations_version_check CHECK ((activation_version = 1))
);

ALTER TABLE ONLY session_tenancy_activations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_tenancy_activations IS 'Forward-only per-organization activation receipt for session visibility mutation and private fork.';

CREATE TABLE session_tenancy_additional_organization_activation_evidence (
    account_id uuid NOT NULL,
    eligibility_version integer NOT NULL,
    creation_operation_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    personal_workspace_id uuid NOT NULL,
    shared_workspace_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL,
    boundary_witness_account_id uuid NOT NULL,
    boundary_witness_activated_at timestamp with time zone NOT NULL,
    graph_evidence jsonb NOT NULL,
    graph_digest text NOT NULL,
    activation_parity_digest text NOT NULL,
    private_setting_version bigint NOT NULL,
    private_setting_event_id uuid NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_tenancy_additional_organization_actor_check CHECK ((actor_subject_id ~~ 'user:%'::text)),
    CONSTRAINT session_tenancy_additional_organization_digests_check CHECK (((graph_digest ~ '^[0-9a-f]{64}$'::text) AND (activation_parity_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT session_tenancy_additional_organization_eligibility_check CHECK ((eligibility_version = 1)),
    CONSTRAINT session_tenancy_additional_organization_graph_check CHECK ((jsonb_typeof(graph_evidence) = 'object'::text)),
    CONSTRAINT session_tenancy_additional_organization_setting_version_check CHECK ((private_setting_version > 0)),
    CONSTRAINT session_tenancy_additional_organization_witness_check CHECK ((boundary_witness_account_id <> account_id)),
    CONSTRAINT session_tenancy_additional_organization_workspaces_check CHECK ((personal_workspace_id <> shared_workspace_id))
);

ALTER TABLE ONLY session_tenancy_additional_organization_activation_evidence FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_tenancy_additional_organization_activation_evidence IS 'Immutable graph, boundary-witness, private-setting, and activation evidence for a newly created additional organization.';

CREATE TABLE session_tenancy_greenfield_activation_evidence (
    account_id uuid NOT NULL,
    eligibility_version integer NOT NULL,
    setup_auth_user_id text NOT NULL,
    setup_operation_id uuid NOT NULL,
    setup_request_fingerprint text NOT NULL,
    personal_workspace_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL,
    boundary_witness_account_id uuid NOT NULL,
    boundary_witness_activated_at timestamp with time zone NOT NULL,
    graph_evidence jsonb NOT NULL,
    graph_digest text NOT NULL,
    activation_parity_digest text NOT NULL,
    private_setting_version bigint NOT NULL,
    private_setting_event_id uuid NOT NULL,
    activated_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT session_tenancy_greenfield_digests_check CHECK (((graph_digest ~ '^[0-9a-f]{64}$'::text) AND (activation_parity_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT session_tenancy_greenfield_eligibility_version_check CHECK ((eligibility_version = 1)),
    CONSTRAINT session_tenancy_greenfield_fingerprint_check CHECK ((setup_request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT session_tenancy_greenfield_graph_check CHECK ((jsonb_typeof(graph_evidence) = 'object'::text)),
    CONSTRAINT session_tenancy_greenfield_setting_version_check CHECK ((private_setting_version > 0)),
    CONSTRAINT session_tenancy_greenfield_witness_check CHECK ((boundary_witness_account_id <> account_id))
);

ALTER TABLE ONLY session_tenancy_greenfield_activation_evidence FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_tenancy_greenfield_activation_evidence IS 'Immutable exact-setup, Personal-only graph, boundary-witness, private-setting, and v1 activation evidence for eligible newly inserted organizations.';

CREATE TABLE session_title_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    source_turn_id uuid NOT NULL,
    source_attempt_id uuid NOT NULL,
    source_execution_generation bigint NOT NULL,
    provider text NOT NULL,
    connection_id uuid,
    request_encrypted text,
    response_encrypted text,
    state text DEFAULT 'pending'::text NOT NULL,
    holder_id text,
    generation bigint DEFAULT 0 NOT NULL,
    leased_until timestamp with time zone,
    request_operation_id uuid,
    workflow_retry_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_title_operations_generation_check CHECK (((generation >= 0) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT session_title_operations_lease_chk CHECK ((((holder_id IS NULL) = (leased_until IS NULL)) AND ((holder_id IS NULL) OR ((octet_length(holder_id) >= 1) AND (octet_length(holder_id) <= 256))))),
    CONSTRAINT session_title_operations_payload_chk CHECK (((state <> ALL (ARRAY['pending'::text, 'dispatching'::text, 'responded'::text])) OR (request_encrypted IS NOT NULL))),
    CONSTRAINT session_title_operations_source_execution_generation_check CHECK ((source_execution_generation > 0)),
    CONSTRAINT session_title_operations_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'dispatching'::text, 'responded'::text, 'completed'::text, 'failed'::text, 'unknown'::text])))
);

ALTER TABLE ONLY session_title_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE session_turn_app_action_grants (
    turn_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    changes text NOT NULL,
    permissions text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_turn_app_action_grants_changes_check CHECK ((changes = ANY (ARRAY['confirm'::text, 'none'::text]))),
    CONSTRAINT session_turn_app_action_grants_permissions_check CHECK ((cardinality(permissions) <= 512)),
    CONSTRAINT session_turn_app_action_grants_subject_id_check CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 1024)))
);

ALTER TABLE ONLY session_turn_app_action_grants FORCE ROW LEVEL SECURITY;

CREATE TABLE session_turn_attempts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    state text DEFAULT 'claimed'::text NOT NULL,
    outcome text,
    temporal_workflow_id text NOT NULL,
    temporal_workflow_run_id text NOT NULL,
    temporal_activity_id text NOT NULL,
    worker_id text,
    lease_id text,
    lease_expires_at timestamp with time zone,
    verified_control_revision bigint NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    closed_at timestamp with time zone,
    quiesced_at timestamp with time zone,
    mcp_approval_policies jsonb NOT NULL,
    connector_action_policies jsonb DEFAULT '[]'::jsonb NOT NULL,
    authority_epoch integer NOT NULL,
    authority_visibility text NOT NULL,
    authority_owner_organization_membership_id uuid,
    personal_resource_protocol_version integer DEFAULT 0 NOT NULL,
    CONSTRAINT session_turn_attempts_authority_epoch_check CHECK (((authority_epoch IS NOT NULL) AND (authority_visibility IS NOT NULL) AND (authority_epoch > 0))),
    CONSTRAINT session_turn_attempts_authority_owner_shape_check CHECK (((authority_visibility <> 'user_private'::text) OR (authority_owner_organization_membership_id IS NOT NULL))),
    CONSTRAINT session_turn_attempts_authority_visibility_check CHECK (((authority_epoch IS NOT NULL) AND (authority_visibility IS NOT NULL) AND (authority_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))),
    CONSTRAINT session_turn_attempts_closed_check CHECK ((((state = 'closed'::text) AND (outcome IS NOT NULL) AND (closed_at IS NOT NULL)) OR ((state <> 'closed'::text) AND (outcome IS NULL) AND (closed_at IS NULL)))),
    CONSTRAINT session_turn_attempts_connector_action_policies_chk CHECK (((jsonb_typeof(connector_action_policies) = 'array'::text) AND (jsonb_array_length(connector_action_policies) <= 2048))),
    CONSTRAINT session_turn_attempts_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'requires_action'::text, 'waiting_capacity'::text, 'interrupted_recoverable'::text, 'lease_lost_recoverable'::text, 'pre_cutover_closed'::text])))),
    CONSTRAINT session_turn_attempts_personal_resource_protocol_chk CHECK ((personal_resource_protocol_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT session_turn_attempts_state_check CHECK ((state = ANY (ARRAY['claimed'::text, 'running'::text, 'closed'::text])))
);

ALTER TABLE ONLY session_turn_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE session_turn_machine_consents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    sandbox_id uuid NOT NULL,
    consenting_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    enrollment_generation bigint NOT NULL,
    session_authority_epoch bigint NOT NULL,
    route_epoch bigint NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY session_turn_machine_consents FORCE ROW LEVEL SECURITY;
