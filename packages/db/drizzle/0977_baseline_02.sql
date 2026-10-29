-- deployment-mode: rolling
-- Opengeni baseline part 2 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE TABLE claude_subscription_account_usage (
    credential_id uuid NOT NULL,
    account_id uuid NOT NULL,
    credential_version integer NOT NULL,
    snapshot jsonb NOT NULL,
    model_cooldowns jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT claude_subscription_account_usage_generation_chk CHECK ((credential_version > 0))
);

ALTER TABLE ONLY claude_subscription_account_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE claude_subscription_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    credential_encrypted text NOT NULL,
    provider_account_id text,
    label text,
    account_email text,
    plan_type text,
    status text DEFAULT 'active'::text NOT NULL,
    expires_at timestamp with time zone,
    last_refresh_at timestamp with time zone,
    last_error text,
    version integer DEFAULT 1 NOT NULL,
    allocator_enabled boolean DEFAULT true NOT NULL,
    allocator_version integer DEFAULT 1 NOT NULL,
    allocator_updated_at timestamp with time zone,
    quota_used_percent integer,
    quota_reset_at timestamp with time zone,
    quota_checked_at timestamp with time zone,
    exhausted_until timestamp with time zone,
    selection_count integer DEFAULT 0 NOT NULL,
    last_selected_at timestamp with time zone,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    owner_organization_membership_id uuid,
    organization_user_resource_authority_id uuid,
    organization_user_resource_kind text,
    organization_user_resource_authority_generation bigint,
    connected_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    allowed_model_ids text[],
    allowed_workspace_ids uuid[],
    allow_personal_workspaces boolean DEFAULT true NOT NULL,
    access_policy_version integer DEFAULT 1 NOT NULL,
    access_policy_updated_by text,
    access_policy_updated_at timestamp with time zone,
    CONSTRAINT claude_credential_scope_workspace_shape CHECK (((authority_scope = 'organization'::text) = (workspace_id IS NULL))),
    CONSTRAINT claude_subscription_credentials_access_policy_shape CHECK (((access_policy_version > 0) AND (COALESCE(cardinality(allowed_model_ids), 0) <= 500) AND (COALESCE(cardinality(allowed_workspace_ids), 0) <= 500) AND (array_position(allowed_model_ids, NULL::text) IS NULL) AND (array_position(allowed_workspace_ids, NULL::uuid) IS NULL))),
    CONSTRAINT claude_subscription_credentials_authority_scope_chk CHECK ((authority_scope = ANY (ARRAY['workspace'::text, 'user'::text, 'organization'::text]))),
    CONSTRAINT claude_subscription_credentials_authority_shape_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL) AND (organization_user_resource_authority_id IS NULL) AND (organization_user_resource_kind IS NULL) AND (organization_user_resource_authority_generation IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL) AND (organization_user_resource_authority_id IS NOT NULL) AND (organization_user_resource_kind = 'claude_subscription'::text) AND (organization_user_resource_authority_generation > 0)))),
    CONSTRAINT claude_subscription_credentials_quota_chk CHECK (((quota_used_percent IS NULL) OR ((quota_used_percent >= 0) AND (quota_used_percent <= 100)))),
    CONSTRAINT claude_subscription_credentials_selection_chk CHECK ((selection_count >= 0)),
    CONSTRAINT claude_subscription_credentials_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'needs_relogin'::text, 'error'::text, 'disabled'::text]))),
    CONSTRAINT claude_subscription_credentials_subject_chk CHECK (((connected_by_subject_id IS NULL) OR ((length(btrim(connected_by_subject_id)) >= 1) AND (length(btrim(connected_by_subject_id)) <= 1024)))),
    CONSTRAINT claude_subscription_credentials_versions_chk CHECK (((version > 0) AND (allocator_version > 0)))
);

ALTER TABLE ONLY claude_subscription_credentials FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_apps_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    credential_id uuid,
    version integer DEFAULT 1 NOT NULL,
    designated_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT codex_apps_settings_designation_shape_chk CHECK (((version > 0) AND (((credential_id IS NULL) AND (designated_at IS NULL)) OR ((credential_id IS NOT NULL) AND (designated_at IS NOT NULL)))))
);

ALTER TABLE ONLY codex_apps_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_capacity_waiters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    goal_id uuid,
    blocked_turn_id uuid NOT NULL,
    workflow_id text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    goal_version integer,
    policy_hash text,
    earliest_reset_at timestamp with time zone,
    next_check_at timestamp with time zone NOT NULL,
    reset_kind text NOT NULL,
    refresh_attempt integer DEFAULT 0 NOT NULL,
    wake_revision integer DEFAULT 1 NOT NULL,
    observed_wake_revision integer DEFAULT 0 NOT NULL,
    last_wake_reason text DEFAULT 'capacity_wait_armed'::text NOT NULL,
    resumed_update_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    blocked_turn_generation integer NOT NULL,
    CONSTRAINT codex_capacity_waiters_generation_check CHECK (((generation > 0) AND (blocked_turn_generation > 0) AND (((goal_id IS NULL) AND (goal_version IS NULL)) OR ((goal_id IS NOT NULL) AND (goal_version > 0))))),
    CONSTRAINT codex_capacity_waiters_refresh_attempt_check CHECK ((refresh_attempt >= 0)),
    CONSTRAINT codex_capacity_waiters_reset_kind_check CHECK ((reset_kind = ANY (ARRAY['authoritative'::text, 'bounded_refresh'::text, 'mutation_only'::text]))),
    CONSTRAINT codex_capacity_waiters_revision_check CHECK (((wake_revision > 0) AND (observed_wake_revision >= 0) AND (observed_wake_revision <= wake_revision))),
    CONSTRAINT codex_capacity_waiters_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'resumed'::text, 'superseded'::text])))
);

ALTER TABLE ONLY codex_capacity_waiters FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_credential_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    holder_id text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    leased_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY codex_credential_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_reset_redemption_attempts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    credential_id uuid NOT NULL,
    subject_id text NOT NULL,
    browser_session_hash text NOT NULL,
    credit_id text NOT NULL,
    upstream_idempotency_key uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    outcome text,
    claim_holder_id uuid,
    claim_expires_at timestamp with time zone,
    confirmation_expires_at timestamp with time zone NOT NULL,
    provider_started_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_failure_kind text,
    retry_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT codex_reset_redemption_completed_check CHECK (((status = 'completed'::text) = ((outcome IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT codex_reset_redemption_human_subject_check CHECK ((subject_id ~~ 'user:_%'::text)),
    CONSTRAINT codex_reset_redemption_outcome_check CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['reset'::text, 'nothingToReset'::text, 'noCredit'::text, 'alreadyRedeemed'::text])))),
    CONSTRAINT codex_reset_redemption_retry_count_check CHECK ((retry_count >= 0)),
    CONSTRAINT codex_reset_redemption_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'provider_started'::text, 'completed'::text])))
);

ALTER TABLE ONLY codex_reset_redemption_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_rotation_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    active_credential_id uuid,
    rotation_enabled boolean DEFAULT false NOT NULL,
    rotation_strategy text DEFAULT 'sharded'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY codex_rotation_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE codex_subscription_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    credential_encrypted text NOT NULL,
    chatgpt_account_id text,
    scopes text,
    plan_type text,
    is_fedramp boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    last_refresh_at timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    last_error text,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    label text,
    account_email text,
    primary_used_percent integer,
    primary_reset_at timestamp with time zone,
    secondary_used_percent integer,
    secondary_reset_at timestamp with time zone,
    usage_checked_at timestamp with time zone,
    exhausted_until timestamp with time zone,
    allocator_enabled boolean DEFAULT true NOT NULL,
    selection_count integer DEFAULT 0 NOT NULL,
    last_selected_at timestamp with time zone,
    allocator_version integer DEFAULT 1 NOT NULL,
    allocator_updated_by_subject_id text,
    allocator_updated_at timestamp with time zone,
    reset_credit_available_count integer,
    reset_credits_checked_at timestamp with time zone,
    connected_by_subject_id text,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    owner_organization_membership_id uuid,
    organization_user_resource_authority_id uuid,
    organization_user_resource_kind text,
    organization_user_resource_authority_generation bigint,
    organization_id uuid,
    exhausted_kind text,
    exhausted_revision bigint DEFAULT 0 NOT NULL,
    allowed_model_ids text[],
    allowed_workspace_ids uuid[],
    allow_personal_workspaces boolean DEFAULT true NOT NULL,
    access_policy_version integer DEFAULT 1 NOT NULL,
    access_policy_updated_by text,
    access_policy_updated_at timestamp with time zone,
    plan_checked_at timestamp with time zone,
    plan_previous_type text,
    plan_changed_at timestamp with time zone,
    plan_entitlement_exclusion jsonb,
    extra_credits_enabled boolean DEFAULT false NOT NULL,
    extra_credits_version integer DEFAULT 1 NOT NULL,
    extra_credits_updated_by_subject_id text,
    extra_credits_updated_at timestamp with time zone,
    included_usage_unavailable_until timestamp with time zone,
    CONSTRAINT codex_credentials_authority_scope_chk CHECK ((authority_scope = ANY (ARRAY['workspace'::text, 'user'::text, 'organization'::text]))),
    CONSTRAINT codex_credentials_authority_shape_chk CHECK ((((authority_scope = 'workspace'::text) AND (workspace_id IS NOT NULL) AND (organization_id IS NULL) AND (owner_organization_membership_id IS NULL) AND (organization_user_resource_authority_id IS NULL) AND (organization_user_resource_kind IS NULL) AND (organization_user_resource_authority_generation IS NULL)) OR ((authority_scope = 'user'::text) AND (workspace_id IS NOT NULL) AND (organization_id IS NULL) AND (owner_organization_membership_id IS NOT NULL) AND (organization_user_resource_authority_id IS NOT NULL) AND (organization_user_resource_kind = 'codex_subscription'::text) AND (organization_user_resource_authority_generation IS NOT NULL) AND (organization_user_resource_authority_generation > 0)) OR ((authority_scope = 'organization'::text) AND (workspace_id IS NULL) AND (organization_id = account_id) AND (owner_organization_membership_id IS NULL) AND (organization_user_resource_authority_id IS NULL) AND (organization_user_resource_kind IS NULL) AND (organization_user_resource_authority_generation IS NULL)))),
    CONSTRAINT codex_credentials_exhausted_kind_chk CHECK ((((exhausted_until IS NULL) AND (exhausted_kind IS NULL)) OR ((exhausted_until IS NOT NULL) AND ((exhausted_kind IS NULL) OR (exhausted_kind = ANY (ARRAY['quota'::text, 'rate_limit'::text])))))),
    CONSTRAINT codex_credentials_plan_entitlement_exclusion_shape_chk CHECK (((plan_entitlement_exclusion IS NULL) OR
CASE
    WHEN ((jsonb_typeof(plan_entitlement_exclusion) = 'object'::text) AND (jsonb_typeof((plan_entitlement_exclusion -> 'planType'::text)) = 'string'::text) AND (jsonb_typeof((plan_entitlement_exclusion -> 'models'::text)) = 'array'::text)) THEN (((jsonb_array_length((plan_entitlement_exclusion -> 'models'::text)) >= 1) AND (jsonb_array_length((plan_entitlement_exclusion -> 'models'::text)) <= 64)) AND (pg_column_size(plan_entitlement_exclusion) <= 16384))
    ELSE false
END)),
    CONSTRAINT codex_credentials_plan_previous_type_len_chk CHECK (((plan_previous_type IS NULL) OR ((char_length(plan_previous_type) >= 1) AND (char_length(plan_previous_type) <= 128)))),
    CONSTRAINT codex_subscription_credentials_access_policy_shape CHECK (((access_policy_version > 0) AND (COALESCE(cardinality(allowed_model_ids), 0) <= 500) AND (COALESCE(cardinality(allowed_workspace_ids), 0) <= 500) AND (array_position(allowed_model_ids, NULL::text) IS NULL) AND (array_position(allowed_workspace_ids, NULL::uuid) IS NULL))),
    CONSTRAINT codex_subscription_credentials_allocator_version_check CHECK ((allocator_version > 0)),
    CONSTRAINT codex_subscription_credentials_human_owner_check CHECK (((connected_by_subject_id IS NULL) OR (connected_by_subject_id ~~ 'user:_%'::text))),
    CONSTRAINT codex_subscription_credentials_reset_count_check CHECK (((reset_credit_available_count IS NULL) OR (reset_credit_available_count >= 0)))
);

ALTER TABLE ONLY codex_subscription_credentials FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN codex_subscription_credentials.connected_by_subject_id IS 'Connection audit/redemption attribution only; never Codex credential ownership authority.';

COMMENT ON COLUMN codex_subscription_credentials.authority_scope IS 'Explicit workspace/user ownership fact. Existing and ordinary runtime-created rows remain workspace.';

COMMENT ON COLUMN codex_subscription_credentials.organization_id IS 'Organization owner for authority_scope=organization; workspace_id is null for these rows.';

CREATE TABLE codex_turn_source_bindings (
    turn_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT codex_turn_source_bindings_source_check CHECK ((source = ANY (ARRAY['workspace'::text, 'organization'::text, 'disabled'::text])))
);

ALTER TABLE ONLY codex_turn_source_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE company_brain_context_selection_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    created_by_attempt_id uuid NOT NULL,
    created_by_execution_generation integer NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    session_role text NOT NULL,
    memory_enabled boolean NOT NULL,
    memory_prompt_mode text NOT NULL,
    company_profile_included boolean NOT NULL,
    instruction_policy_entry_hash text NOT NULL,
    preference_descriptor_hash text,
    company_profile_snapshot_hash text NOT NULL,
    turn_context_snapshot_id uuid NOT NULL,
    turn_context_snapshot_hash text NOT NULL,
    turn_context_snapshot_source text NOT NULL,
    memory_selections jsonb NOT NULL,
    rendered_memory_selections jsonb NOT NULL,
    selection_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_brain_context_selection_generation_check CHECK ((created_by_execution_generation > 0)),
    CONSTRAINT company_brain_context_selection_hashes_check CHECK (((instruction_policy_entry_hash ~ '^[0-9a-f]{64}$'::text) AND ((preference_descriptor_hash IS NULL) OR (preference_descriptor_hash ~ '^[0-9a-f]{64}$'::text)) AND (company_profile_snapshot_hash ~ '^[0-9a-f]{64}$'::text) AND (turn_context_snapshot_hash ~ '^[0-9a-f]{64}$'::text) AND (selection_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT company_brain_context_selection_memory_check CHECK ((opengeni_private.company_brain_memory_selections_valid(memory_selections) AND opengeni_private.company_brain_memory_selections_valid(rendered_memory_selections) AND (memory_selections @> rendered_memory_selections) AND ((memory_enabled AND (memory_prompt_mode = 'legacy_standing'::text)) OR ((jsonb_array_length(memory_selections) = 0) AND (jsonb_array_length(rendered_memory_selections) = 0))))),
    CONSTRAINT company_brain_context_selection_mode_check CHECK ((memory_prompt_mode = ANY (ARRAY['legacy_standing'::text, 'retrieval_only'::text]))),
    CONSTRAINT company_brain_context_selection_profile_inclusion_check CHECK ((company_profile_included = ((memory_prompt_mode = 'legacy_standing'::text) OR (session_role = 'root'::text)))),
    CONSTRAINT company_brain_context_selection_role_check CHECK ((session_role = ANY (ARRAY['root'::text, 'child'::text]))),
    CONSTRAINT company_brain_context_selection_snapshot_source_check CHECK ((turn_context_snapshot_source = ANY (ARRAY['accepted_turn'::text, 'legacy_first_claim'::text])))
);

ALTER TABLE ONLY company_brain_context_selection_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE company_brain_preference_proposal_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    knowledge_proposal_id uuid NOT NULL,
    preference_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    creation_event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_brain_preference_proposal_receipts_attempt_chk CHECK (((execution_generation > 0) AND ((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)) AND ((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024)))),
    CONSTRAINT company_brain_preference_proposal_receipts_hash_chk CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY company_brain_preference_proposal_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE company_brain_turn_context_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    accepted_at timestamp with time zone NOT NULL,
    memory_enabled boolean NOT NULL,
    memory_prompt_mode text NOT NULL,
    legacy_workspace_instructions text,
    legacy_workspace_instructions_original_utf8_bytes integer,
    legacy_workspace_instructions_truncated boolean NOT NULL,
    snapshot_source text NOT NULL,
    snapshot_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_brain_turn_context_snapshot_hash_check CHECK ((snapshot_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_brain_turn_context_snapshot_instruction_bounds_check CHECK ((((legacy_workspace_instructions IS NULL) AND (legacy_workspace_instructions_original_utf8_bytes IS NULL) AND (NOT legacy_workspace_instructions_truncated)) OR ((legacy_workspace_instructions IS NOT NULL) AND (legacy_workspace_instructions_original_utf8_bytes IS NOT NULL) AND (legacy_workspace_instructions_original_utf8_bytes >= octet_length(convert_to(legacy_workspace_instructions, 'UTF8'::name))) AND (octet_length(convert_to(legacy_workspace_instructions, 'UTF8'::name)) <= 131072) AND (legacy_workspace_instructions_truncated = (legacy_workspace_instructions_original_utf8_bytes > octet_length(convert_to(legacy_workspace_instructions, 'UTF8'::name))))))),
    CONSTRAINT company_brain_turn_context_snapshot_mode_check CHECK ((memory_prompt_mode = ANY (ARRAY['legacy_standing'::text, 'retrieval_only'::text]))),
    CONSTRAINT company_brain_turn_context_snapshot_source_check CHECK ((snapshot_source = ANY (ARRAY['accepted_turn'::text, 'legacy_first_claim'::text])))
);

ALTER TABLE ONLY company_brain_turn_context_snapshots FORCE ROW LEVEL SECURITY;

CREATE TABLE company_profile_activation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    type text NOT NULL,
    activation_version bigint NOT NULL,
    old_revision_id uuid,
    old_revision bigint,
    old_content_hash text,
    new_revision_id uuid,
    new_revision bigint,
    new_content_hash text,
    actor_subject_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_profile_events_audit_chk CHECK (((activation_version > 0) AND ((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)) AND ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 4096)))),
    CONSTRAINT company_profile_events_new_revision_chk CHECK ((((new_revision_id IS NULL) AND (new_revision IS NULL) AND (new_content_hash IS NULL)) OR ((new_revision_id IS NOT NULL) AND (new_revision > 0) AND (new_content_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT company_profile_events_old_revision_chk CHECK ((((old_revision_id IS NULL) AND (old_revision IS NULL) AND (old_content_hash IS NULL)) OR ((old_revision_id IS NOT NULL) AND (old_revision > 0) AND (old_content_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT company_profile_events_receipt_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_profile_events_type_chk CHECK ((type = ANY (ARRAY['activate'::text, 'rollback'::text])))
);

ALTER TABLE ONLY company_profile_activation_events FORCE ROW LEVEL SECURITY;

CREATE TABLE company_profile_agent_automatic_activation_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    activation_attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    proposal_receipt_id uuid NOT NULL,
    proposal_revision_id uuid NOT NULL,
    initiating_human_subject_id text NOT NULL,
    initiating_membership_id uuid NOT NULL,
    policy_version bigint NOT NULL,
    activation_event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT company_profile_agent_automatic_activations_generation_check CHECK (((execution_generation > 0) AND (policy_version >= 0))),
    CONSTRAINT company_profile_agent_automatic_activations_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_profile_agent_automatic_activations_subject_check CHECK (((octet_length(btrim(initiating_human_subject_id)) >= 1) AND (octet_length(btrim(initiating_human_subject_id)) <= 1024)))
);

ALTER TABLE ONLY company_profile_agent_automatic_activation_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE company_profile_agent_automatic_activation_receipts IS 'Immutable exact-attempt receipts for company-profile proposals activated without per-change confirmation under a frozen organization-owner automatic policy.';

CREATE TABLE company_profile_agent_confirmation_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    confirmation_attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    proposal_receipt_id uuid NOT NULL,
    proposal_revision_id uuid NOT NULL,
    human_input_request_id uuid NOT NULL,
    approver_subject_id text NOT NULL,
    approver_membership_id uuid NOT NULL,
    activation_event_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT company_profile_agent_confirmations_generation_check CHECK ((execution_generation > 0)),
    CONSTRAINT company_profile_agent_confirmations_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_profile_agent_confirmations_subject_check CHECK (((octet_length(btrim(approver_subject_id)) >= 1) AND (octet_length(btrim(approver_subject_id)) <= 1024)))
);

ALTER TABLE ONLY company_profile_agent_confirmation_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE company_profile_agent_proposal_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    creation_attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    initiating_human_subject_id text NOT NULL,
    initiating_membership_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    expected_current_revision_id uuid,
    expected_activation_version bigint NOT NULL,
    reason text NOT NULL,
    human_input jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    policy_mode text DEFAULT 'suggest'::text NOT NULL,
    policy_version bigint DEFAULT 0 NOT NULL,
    CONSTRAINT company_profile_agent_proposals_generation_check CHECK (((execution_generation > 0) AND (expected_activation_version >= 0))),
    CONSTRAINT company_profile_agent_proposals_human_input_check CHECK (((jsonb_typeof(human_input) = 'object'::text) AND (jsonb_array_length((human_input -> 'questions'::text)) = 1) AND ((human_input ->> 'allowSkip'::text) = 'false'::text) AND (octet_length((human_input)::text) <= 49152))),
    CONSTRAINT company_profile_agent_proposals_input_hash_check CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_profile_agent_proposals_policy_mode_check CHECK ((policy_mode = ANY (ARRAY['suggest'::text, 'automatic'::text]))),
    CONSTRAINT company_profile_agent_proposals_policy_version_check CHECK ((policy_version >= 0)),
    CONSTRAINT company_profile_agent_proposals_reason_check CHECK ((((char_length(btrim(reason)) >= 1) AND (char_length(btrim(reason)) <= 4096)) AND (octet_length(convert_to(btrim(reason), 'UTF8'::name)) <= 16384))),
    CONSTRAINT company_profile_agent_proposals_subject_check CHECK (((octet_length(btrim(initiating_human_subject_id)) >= 1) AND (octet_length(btrim(initiating_human_subject_id)) <= 1024)))
);

ALTER TABLE ONLY company_profile_agent_proposal_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE company_profile_heads (
    account_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    revision bigint NOT NULL,
    content_hash text NOT NULL,
    activation_version bigint NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_profile_heads_identity_chk CHECK (((revision > 0) AND (activation_version > 0) AND (content_hash ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY company_profile_heads FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE company_profile_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE company_profile_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT nextval('company_profile_revision_seq'::regclass) NOT NULL,
    intent text NOT NULL,
    content_json text NOT NULL,
    content_hash text NOT NULL,
    provenance_source text NOT NULL,
    provenance_source_id text,
    supersedes_revision_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_profile_revisions_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT company_profile_revisions_content_chk CHECK ((((octet_length(convert_to(content_json, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(content_json, 'UTF8'::name)) <= 28672)) AND (content_hash ~ '^[0-9a-f]{64}$'::text) AND (content_hash = encode(sha256(convert_to(content_json, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT company_profile_revisions_intent_chk CHECK ((intent = ANY (ARRAY['active'::text, 'proposal'::text]))),
    CONSTRAINT company_profile_revisions_provenance_chk CHECK (((provenance_source = ANY (ARRAY['human'::text, 'agent_admin'::text, 'durable_learning'::text, 'migration'::text])) AND ((provenance_source_id IS NULL) OR ((length(provenance_source_id) >= 1) AND (length(provenance_source_id) <= 512))))),
    CONSTRAINT company_profile_revisions_receipt_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT company_profile_revisions_revision_chk CHECK ((revision > 0))
);

ALTER TABLE ONLY company_profile_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE composer_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    subject_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    resources jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text NOT NULL,
    reasoning_effort text NOT NULL,
    source_turn_id uuid,
    source_turn_version integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tools_provided boolean DEFAULT false NOT NULL,
    latency_mode text DEFAULT 'standard'::text NOT NULL,
    annotations jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT composer_drafts_annotations_check CHECK (((jsonb_typeof(annotations) = 'array'::text) AND (octet_length((annotations)::text) <= 1048576))),
    CONSTRAINT composer_drafts_latency_mode_check CHECK ((latency_mode = ANY (ARRAY['standard'::text, 'priority'::text, 'fast'::text]))),
    CONSTRAINT composer_drafts_revision_check CHECK ((revision >= 1)),
    CONSTRAINT composer_drafts_subject_check CHECK ((length(btrim(subject_id)) > 0))
);

ALTER TABLE ONLY composer_drafts FORCE ROW LEVEL SECURITY;

CREATE TABLE computer_session_associations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    computer_session_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    attempt_id uuid,
    relationship text NOT NULL,
    actor_subject_id text NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT computer_session_associations_relationship_check CHECK ((relationship = ANY (ARRAY['created'::text, 'using'::text, 'observing'::text, 'related'::text]))),
    CONSTRAINT computer_session_associations_values_check CHECK ((((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 1024)) AND ((attempt_id IS NULL) OR (turn_id IS NOT NULL))))
);

ALTER TABLE ONLY computer_session_associations FORCE ROW LEVEL SECURITY;

CREATE TABLE computer_sessions (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    lifecycle text DEFAULT 'starting'::text NOT NULL,
    placement_kind text NOT NULL,
    sandbox_group_id uuid,
    connected_sandbox_id uuid,
    device_id uuid,
    external_provider_id text,
    external_placement_id text,
    controller_id text,
    controller_generation text,
    placement_instance_id text,
    token_generation integer DEFAULT 1 NOT NULL,
    platform text,
    adapter text,
    seat_id text,
    display_id text,
    capabilities jsonb,
    create_operation_id uuid NOT NULL,
    created_by_subject_id text NOT NULL,
    failure_code text,
    controller_heartbeat_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    device_workspace_id uuid,
    CONSTRAINT computer_sessions_active_binding_check CHECK (((lifecycle <> 'active'::text) OR ((controller_id IS NOT NULL) AND (platform IS NOT NULL) AND (capabilities IS NOT NULL)))),
    CONSTRAINT computer_sessions_controller_check CHECK ((((controller_id IS NULL) AND (controller_generation IS NULL) AND (placement_instance_id IS NULL) AND (controller_heartbeat_at IS NULL)) OR ((controller_id IS NOT NULL) AND ((octet_length(controller_id) >= 1) AND (octet_length(controller_id) <= 512)) AND (controller_generation IS NOT NULL) AND ((octet_length(controller_generation) >= 1) AND (octet_length(controller_generation) <= 256)) AND (placement_instance_id IS NOT NULL) AND ((octet_length(placement_instance_id) >= 1) AND (octet_length(placement_instance_id) <= 512)) AND (controller_heartbeat_at IS NOT NULL)))),
    CONSTRAINT computer_sessions_device_workspace_check CHECK (((device_workspace_id IS NULL) OR (device_id IS NOT NULL))),
    CONSTRAINT computer_sessions_failure_check CHECK ((((lifecycle = ANY (ARRAY['repair_required'::text, 'lost'::text, 'failed'::text])) AND (failure_code IS NOT NULL)) OR ((lifecycle <> ALL (ARRAY['repair_required'::text, 'lost'::text, 'failed'::text])) AND (failure_code IS NULL)))),
    CONSTRAINT computer_sessions_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['starting'::text, 'active'::text, 'suspending'::text, 'suspended'::text, 'restoring'::text, 'repair_required'::text, 'lost'::text, 'ending'::text, 'ended'::text, 'failed'::text]))),
    CONSTRAINT computer_sessions_native_binding_check CHECK ((((platform IS NULL) AND (adapter IS NULL) AND (seat_id IS NULL) AND (display_id IS NULL) AND (capabilities IS NULL)) OR ((platform IS NOT NULL) AND (adapter IS NOT NULL) AND (seat_id IS NOT NULL) AND (display_id IS NOT NULL) AND (capabilities IS NOT NULL)))),
    CONSTRAINT computer_sessions_placement_check CHECK ((((placement_kind = 'sandbox_group'::text) AND (sandbox_group_id IS NOT NULL) AND (connected_sandbox_id IS NULL) AND (device_id IS NULL) AND (external_provider_id IS NULL) AND (external_placement_id IS NULL)) OR ((placement_kind = 'connected_machine'::text) AND (sandbox_group_id IS NULL) AND (connected_sandbox_id IS NOT NULL) AND (device_id IS NULL) AND (external_provider_id IS NULL) AND (external_placement_id IS NULL)) OR ((placement_kind = 'attached_device'::text) AND (sandbox_group_id IS NULL) AND (connected_sandbox_id IS NULL) AND (device_id IS NOT NULL) AND (external_provider_id IS NULL) AND (external_placement_id IS NULL)) OR ((placement_kind = 'external_provider'::text) AND (sandbox_group_id IS NULL) AND (connected_sandbox_id IS NULL) AND (device_id IS NULL) AND (external_provider_id IS NOT NULL) AND (external_placement_id IS NOT NULL) AND ((octet_length(external_provider_id) >= 1) AND (octet_length(external_provider_id) <= 512)) AND ((octet_length(external_placement_id) >= 1) AND (octet_length(external_placement_id) <= 512))))),
    CONSTRAINT computer_sessions_platform_check CHECK (((platform IS NULL) OR (platform = ANY (ARRAY['linux'::text, 'macos'::text, 'windows'::text])))),
    CONSTRAINT computer_sessions_values_check CHECK ((((octet_length(name) >= 1) AND (octet_length(name) <= 200)) AND (name = btrim(name)) AND ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)) AND (token_generation > 0) AND ((adapter IS NULL) OR ((octet_length(adapter) >= 1) AND (octet_length(adapter) <= 512))) AND ((seat_id IS NULL) OR ((octet_length(seat_id) >= 1) AND (octet_length(seat_id) <= 512))) AND ((display_id IS NULL) OR ((octet_length(display_id) >= 1) AND (octet_length(display_id) <= 512))) AND ((capabilities IS NULL) OR ((jsonb_typeof(capabilities) = 'object'::text) AND ((octet_length((capabilities)::text) >= 2) AND (octet_length((capabilities)::text) <= 65536)))) AND ((failure_code IS NULL) OR ((octet_length(failure_code) >= 1) AND (octet_length(failure_code) <= 512)))))
);

ALTER TABLE ONLY computer_sessions FORCE ROW LEVEL SECURITY;

CREATE TABLE connect_attempts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    idempotency_key_hash text NOT NULL,
    request_digest text NOT NULL,
    return_url text NOT NULL,
    projection jsonb NOT NULL,
    operation_id text,
    operation_digest text,
    receipts jsonb DEFAULT '{}'::jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    external_continuation jsonb,
    CONSTRAINT connect_attempts_check CHECK (((external_continuation IS NULL) OR ((jsonb_typeof(external_continuation) = 'object'::text) AND (octet_length((external_continuation)::text) <= 32768) AND ((external_continuation #>> '{actor,accountId}'::text[]) = (account_id)::text) AND ((external_continuation #>> '{actor,effectiveSubjectId}'::text[]) = subject_id)))),
    CONSTRAINT connect_attempts_idempotency_key_hash_check CHECK ((idempotency_key_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT connect_attempts_operation_digest_check CHECK ((operation_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT connect_attempts_operation_id_check CHECK (((octet_length(operation_id) >= 1) AND (octet_length(operation_id) <= 512))),
    CONSTRAINT connect_attempts_operation_pair_check CHECK (((operation_id IS NULL) = (operation_digest IS NULL))),
    CONSTRAINT connect_attempts_projection_check CHECK (((jsonb_typeof(projection) = 'object'::text) AND (octet_length((projection)::text) <= 1048576))),
    CONSTRAINT connect_attempts_projection_identity_check CHECK (((projection ?& ARRAY['id'::text, 'workspaceId'::text, 'revision'::text, 'state'::text, 'expiresAt'::text]) AND ((projection ->> 'id'::text) = (id)::text) AND ((projection ->> 'workspaceId'::text) = (workspace_id)::text) AND (((projection ->> 'revision'::text))::bigint > 0) AND (((projection ->> 'expiresAt'::text))::timestamp with time zone = expires_at))),
    CONSTRAINT connect_attempts_receipts_check CHECK (((jsonb_typeof(receipts) = 'object'::text) AND (octet_length((receipts)::text) <= 4194304))),
    CONSTRAINT connect_attempts_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT connect_attempts_return_url_check CHECK (((octet_length(return_url) >= 1) AND (octet_length(return_url) <= 4096))),
    CONSTRAINT connect_attempts_subject_id_check CHECK (((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024)))
);

ALTER TABLE ONLY connect_attempts FORCE ROW LEVEL SECURITY;

CREATE TABLE connection_authority_convergence_audit_capabilities (
    capability_id uuid NOT NULL,
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    account_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

COMMENT ON TABLE connection_authority_convergence_audit_capabilities IS 'Invocation-scoped, target-local read capability for connection convergence evidence.';

CREATE TABLE connection_disconnect_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    subject_id text NOT NULL,
    idempotency_key text NOT NULL,
    expected_version integer NOT NULL,
    result_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connection_disconnect_operations_identity_check CHECK ((((length(subject_id) >= 1) AND (length(subject_id) <= 512)) AND ((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200)) AND (idempotency_key = btrim(idempotency_key)) AND (expected_version > 0) AND (result_version = (expected_version + 1))))
);

ALTER TABLE ONLY connection_disconnect_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE connection_use_audit_facts (
    physical_request_id uuid NOT NULL,
    use_phase text NOT NULL,
    request_digest bytea NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    server_id text NOT NULL,
    connection_id uuid,
    connection_generation bigint,
    authority_scope text,
    owner_subject_id text,
    authority_id uuid,
    grant_id uuid,
    outcome text NOT NULL,
    denial_reason text,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    initiator_kind text,
    initiator_subject_id text,
    initiating_human_subject_id text,
    authority_epoch integer,
    authority_visibility text,
    authority_owner_organization_membership_id uuid,
    CONSTRAINT connection_use_audit_attribution_check CHECK ((((authority_visibility IS NULL) OR (authority_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text]))) AND ((authority_epoch IS NULL) OR (authority_epoch > 0)))),
    CONSTRAINT connection_use_audit_shape_check CHECK ((((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 256)) AND (octet_length(request_digest) = 32) AND (execution_generation > 0) AND (use_phase = ANY (ARRAY['credential_resolution'::text, 'provider_request'::text])) AND (outcome = ANY (ARRAY['authorized'::text, 'denied'::text])) AND (((outcome = 'authorized'::text) AND (denial_reason IS NULL) AND (connection_id IS NOT NULL) AND (connection_generation > 0) AND (authority_scope = ANY (ARRAY['workspace'::text, 'user'::text, 'legacy_user'::text]))) OR ((outcome = 'denied'::text) AND ((octet_length(denial_reason) >= 1) AND (octet_length(denial_reason) <= 128))))))
);

ALTER TABLE ONLY connection_use_audit_facts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE connection_use_audit_facts IS 'Idempotent metadata-only facts for physical connection requests; contains no token, header, provider payload, response, quota, or usage value.';

CREATE TABLE connection_use_once_consumption_receipts (
    grant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_generation bigint NOT NULL,
    accepted_work_kind text NOT NULL,
    accepted_work_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connection_once_receipts_generation_check CHECK (((authority_generation > 0) AND (grant_generation > 0))),
    CONSTRAINT connection_once_receipts_work_kind_check CHECK ((accepted_work_kind = ANY (ARRAY['turn'::text, 'scheduled_task'::text])))
);

ALTER TABLE ONLY connection_use_once_consumption_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE connection_use_once_consumption_receipts IS 'Exact accepted turn/task that consumed one connection.use grant; contains no credential, quota, provider response, or usage value.';

CREATE TABLE connector_action_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id text NOT NULL,
    server_id text NOT NULL,
    tool_name text NOT NULL,
    action_name text NOT NULL,
    policy text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by_subject_id text NOT NULL,
    updated_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT connector_action_policies_action_name_chk CHECK (((octet_length(btrim(action_name)) >= 1) AND (octet_length(btrim(action_name)) <= 512))),
    CONSTRAINT connector_action_policies_connection_id_chk CHECK (((octet_length(btrim(connection_id)) >= 1) AND (octet_length(btrim(connection_id)) <= 512))),
    CONSTRAINT connector_action_policies_creator_chk CHECK (((octet_length(btrim(created_by_subject_id)) >= 1) AND (octet_length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT connector_action_policies_policy_chk CHECK ((policy = ANY (ARRAY['allow'::text, 'ask'::text, 'block'::text]))),
    CONSTRAINT connector_action_policies_server_id_chk CHECK (((octet_length(btrim(server_id)) >= 1) AND (octet_length(btrim(server_id)) <= 256))),
    CONSTRAINT connector_action_policies_tool_name_chk CHECK (((octet_length(btrim(tool_name)) >= 1) AND (octet_length(btrim(tool_name)) <= 512))),
    CONSTRAINT connector_action_policies_updater_chk CHECK (((octet_length(btrim(updated_by_subject_id)) >= 1) AND (octet_length(btrim(updated_by_subject_id)) <= 1024))),
    CONSTRAINT connector_action_policies_version_chk CHECK ((version > 0))
);

ALTER TABLE ONLY connector_action_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE connector_action_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    creation_attempt_id uuid NOT NULL,
    creation_execution_generation integer NOT NULL,
    execution_attempt_id uuid,
    execution_attempt_generation integer,
    approval_id text NOT NULL,
    initiator_kind text NOT NULL,
    initiator_subject_id text NOT NULL,
    connection_id text NOT NULL,
    connection_version integer,
    server_id text NOT NULL,
    tool_name text NOT NULL,
    action_name text NOT NULL,
    policy_id uuid,
    policy_version integer,
    policy_source text NOT NULL,
    policy_decision text NOT NULL,
    action_fingerprint text NOT NULL,
    status text NOT NULL,
    decision text,
    decision_by_subject_id text,
    decision_event_id uuid,
    decided_at timestamp with time zone,
    execution_started_at timestamp with time zone,
    execution_finished_at timestamp with time zone,
    outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    review_arguments text,
    review_context jsonb,
    decision_by_kind text,
    decision_by_signed_in_person boolean DEFAULT false NOT NULL,
    CONSTRAINT connector_action_requests_action_name_chk CHECK (((octet_length(btrim(action_name)) >= 1) AND (octet_length(btrim(action_name)) <= 512))),
    CONSTRAINT connector_action_requests_approval_id_chk CHECK (((octet_length(btrim(approval_id)) >= 1) AND (octet_length(btrim(approval_id)) <= 1024))),
    CONSTRAINT connector_action_requests_connection_id_chk CHECK (((octet_length(btrim(connection_id)) >= 1) AND (octet_length(btrim(connection_id)) <= 512))),
    CONSTRAINT connector_action_requests_connection_version_chk CHECK (((connection_version IS NULL) OR (connection_version > 0))),
    CONSTRAINT connector_action_requests_creation_generation_chk CHECK ((creation_execution_generation > 0)),
    CONSTRAINT connector_action_requests_decision_chk CHECK (((decision IS NULL) OR (decision = ANY (ARRAY['approve'::text, 'reject'::text])))),
    CONSTRAINT connector_action_requests_decision_consistency_chk CHECK ((((decision IS NULL) AND (decision_by_subject_id IS NULL) AND (decision_event_id IS NULL) AND (decided_at IS NULL)) OR ((decision IS NOT NULL) AND (decision_by_subject_id IS NOT NULL) AND (decision_event_id IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT connector_action_requests_execution_attempt_chk CHECK ((((execution_attempt_id IS NULL) AND (execution_attempt_generation IS NULL)) OR ((execution_attempt_id IS NOT NULL) AND (execution_attempt_generation > 0)))),
    CONSTRAINT connector_action_requests_fingerprint_chk CHECK ((action_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT connector_action_requests_initiator_kind_chk CHECK ((initiator_kind = ANY (ARRAY['subject'::text, 'service'::text]))),
    CONSTRAINT connector_action_requests_initiator_subject_chk CHECK (((octet_length(btrim(initiator_subject_id)) >= 1) AND (octet_length(btrim(initiator_subject_id)) <= 1024))),
    CONSTRAINT connector_action_requests_policy_decision_chk CHECK ((policy_decision = ANY (ARRAY['allow'::text, 'ask'::text, 'block'::text]))),
    CONSTRAINT connector_action_requests_policy_source_chk CHECK ((policy_source = ANY (ARRAY['explicit'::text, 'default'::text, 'ambiguous'::text]))),
    CONSTRAINT connector_action_requests_policy_version_chk CHECK (((policy_version IS NULL) OR (policy_version > 0))),
    CONSTRAINT connector_action_requests_server_id_chk CHECK (((octet_length(btrim(server_id)) >= 1) AND (octet_length(btrim(server_id)) <= 256))),
    CONSTRAINT connector_action_requests_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'blocked'::text, 'executing'::text, 'completed'::text, 'failed'::text, 'uncertain'::text]))),
    CONSTRAINT connector_action_requests_tool_name_chk CHECK (((octet_length(btrim(tool_name)) >= 1) AND (octet_length(btrim(tool_name)) <= 512))),
    CONSTRAINT connector_review_arguments_bound CHECK (((review_arguments IS NULL) OR (octet_length(review_arguments) <= 4194304))),
    CONSTRAINT connector_review_context_bound CHECK (((review_context IS NULL) OR (octet_length((review_context)::text) <= 4194304)))
);

ALTER TABLE ONLY connector_action_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE credit_debit_allocations (
    account_id uuid NOT NULL,
    debit_entry_id uuid NOT NULL,
    grant_entry_id uuid NOT NULL,
    amount_micros bigint NOT NULL,
    CONSTRAINT credit_debit_allocations_positive CHECK ((amount_micros > 0))
);

ALTER TABLE ONLY credit_debit_allocations FORCE ROW LEVEL SECURITY;

CREATE TABLE credit_ledger_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    type text NOT NULL,
    amount_micros bigint NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    source_type text,
    source_id text,
    idempotency_key text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    eligible_model_ids text[],
    site_id uuid,
    CONSTRAINT credit_ledger_scope_valid CHECK (((eligible_model_ids IS NULL) OR ((((type = ANY (ARRAY['grant'::text, 'plan_credit_grant'::text])) AND (amount_micros > 0)) OR ((type = 'grant'::text) AND (amount_micros = 0) AND (NOT (source_type IS DISTINCT FROM 'verified_signup_trial'::text)) AND (source_id IS NOT NULL) AND (idempotency_key = ('verified-signup-trial:v1:'::text || source_id)))) AND ((cardinality(eligible_model_ids) >= 1) AND (cardinality(eligible_model_ids) <= 40)) AND (array_position(eligible_model_ids, NULL::text) IS NULL) AND (array_position(eligible_model_ids, ''::text) IS NULL))))
);

ALTER TABLE ONLY credit_ledger_entries FORCE ROW LEVEL SECURITY;

CREATE TABLE deployment_model_catalog (
    singleton boolean DEFAULT true NOT NULL,
    document jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT deployment_model_catalog_document_chk CHECK ((jsonb_typeof(document) = 'object'::text)),
    CONSTRAINT deployment_model_catalog_singleton_chk CHECK (singleton),
    CONSTRAINT deployment_model_catalog_version_chk CHECK ((version > 0))
);

COMMENT ON TABLE deployment_model_catalog IS 'Deployment-global, secret-free model catalog singleton. Runtime is SELECT-only; operators update it explicitly.';

CREATE TABLE device_enrollment_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_code text NOT NULL,
    user_code text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    pubkey text NOT NULL,
    os text DEFAULT 'linux'::text NOT NULL,
    arch text DEFAULT 'x86_64'::text NOT NULL,
    machine_name text,
    requested_exposure text DEFAULT 'whole-machine'::text NOT NULL,
    can_offer_display boolean DEFAULT false NOT NULL,
    requests_screen_control boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    approved_by_subject_id text,
    approved_by_subject_label text,
    allow_screen_control boolean DEFAULT false NOT NULL,
    approved_at timestamp with time zone,
    enrollment_id uuid,
    sandbox_id uuid,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT device_enrollment_requests_exposure_chk CHECK ((requested_exposure = 'whole-machine'::text)),
    CONSTRAINT device_enrollment_requests_os_chk CHECK ((os = ANY (ARRAY['linux'::text, 'macos'::text, 'windows'::text]))),
    CONSTRAINT device_enrollment_requests_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text, 'consumed'::text])))
);

ALTER TABLE ONLY device_enrollment_requests FORCE ROW LEVEL SECURITY;

CREATE TABLE document_authority_reclassifications (
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    account_id uuid NOT NULL,
    request_workspace_id uuid NOT NULL,
    document_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    previous_authority_kind text NOT NULL,
    previous_authority_workspace_id uuid,
    previous_authority_subject_id text,
    previous_authority_id uuid,
    previous_owner_organization_membership_id uuid,
    resulting_authority_kind text NOT NULL,
    resulting_authority_workspace_id uuid,
    resulting_authority_subject_id text,
    resulting_authority_id uuid,
    resulting_owner_organization_membership_id uuid,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_authority_reclassifications_actor_chk CHECK (((actor_subject_id = btrim(actor_subject_id)) AND ((octet_length(convert_to(actor_subject_id, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(actor_subject_id, 'UTF8'::name)) <= 1024)))),
    CONSTRAINT document_authority_reclassifications_hash_chk CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT document_authority_reclassifications_kind_chk CHECK (((previous_authority_kind = ANY (ARRAY['organization'::text, 'workspace'::text, 'personal'::text])) AND (resulting_authority_kind = ANY (ARRAY['organization'::text, 'workspace'::text, 'personal'::text])))),
    CONSTRAINT document_authority_reclassifications_result_chk CHECK ((jsonb_typeof(result) = 'object'::text))
);

ALTER TABLE ONLY document_authority_reclassifications FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE document_authority_reclassifications IS 'Immutable same-transaction before/after receipts for explicit Document authority changes.';

CREATE TABLE document_bases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);

ALTER TABLE ONLY document_bases FORCE ROW LEVEL SECURITY;

CREATE TABLE document_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    document_id uuid NOT NULL,
    base_id uuid NOT NULL,
    file_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    text text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    embedding vector(3072) NOT NULL,
    embedding_model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    authority_kind text DEFAULT 'workspace'::text NOT NULL,
    authority_workspace_id uuid,
    authority_subject_id text,
    authority_id uuid,
    owner_organization_membership_id uuid,
    CONSTRAINT document_chunks_authority_chk CHECK ((((authority_kind = 'organization'::text) AND (authority_workspace_id IS NULL) AND (authority_subject_id IS NULL) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_kind = 'workspace'::text) AND (authority_workspace_id = workspace_id) AND (authority_subject_id IS NULL) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_kind = 'personal'::text) AND (NULLIF(btrim(authority_subject_id), ''::text) IS NOT NULL) AND (octet_length(convert_to(authority_subject_id, 'UTF8'::name)) <= 1024) AND (((authority_workspace_id = workspace_id) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_workspace_id IS NULL) AND (authority_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL))))))
);

ALTER TABLE ONLY document_chunks FORCE ROW LEVEL SECURITY;

CREATE TABLE document_default_collection_backfill_operations (
    operation_id uuid NOT NULL,
    run_id uuid NOT NULL,
    account_id uuid NOT NULL,
    input_hash text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_default_collection_backfill_operations_hash_chk CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT document_default_collection_backfill_operations_result_chk CHECK ((jsonb_typeof(result) = 'object'::text))
);

ALTER TABLE ONLY document_default_collection_backfill_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE document_default_collection_backfill_receipts (
    run_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    base_id uuid NOT NULL,
    outcome text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_default_collection_backfill_receipts_outcome_chk CHECK ((outcome = ANY (ARRAY['created'::text, 'adopted'::text])))
);

ALTER TABLE ONLY document_default_collection_backfill_receipts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE document_default_collection_backfill_receipts IS 'Immutable per-workspace evidence for each Default collection backfill run.';

CREATE TABLE document_default_collection_backfill_runs (
    run_id uuid NOT NULL,
    account_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    last_workspace_id uuid,
    processed_count integer DEFAULT 0 NOT NULL,
    created_count integer DEFAULT 0 NOT NULL,
    adopted_count integer DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT document_default_collection_backfill_runs_actor_chk CHECK (((actor_subject_id = btrim(actor_subject_id)) AND ((octet_length(convert_to(actor_subject_id, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(actor_subject_id, 'UTF8'::name)) <= 1024)))),
    CONSTRAINT document_default_collection_backfill_runs_count_chk CHECK (((processed_count >= 0) AND (created_count >= 0) AND (adopted_count >= 0) AND (processed_count = (created_count + adopted_count)))),
    CONSTRAINT document_default_collection_backfill_runs_status_chk CHECK ((((status = 'running'::text) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL))))
);

ALTER TABLE ONLY document_default_collection_backfill_runs FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE document_default_collection_backfill_runs IS 'Resumable account-bounded creation/adoption progress for the internal Default collection.';

CREATE SEQUENCE document_index_completion_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE document_migration_audit_capabilities (
    capability_id uuid NOT NULL,
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_kind text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT document_migration_audit_capabilities_kind_chk CHECK ((capability_kind = ANY (ARRAY['default_backfill_audit'::text, 'reclassification_audit'::text])))
);

COMMENT ON TABLE document_migration_audit_capabilities IS 'Target-local exact-token capabilities for read-only Document migration audit projections.';

CREATE TABLE documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    base_id uuid NOT NULL,
    file_id uuid NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    title text NOT NULL,
    parser text DEFAULT 'liteparse'::text NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_kind text DEFAULT 'manual_upload'::text NOT NULL,
    source_uri text,
    source_external_id text,
    source_title text,
    source_author text,
    source_created_at timestamp with time zone,
    source_updated_at timestamp with time zone,
    source_version text,
    acl_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    visibility text DEFAULT 'workspace'::text NOT NULL,
    created_by text,
    agent_access boolean DEFAULT true NOT NULL,
    summary text,
    topics jsonb DEFAULT '[]'::jsonb NOT NULL,
    curation_status text DEFAULT 'none'::text NOT NULL,
    curation jsonb,
    authority_kind text DEFAULT 'workspace'::text NOT NULL,
    authority_workspace_id uuid,
    authority_subject_id text,
    knowledge_source_identity text,
    index_sequence bigint,
    indexed_at timestamp with time zone,
    authority_id uuid,
    owner_organization_membership_id uuid,
    origin_workspace_id uuid NOT NULL,
    billing_attribution jsonb DEFAULT '{"kind": "unknown"}'::jsonb NOT NULL,
    CONSTRAINT documents_authority_chk CHECK ((((authority_kind = 'organization'::text) AND (authority_workspace_id IS NULL) AND (authority_subject_id IS NULL) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_kind = 'workspace'::text) AND (authority_workspace_id = workspace_id) AND (authority_subject_id IS NULL) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_kind = 'personal'::text) AND (NULLIF(btrim(authority_subject_id), ''::text) IS NOT NULL) AND (octet_length(convert_to(authority_subject_id, 'UTF8'::name)) <= 1024) AND (authority_subject_id = created_by) AND (((authority_workspace_id = workspace_id) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_workspace_id IS NULL) AND (authority_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL)))))),
    CONSTRAINT documents_authority_visibility_chk CHECK (((authority_kind = 'personal'::text) = (visibility = 'private'::text))),
    CONSTRAINT documents_billing_attribution_check CHECK (((jsonb_typeof(billing_attribution) = 'object'::text) AND COALESCE(
CASE (billing_attribution ->> 'kind'::text)
    WHEN 'unknown'::text THEN (billing_attribution = '{"kind": "unknown"}'::jsonb)
    WHEN 'service'::text THEN (billing_attribution = '{"kind": "service"}'::jsonb)
    WHEN 'human'::text THEN ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))
    WHEN 'turn'::text THEN ((COALESCE((billing_attribution ->> 'turnId'::text), ''::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) AND (((billing_attribution -> 'initiatingHumanSubjectId'::text) = 'null'::jsonb) OR ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))))
    ELSE false
END, false))),
    CONSTRAINT documents_curation_object_chk CHECK (((curation IS NULL) OR (jsonb_typeof(curation) = 'object'::text))),
    CONSTRAINT documents_curation_status_chk CHECK ((curation_status = ANY (ARRAY['none'::text, 'pending'::text, 'suggested'::text, 'auto_filed'::text, 'failed'::text]))),
    CONSTRAINT documents_index_sequence_chk CHECK ((((index_sequence IS NULL) OR (index_sequence > 0)) AND ((status <> 'ready'::text) OR ((index_sequence IS NOT NULL) AND (indexed_at IS NOT NULL))))),
    CONSTRAINT documents_knowledge_source_identity_chk CHECK (((knowledge_source_identity IS NULL) OR ((length(btrim(knowledge_source_identity)) >= 1) AND (length(btrim(knowledge_source_identity)) <= 512)))),
    CONSTRAINT documents_origin_workspace_chk CHECK ((origin_workspace_id = workspace_id)),
    CONSTRAINT documents_private_creator_chk CHECK (((visibility <> 'private'::text) OR (NULLIF(btrim(created_by), ''::text) IS NOT NULL))),
    CONSTRAINT documents_topics_array_chk CHECK ((jsonb_typeof(topics) = 'array'::text)),
    CONSTRAINT documents_visibility_chk CHECK ((visibility = ANY (ARRAY['workspace'::text, 'private'::text])))
);

ALTER TABLE ONLY documents FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN documents.index_sequence IS 'Database-assigned order of the latest successful transition to ready; immutable until the next successful reindex.';

COMMENT ON COLUMN documents.indexed_at IS 'Database timestamp of the latest successful transition to ready.';

COMMENT ON COLUMN documents.authority_id IS 'Common organization-user resource authority for activated personal Documents; null on legacy anchored personal rows.';

COMMENT ON COLUMN documents.origin_workspace_id IS 'Upload provenance only. It never narrows activated organization-user document authority.';

CREATE TABLE editable_artifact_blob_refs (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    id text NOT NULL,
    kind text NOT NULL,
    object_reference text NOT NULL,
    byte_size bigint NOT NULL,
    content_hash text NOT NULL,
    mime_type text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_file_id uuid,
    CONSTRAINT editable_artifact_blob_refs_facts_chk CHECK ((((octet_length(object_reference) >= 1) AND (octet_length(object_reference) <= 1024)) AND (object_reference = btrim(object_reference)) AND ((byte_size >= 1) AND (byte_size <= '9007199254740991'::bigint)) AND (content_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND ((octet_length(mime_type) >= 1) AND (octet_length(mime_type) <= 256)) AND (mime_type = btrim(mime_type)))),
    CONSTRAINT editable_artifact_blob_refs_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND (kind = ANY (ARRAY['snapshot'::text, 'original_import'::text, 'media'::text, 'loss_envelope'::text, 'materialization'::text])))),
    CONSTRAINT editable_artifact_blob_refs_source_kind_chk CHECK (((kind = 'original_import'::text) = (source_file_id IS NOT NULL)))
);

ALTER TABLE ONLY editable_artifact_blob_refs FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_idempotency_receipts (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    id text NOT NULL,
    artifact_id text NOT NULL,
    operation_kind text NOT NULL,
    authority_key text NOT NULL,
    authority_key_digest bytea GENERATED ALWAYS AS (opengeni_private.editable_artifact_text_sha256(authority_key)) STORED,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    server_transaction_id text,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_idempotency_receipts_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND (artifact_id ~ '^[0-9a-f]{32}$'::text) AND (artifact_id !~ '^0+$'::text) AND (resource_id ~ '^[0-9a-f]{32}$'::text) AND (resource_id !~ '^0+$'::text) AND (request_hash ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT editable_artifact_idempotency_receipts_key_chk CHECK (((operation_kind = ANY (ARRAY['create'::text, 'import'::text, 'edit'::text, 'snapshot'::text, 'version'::text, 'materialize'::text])) AND ((octet_length(convert_to(authority_key, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(authority_key, 'UTF8'::name)) <= 8192)) AND ((octet_length(idempotency_key) >= 1) AND (octet_length(idempotency_key) <= 256)) AND (idempotency_key = btrim(idempotency_key)))),
    CONSTRAINT editable_artifact_idempotency_receipts_resource_chk CHECK (((resource_type = ANY (ARRAY['artifact'::text, 'transaction'::text, 'snapshot'::text, 'artifact_version'::text, 'materialization_job'::text])) AND (((operation_kind = 'create'::text) AND (resource_type = 'artifact'::text) AND (resource_id = artifact_id) AND (server_transaction_id IS NULL)) OR ((operation_kind = 'edit'::text) AND (resource_type = 'transaction'::text) AND (resource_id = server_transaction_id)) OR ((operation_kind = 'snapshot'::text) AND (resource_type = 'snapshot'::text) AND (server_transaction_id IS NULL)) OR ((operation_kind = 'version'::text) AND (resource_type = 'artifact_version'::text) AND (server_transaction_id IS NULL)) OR ((operation_kind = 'materialize'::text) AND (resource_type = 'materialization_job'::text) AND (server_transaction_id IS NULL)) OR ((operation_kind = 'import'::text) AND (resource_type = 'artifact'::text) AND (resource_id = artifact_id) AND (server_transaction_id IS NULL))))),
    CONSTRAINT editable_artifact_idempotency_receipts_result_chk CHECK (((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 65536)))
);

ALTER TABLE ONLY editable_artifact_idempotency_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_live_outbox (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    id text NOT NULL,
    transaction_id text,
    snapshot_id text,
    event_kind text NOT NULL,
    event jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_code text,
    published_at timestamp with time zone,
    dead_lettered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_live_outbox_event_chk CHECK (((event_kind = ANY (ARRAY['transaction_committed'::text, 'snapshot_published'::text])) AND (jsonb_typeof(event) = 'object'::text) AND (octet_length((event)::text) <= 65536) AND (jsonb_typeof((event -> 'kind'::text)) = 'string'::text) AND (jsonb_typeof((event -> 'schemaVersion'::text)) = 'number'::text) AND ((event ->> 'kind'::text) = event_kind) AND ((event ->> 'schemaVersion'::text) = '1'::text) AND opengeni_private.editable_artifact_object_has_exact_keys((event -> 'scope'::text), ARRAY['accountId'::text, 'workspaceId'::text]) AND ((event #>> '{scope,accountId}'::text[]) = (account_id)::text) AND ((event #>> '{scope,workspaceId}'::text[]) = (workspace_id)::text) AND (jsonb_typeof((event -> 'artifactId'::text)) = 'string'::text) AND ((event ->> 'artifactId'::text) = artifact_id) AND (jsonb_typeof((event -> 'modality'::text)) = 'string'::text) AND ((event ->> 'modality'::text) = ANY (ARRAY['spreadsheet'::text, 'document'::text, 'presentation'::text])) AND (((event_kind = 'transaction_committed'::text) AND (transaction_id IS NOT NULL) AND (snapshot_id IS NULL) AND ((((event ->> 'modality'::text) = 'spreadsheet'::text) AND opengeni_private.editable_artifact_object_has_exact_keys(event, ARRAY['artifactId'::text, 'committedAt'::text, 'kind'::text, 'modality'::text, 'operationProtocolVersion'::text, 'schemaVersion'::text, 'scope'::text, 'sequenceEnd'::text, 'sequenceStart'::text, 'serverTransactionId'::text, 'stateHash'::text]) AND (jsonb_typeof((event -> 'operationProtocolVersion'::text)) = 'number'::text) AND ((event ->> 'operationProtocolVersion'::text) ~ '^[1-9][0-9]{0,9}$'::text)) OR (((event ->> 'modality'::text) = ANY (ARRAY['document'::text, 'presentation'::text])) AND opengeni_private.editable_artifact_object_has_exact_keys(event, ARRAY['artifactId'::text, 'commitProtocolVersion'::text, 'committedAt'::text, 'kind'::text, 'modality'::text, 'schemaVersion'::text, 'scope'::text, 'sequenceEnd'::text, 'sequenceStart'::text, 'serverTransactionId'::text, 'stateHash'::text]) AND (jsonb_typeof((event -> 'commitProtocolVersion'::text)) = 'number'::text) AND ((event ->> 'commitProtocolVersion'::text) ~ '^[1-9][0-9]{0,9}$'::text))) AND (jsonb_typeof((event -> 'serverTransactionId'::text)) = 'string'::text) AND ((event ->> 'serverTransactionId'::text) = transaction_id)) OR ((event_kind = 'snapshot_published'::text) AND (transaction_id IS NULL) AND (snapshot_id IS NOT NULL) AND ((((event ->> 'modality'::text) = 'spreadsheet'::text) AND opengeni_private.editable_artifact_object_has_exact_keys(event, ARRAY['artifactId'::text, 'coveredHeadSequence'::text, 'kind'::text, 'modality'::text, 'operationProtocolVersion'::text, 'publishedAt'::text, 'schemaVersion'::text, 'scope'::text, 'snapshotId'::text, 'stateHash'::text]) AND (jsonb_typeof((event -> 'operationProtocolVersion'::text)) = 'number'::text) AND ((event ->> 'operationProtocolVersion'::text) ~ '^[1-9][0-9]{0,9}$'::text)) OR (((event ->> 'modality'::text) = ANY (ARRAY['document'::text, 'presentation'::text])) AND opengeni_private.editable_artifact_object_has_exact_keys(event, ARRAY['artifactId'::text, 'coveredHeadSequence'::text, 'kind'::text, 'modality'::text, 'publishedAt'::text, 'schemaVersion'::text, 'scope'::text, 'snapshotId'::text, 'stateHash'::text]))) AND (jsonb_typeof((event -> 'snapshotId'::text)) = 'string'::text) AND ((event ->> 'snapshotId'::text) = snapshot_id))) AND (jsonb_typeof((event -> 'stateHash'::text)) = 'string'::text) AND ((event ->> 'stateHash'::text) ~ '^sha256:[0-9a-f]{64}$'::text) AND (((event_kind = 'transaction_committed'::text) AND (jsonb_typeof((event -> 'sequenceStart'::text)) = 'number'::text) AND (jsonb_typeof((event -> 'sequenceEnd'::text)) = 'number'::text) AND ((event ->> 'sequenceStart'::text) ~ '^[1-9][0-9]{0,15}$'::text) AND ((event ->> 'sequenceEnd'::text) ~ '^[1-9][0-9]{0,15}$'::text) AND (jsonb_typeof((event -> 'committedAt'::text)) = 'string'::text) AND ((event ->> 'committedAt'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'::text)) OR ((event_kind = 'snapshot_published'::text) AND (jsonb_typeof((event -> 'coveredHeadSequence'::text)) = 'number'::text) AND ((event ->> 'coveredHeadSequence'::text) ~ '^(0|[1-9][0-9]{0,15})$'::text) AND (jsonb_typeof((event -> 'publishedAt'::text)) = 'string'::text) AND ((event ->> 'publishedAt'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'::text))))),
    CONSTRAINT editable_artifact_live_outbox_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text))),
    CONSTRAINT editable_artifact_live_outbox_state_chk CHECK (((state = ANY (ARRAY['pending'::text, 'publishing'::text, 'published'::text, 'dead_lettered'::text])) AND ((attempt_count >= 0) AND (attempt_count <= 1000000)) AND ((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND ((lease_owner IS NULL) OR ((octet_length(lease_owner) >= 1) AND (octet_length(lease_owner) <= 256))) AND ((last_error_code IS NULL) OR ((octet_length(last_error_code) >= 1) AND (octet_length(last_error_code) <= 256))) AND (((state = 'pending'::text) AND (lease_owner IS NULL) AND (published_at IS NULL) AND (dead_lettered_at IS NULL)) OR ((state = 'publishing'::text) AND (lease_owner IS NOT NULL) AND (published_at IS NULL) AND (dead_lettered_at IS NULL)) OR ((state = 'published'::text) AND (lease_owner IS NULL) AND (published_at IS NOT NULL) AND (dead_lettered_at IS NULL) AND (last_error_code IS NULL)) OR ((state = 'dead_lettered'::text) AND (lease_owner IS NULL) AND (published_at IS NULL) AND (dead_lettered_at IS NOT NULL) AND (last_error_code = ANY (ARRAY['invalid_hint'::text, 'oversized_hint'::text, 'attempts_exhausted'::text]))))))
);

ALTER TABLE ONLY editable_artifact_live_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_live_tickets (
    token_digest text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    modality text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    replica_id text NOT NULL,
    agent_session_id text,
    agent_turn_id text,
    agent_attempt_id text,
    agent_generation integer,
    service_name text,
    allow_edit boolean NOT NULL,
    protocol_version integer NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT editable_artifact_live_tickets_actor_chk CHECK ((((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 1024)) AND (actor_subject_id = btrim(actor_subject_id)) AND (((actor_kind = 'human'::text) AND (agent_session_id IS NULL) AND (agent_turn_id IS NULL) AND (agent_attempt_id IS NULL) AND (agent_generation IS NULL) AND (service_name IS NULL)) OR ((actor_kind = 'agent'::text) AND (agent_session_id IS NOT NULL) AND ((octet_length(agent_session_id) >= 1) AND (octet_length(agent_session_id) <= 1024)) AND (agent_session_id = btrim(agent_session_id)) AND (agent_turn_id IS NOT NULL) AND ((octet_length(agent_turn_id) >= 1) AND (octet_length(agent_turn_id) <= 1024)) AND (agent_turn_id = btrim(agent_turn_id)) AND (agent_attempt_id IS NOT NULL) AND ((octet_length(agent_attempt_id) >= 1) AND (octet_length(agent_attempt_id) <= 1024)) AND (agent_attempt_id = btrim(agent_attempt_id)) AND (agent_generation IS NOT NULL) AND ((agent_generation >= 0) AND (agent_generation <= 2147483647)) AND (service_name IS NULL)) OR ((actor_kind = 'service'::text) AND (agent_session_id IS NULL) AND (agent_turn_id IS NULL) AND (agent_attempt_id IS NULL) AND (agent_generation IS NULL) AND (service_name IS NOT NULL) AND ((octet_length(service_name) >= 1) AND (octet_length(service_name) <= 1024)) AND (service_name = btrim(service_name)))))),
    CONSTRAINT editable_artifact_live_tickets_digest_chk CHECK ((token_digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT editable_artifact_live_tickets_identity_chk CHECK (((artifact_id ~ '^[0-9a-f]{32}$'::text) AND (artifact_id !~ '^0+$'::text) AND (replica_id ~ '^[0-9a-f]{16}$'::text) AND (replica_id !~ '^0+$'::text))),
    CONSTRAINT editable_artifact_live_tickets_lifetime_chk CHECK ((((protocol_version >= 1) AND (protocol_version <= 2147483647)) AND (expires_at >= (issued_at + '00:00:01'::interval)) AND (expires_at <= (issued_at + '00:01:00'::interval)))),
    CONSTRAINT editable_artifact_live_tickets_modality_chk CHECK ((modality = ANY (ARRAY['spreadsheet'::text, 'presentation'::text, 'document'::text])))
);

ALTER TABLE ONLY editable_artifact_live_tickets FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_materialization_jobs (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    id text NOT NULL,
    version_id text,
    input_snapshot_id text NOT NULL,
    target_head_sequence bigint NOT NULL,
    state_hash text NOT NULL,
    format text NOT NULL,
    normalized_options text NOT NULL,
    options_hash text GENERATED ALWAYS AS (('sha256:'::text || encode(opengeni_private.editable_artifact_text_sha256(normalized_options), 'hex'::text))) STORED,
    codec_id text NOT NULL,
    codec_version text NOT NULL,
    kernel_version text NOT NULL,
    font_registry_hash text NOT NULL,
    policy_hash text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    settled_by_owner text,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT editable_artifact_materialization_jobs_cache_facts_chk CHECK ((((target_head_sequence >= 0) AND (target_head_sequence <= '9007199254740991'::bigint)) AND (state_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (format = ANY (ARRAY['xlsx'::text, 'pptx'::text, 'docx'::text, 'pdf'::text, 'png'::text, 'webp'::text])) AND (options_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (font_registry_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (policy_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND ((octet_length(convert_to(normalized_options, 'UTF8'::name)) >= 2) AND (octet_length(convert_to(normalized_options, 'UTF8'::name)) <= 262144)) AND (normalized_options = btrim(normalized_options)) AND (jsonb_typeof((normalized_options)::jsonb) = 'object'::text) AND ((octet_length(convert_to(codec_id, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(codec_id, 'UTF8'::name)) <= 128)) AND (codec_id = btrim(codec_id)) AND ((octet_length(codec_version) >= 1) AND (octet_length(codec_version) <= 128)) AND (codec_version = btrim(codec_version)) AND ((octet_length(kernel_version) >= 1) AND (octet_length(kernel_version) <= 512)) AND (kernel_version = btrim(kernel_version)))),
    CONSTRAINT editable_artifact_materialization_jobs_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND (input_snapshot_id ~ '^[0-9a-f]{32}$'::text) AND (input_snapshot_id !~ '^0+$'::text) AND ((version_id IS NULL) OR ((version_id ~ '^[0-9a-f]{32}$'::text) AND (version_id !~ '^0+$'::text))))),
    CONSTRAINT editable_artifact_materialization_jobs_state_chk CHECK (((state = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text])) AND ((attempt_count >= 0) AND (attempt_count <= 1000)) AND ((lease_owner IS NULL) = (lease_expires_at IS NULL)) AND ((lease_owner IS NULL) OR ((octet_length(lease_owner) >= 1) AND (octet_length(lease_owner) <= 256))) AND ((settled_by_owner IS NULL) OR ((octet_length(settled_by_owner) >= 1) AND (octet_length(settled_by_owner) <= 256))) AND ((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 256))) AND (((state = 'pending'::text) AND (attempt_count = 0) AND (lease_owner IS NULL) AND (settled_by_owner IS NULL) AND (started_at IS NULL) AND (completed_at IS NULL)) OR ((state = 'running'::text) AND (attempt_count > 0) AND (lease_owner IS NOT NULL) AND (started_at IS NOT NULL) AND (lease_expires_at > started_at) AND (settled_by_owner IS NULL) AND (completed_at IS NULL)) OR ((state = ANY (ARRAY['succeeded'::text, 'failed'::text])) AND (attempt_count > 0) AND (started_at IS NOT NULL) AND (completed_at IS NOT NULL) AND (completed_at >= started_at) AND (settled_by_owner IS NOT NULL) AND (lease_owner IS NULL) AND (lease_expires_at IS NULL))) AND (((state = 'failed'::text) AND (error_code IS NOT NULL)) OR ((state <> 'failed'::text) AND (error_code IS NULL)))))
);

ALTER TABLE ONLY editable_artifact_materialization_jobs FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_materialization_results (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    id text NOT NULL,
    job_id text NOT NULL,
    blob_ref_id text NOT NULL,
    byte_size bigint NOT NULL,
    content_hash text NOT NULL,
    mime_type text NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_materialization_results_facts_chk CHECK ((((byte_size >= 1) AND (byte_size <= '9007199254740991'::bigint)) AND (content_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND ((octet_length(mime_type) >= 1) AND (octet_length(mime_type) <= 256)) AND (mime_type = btrim(mime_type)) AND (verified_at <= created_at))),
    CONSTRAINT editable_artifact_materialization_results_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND (job_id ~ '^[0-9a-f]{32}$'::text) AND (job_id !~ '^0+$'::text) AND (blob_ref_id ~ '^[0-9a-f]{32}$'::text) AND (blob_ref_id !~ '^0+$'::text)))
);

ALTER TABLE ONLY editable_artifact_materialization_results FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_operations (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    transaction_id text NOT NULL,
    operation_id text NOT NULL,
    operation_index integer NOT NULL,
    sequence bigint NOT NULL,
    dot_replica_id text NOT NULL,
    dot_counter bigint NOT NULL,
    actor_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_operations_dot_chk CHECK (((dot_replica_id ~ '^[0-9a-f]{16}$'::text) AND (dot_replica_id !~ '^0+$'::text) AND ((dot_counter >= 1) AND (dot_counter <= '9007199254740991'::bigint)) AND ((octet_length(convert_to(actor_key, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(actor_key, 'UTF8'::name)) <= 8192)))),
    CONSTRAINT editable_artifact_operations_ids_chk CHECK (((transaction_id ~ '^[0-9a-f]{32}$'::text) AND (transaction_id !~ '^0+$'::text) AND (operation_id ~ '^[0-9a-f]{32}$'::text) AND (operation_id !~ '^0+$'::text))),
    CONSTRAINT editable_artifact_operations_position_chk CHECK ((((operation_index >= 0) AND (operation_index <= 4095)) AND ((sequence >= 1) AND (sequence <= '9007199254740991'::bigint))))
);

ALTER TABLE ONLY editable_artifact_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_replica_leases (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    modality text NOT NULL,
    replica_id text NOT NULL,
    actor_key text NOT NULL,
    applied_head_sequence bigint NOT NULL,
    causal_frontier jsonb,
    native_revision bigint,
    lease_expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_replica_leases_cursor_chk CHECK ((((applied_head_sequence >= 0) AND (applied_head_sequence <= '9007199254740991'::bigint)) AND (last_seen_at >= created_at) AND (lease_expires_at > last_seen_at) AND ((revoked_at IS NULL) OR (revoked_at >= created_at)))),
    CONSTRAINT editable_artifact_replica_leases_replica_chk CHECK (((replica_id ~ '^[0-9a-f]{16}$'::text) AND (replica_id !~ '^0+$'::text) AND ((octet_length(convert_to(actor_key, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(actor_key, 'UTF8'::name)) <= 8192)) AND (((modality = 'spreadsheet'::text) AND opengeni_private.editable_artifact_frontier_valid(causal_frontier) AND (native_revision IS NULL)) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (causal_frontier IS NULL) AND ((native_revision >= 0) AND (native_revision <= '9007199254740991'::bigint))))))
);

ALTER TABLE ONLY editable_artifact_replica_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_scope_authorization_heads (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    create_revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_scope_authorization_heads_revision_chk CHECK (((create_revision >= 1) AND (create_revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY editable_artifact_scope_authorization_heads FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_sequence_checkpoints (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    modality text NOT NULL,
    head_sequence bigint NOT NULL,
    transaction_id text,
    causal_frontier jsonb,
    native_revision bigint,
    state_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_sequence_checkpoints_shape_chk CHECK ((((head_sequence >= 0) AND (head_sequence <= '9007199254740991'::bigint)) AND (((head_sequence = 0) AND (transaction_id IS NULL)) OR ((head_sequence > 0) AND (transaction_id IS NOT NULL))) AND (((modality = 'spreadsheet'::text) AND opengeni_private.editable_artifact_frontier_valid(causal_frontier) AND (native_revision IS NULL)) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (causal_frontier IS NULL) AND ((native_revision >= 0) AND (native_revision <= '9007199254740991'::bigint)))) AND (state_hash ~ '^sha256:[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY editable_artifact_sequence_checkpoints FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_session_links (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    artifact_id text NOT NULL,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_session_links_artifact_id_chk CHECK (((artifact_id ~ '^[0-9a-f]{32}$'::text) AND (artifact_id !~ '^0+$'::text))),
    CONSTRAINT editable_artifact_session_links_time_chk CHECK ((last_used_at >= first_used_at))
);

ALTER TABLE ONLY editable_artifact_session_links FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_snapshots (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    modality text NOT NULL,
    id text NOT NULL,
    blob_ref_id text NOT NULL,
    byte_size bigint NOT NULL,
    content_hash text NOT NULL,
    mime_type text DEFAULT 'application/vnd.opengeni.editable-artifact-snapshot'::text NOT NULL,
    covered_head_sequence bigint NOT NULL,
    covered_causal_frontier jsonb,
    state_hash text NOT NULL,
    model_schema_version integer NOT NULL,
    operation_protocol_version integer,
    kernel_version text NOT NULL,
    crdt_state_version integer,
    native_revision bigint,
    verified_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_snapshots_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND (blob_ref_id ~ '^[0-9a-f]{32}$'::text) AND (blob_ref_id !~ '^0+$'::text)))
);

ALTER TABLE ONLY editable_artifact_snapshots FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_transactions (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    modality text NOT NULL,
    id text NOT NULL,
    client_transaction_id text NOT NULL,
    previous_local_transaction_id text,
    request_hash text NOT NULL,
    intent_hash text NOT NULL,
    intent_envelope_version integer NOT NULL,
    intent_protocol_version integer NOT NULL,
    command_protocol_version integer NOT NULL,
    intent_byte_size integer NOT NULL,
    intent_bytes bytea NOT NULL,
    parent_head_sequence bigint NOT NULL,
    sequence_start bigint NOT NULL,
    sequence_end bigint NOT NULL,
    prior_state_hash text NOT NULL,
    causal_base jsonb,
    resolved_causal_base jsonb,
    resulting_causal_frontier jsonb,
    selective_undo_targets jsonb,
    state_hash text NOT NULL,
    operation_count integer,
    operation_ids jsonb,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    actor_key text NOT NULL,
    actor_key_digest bytea GENERATED ALWAYS AS (opengeni_private.editable_artifact_text_sha256(actor_key)) STORED,
    replica_id text NOT NULL,
    replica_counter bigint NOT NULL,
    agent_session_id text,
    agent_turn_id text,
    agent_attempt_id text,
    agent_generation integer,
    service_name text,
    kernel_version text NOT NULL,
    model_schema_version integer NOT NULL,
    operation_protocol_version integer,
    commit_protocol_version integer,
    prior_native_revision bigint,
    native_revision bigint,
    command_count integer,
    native_receipt_byte_size integer,
    native_receipt_hash text,
    native_receipt_bytes bytea,
    committed_transaction_byte_size integer NOT NULL,
    committed_transaction_hash text NOT NULL,
    committed_transaction_bytes bytea NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_transactions_actor_chk CHECK ((opengeni_private.editable_artifact_identity_valid(actor_subject_id) AND (((actor_kind = 'human'::text) AND (agent_session_id IS NULL) AND (agent_turn_id IS NULL) AND (agent_attempt_id IS NULL) AND (agent_generation IS NULL) AND (service_name IS NULL)) OR ((actor_kind = 'agent'::text) AND (agent_session_id IS NOT NULL) AND (agent_turn_id IS NOT NULL) AND (agent_attempt_id IS NOT NULL) AND (agent_generation IS NOT NULL) AND opengeni_private.editable_artifact_identity_valid(agent_session_id) AND opengeni_private.editable_artifact_identity_valid(agent_turn_id) AND opengeni_private.editable_artifact_identity_valid(agent_attempt_id) AND ((agent_generation >= 0) AND (agent_generation <= 2147483647)) AND (service_name IS NULL)) OR ((actor_kind = 'service'::text) AND (agent_session_id IS NULL) AND (agent_turn_id IS NULL) AND (agent_attempt_id IS NULL) AND (agent_generation IS NULL) AND (service_name IS NOT NULL) AND opengeni_private.editable_artifact_identity_valid(service_name))) AND (opengeni_private.editable_artifact_actor_key_matches(actor_key, actor_kind, actor_subject_id, agent_session_id, agent_turn_id, agent_attempt_id, agent_generation, service_name) IS TRUE))),
    CONSTRAINT editable_artifact_transactions_client_id_chk CHECK ((((octet_length(client_transaction_id) >= 1) AND (octet_length(client_transaction_id) <= 200)) AND (client_transaction_id ~ '^[A-Za-z0-9._:-]+$'::text) AND ((previous_local_transaction_id IS NULL) OR (((octet_length(previous_local_transaction_id) >= 1) AND (octet_length(previous_local_transaction_id) <= 200)) AND (previous_local_transaction_id ~ '^[A-Za-z0-9._:-]+$'::text) AND (previous_local_transaction_id <> client_transaction_id))))),
    CONSTRAINT editable_artifact_transactions_id_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text))),
    CONSTRAINT editable_artifact_transactions_intent_chk CHECK (((request_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND (intent_hash = request_hash) AND (intent_hash = ('sha256:'::text || encode(sha256(intent_bytes), 'hex'::text))) AND (intent_envelope_version = 1) AND (intent_protocol_version = 1) AND (command_protocol_version > 0) AND ((intent_byte_size >= 8) AND (intent_byte_size <= 5242880)) AND (octet_length(intent_bytes) = intent_byte_size) AND (SUBSTRING(intent_bytes FROM 1 FOR 8) = convert_to('OGATX001'::text, 'UTF8'::name)))),
    CONSTRAINT editable_artifact_transactions_modality_chk CHECK ((modality = ANY (ARRAY['spreadsheet'::text, 'presentation'::text, 'document'::text]))),
    CONSTRAINT editable_artifact_transactions_replica_chk CHECK (((replica_id ~ '^[0-9a-f]{16}$'::text) AND (replica_id !~ '^0+$'::text) AND ((replica_counter >= 1) AND (replica_counter <= '9007199254740991'::bigint)) AND (((replica_counter = 1) AND (previous_local_transaction_id IS NULL)) OR ((replica_counter > 1) AND (previous_local_transaction_id IS NOT NULL))))),
    CONSTRAINT editable_artifact_transactions_sequence_chk CHECK ((((parent_head_sequence >= 0) AND (parent_head_sequence <= '9007199254740991'::bigint)) AND (sequence_start = (parent_head_sequence + 1)) AND (sequence_end <= '9007199254740991'::bigint) AND (((modality = 'spreadsheet'::text) AND ((operation_count >= 1) AND (operation_count <= 4096)) AND (sequence_end = (parent_head_sequence + operation_count))) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (operation_count IS NULL) AND (sequence_end = sequence_start)))))
);

ALTER TABLE ONLY editable_artifact_transactions FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_undo_claims (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    target_operation_id text NOT NULL,
    claiming_transaction_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifact_undo_claims_ids_chk CHECK (((target_operation_id ~ '^[0-9a-f]{32}$'::text) AND (target_operation_id !~ '^0+$'::text) AND (claiming_transaction_id ~ '^[0-9a-f]{32}$'::text) AND (claiming_transaction_id !~ '^0+$'::text)))
);

ALTER TABLE ONLY editable_artifact_undo_claims FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifact_versions (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id text NOT NULL,
    id text NOT NULL,
    snapshot_id text,
    head_sequence bigint NOT NULL,
    causal_frontier jsonb,
    state_hash text NOT NULL,
    name text NOT NULL,
    pinned boolean DEFAULT true NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    native_revision bigint,
    CONSTRAINT editable_artifact_versions_facts_chk CHECK ((((head_sequence >= 0) AND (head_sequence <= '9007199254740991'::bigint)) AND (state_hash ~ '^sha256:[0-9a-f]{64}$'::text) AND ((octet_length(convert_to(name, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(name, 'UTF8'::name)) <= 256)) AND (name = btrim(name)) AND opengeni_private.editable_artifact_identity_valid(created_by_subject_id) AND ((opengeni_private.editable_artifact_frontier_valid(causal_frontier) AND (native_revision IS NULL)) OR ((causal_frontier IS NULL) AND ((native_revision >= 0) AND (native_revision <= '9007199254740991'::bigint)))))),
    CONSTRAINT editable_artifact_versions_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text) AND ((snapshot_id IS NULL) OR ((snapshot_id ~ '^[0-9a-f]{32}$'::text) AND (snapshot_id !~ '^0+$'::text)))))
);

ALTER TABLE ONLY editable_artifact_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE editable_artifacts (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    id text NOT NULL,
    modality text NOT NULL,
    title text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    authorization_revision bigint NOT NULL,
    head_sequence bigint DEFAULT 0 NOT NULL,
    causal_frontier jsonb,
    state_hash text NOT NULL,
    current_snapshot_id text,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT editable_artifacts_actor_chk CHECK (opengeni_private.editable_artifact_identity_valid(created_by_subject_id)),
    CONSTRAINT editable_artifacts_authorization_revision_chk CHECK (((authorization_revision >= 1) AND (authorization_revision <= '9007199254740991'::bigint))),
    CONSTRAINT editable_artifacts_frontier_chk CHECK ((((modality = 'spreadsheet'::text) AND opengeni_private.editable_artifact_frontier_valid(causal_frontier)) OR ((modality = ANY (ARRAY['document'::text, 'presentation'::text])) AND (causal_frontier IS NULL)))),
    CONSTRAINT editable_artifacts_hash_chk CHECK ((state_hash ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT editable_artifacts_head_chk CHECK (((head_sequence >= 0) AND (head_sequence <= '9007199254740991'::bigint))),
    CONSTRAINT editable_artifacts_identity_chk CHECK (((id ~ '^[0-9a-f]{32}$'::text) AND (id !~ '^0+$'::text))),
    CONSTRAINT editable_artifacts_lifecycle_chk CHECK ((lifecycle_state = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT editable_artifacts_modality_chk CHECK ((modality = ANY (ARRAY['spreadsheet'::text, 'presentation'::text, 'document'::text]))),
    CONSTRAINT editable_artifacts_snapshot_id_chk CHECK (((current_snapshot_id IS NULL) OR ((current_snapshot_id ~ '^[0-9a-f]{32}$'::text) AND (current_snapshot_id !~ '^0+$'::text)))),
    CONSTRAINT editable_artifacts_title_chk CHECK ((((octet_length(convert_to(title, 'UTF8'::name)) >= 1) AND (octet_length(convert_to(title, 'UTF8'::name)) <= 512)) AND (title = btrim(title))))
);

ALTER TABLE ONLY editable_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE enrollment_token_redemptions (
    token_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    pubkey text NOT NULL,
    enrollment_id uuid,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT enrollment_token_redemptions_token_id_check CHECK ((token_id ~ '^[A-Za-z0-9_-]{16,128}$'::text))
);

ALTER TABLE ONLY enrollment_token_redemptions FORCE ROW LEVEL SECURITY;

CREATE TABLE enrollments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    pubkey text,
    exposure text DEFAULT 'whole-machine'::text NOT NULL,
    has_display boolean DEFAULT false NOT NULL,
    allow_screen_control boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    os text DEFAULT 'linux'::text NOT NULL,
    arch text DEFAULT 'x86_64'::text NOT NULL,
    last_seen_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    desktop_unavailable_reason text,
    went_offline_at timestamp with time zone,
    went_offline_reason text,
    op_stream boolean DEFAULT false NOT NULL,
    credential_generation integer DEFAULT 1 NOT NULL,
    connection_instance_id text,
    connection_generation integer DEFAULT 0 NOT NULL,
    connection_lease_expires_at timestamp with time zone,
    connection_duplicate_denied_count integer DEFAULT 0 NOT NULL,
    connection_duplicate_denied_at timestamp with time zone,
    agent_version text,
    agent_binary_sha256 text,
    agent_update_channel text,
    agent_capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    agent_update_operation_id uuid,
    agent_update_status text,
    agent_update_target_version text,
    agent_update_expected_binary_sha256 text,
    agent_update_error_code text,
    agent_update_retryable boolean DEFAULT false NOT NULL,
    agent_update_rolled_back boolean DEFAULT false NOT NULL,
    agent_update_connection_instance_id text,
    agent_update_connection_generation integer,
    agent_update_requested_at timestamp with time zone,
    agent_update_updated_at timestamp with time zone,
    agent_update_completed_at timestamp with time zone,
    operation_memory_max_bytes bigint,
    operation_memory_high_bytes bigint,
    operation_cpu_max_millicores bigint,
    operation_policy_revision integer DEFAULT 0 NOT NULL,
    operation_policy_updated_at timestamp with time zone,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    authority_id uuid,
    owner_organization_membership_id uuid,
    origin_workspace_id uuid,
    generation bigint DEFAULT 1 NOT NULL,
    workspace_root text,
    kind text DEFAULT 'machine'::text NOT NULL,
    sandbox_group_id uuid,
    link_epoch bigint,
    agent_update_blockers jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT enrollments_agent_binary_sha256_chk CHECK (((agent_binary_sha256 IS NULL) OR (agent_binary_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT enrollments_agent_update_channel_chk CHECK (((agent_update_channel IS NULL) OR (agent_update_channel = ANY (ARRAY['stable'::text, 'beta'::text])))),
    CONSTRAINT enrollments_agent_update_expected_binary_sha256_chk CHECK (((agent_update_expected_binary_sha256 IS NULL) OR (agent_update_expected_binary_sha256 ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT enrollments_agent_update_state_shape_chk CHECK ((((agent_update_operation_id IS NULL) AND (agent_update_status IS NULL) AND (agent_update_target_version IS NULL) AND (agent_update_connection_instance_id IS NULL) AND (agent_update_connection_generation IS NULL) AND (agent_update_requested_at IS NULL) AND (agent_update_updated_at IS NULL)) OR ((agent_update_operation_id IS NOT NULL) AND (agent_update_status = ANY (ARRAY['requested'::text, 'accepted'::text, 'waiting_for_idle'::text, 'downloading'::text, 'verifying'::text, 'applying'::text, 'restarting'::text, 'succeeded'::text, 'failed'::text])) AND (agent_update_target_version IS NOT NULL) AND (agent_update_connection_instance_id IS NOT NULL) AND (agent_update_connection_generation IS NOT NULL) AND (agent_update_connection_generation >= 0) AND (agent_update_requested_at IS NOT NULL) AND (agent_update_updated_at IS NOT NULL)))),
    CONSTRAINT enrollments_authority_scope_check CHECK ((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text, 'user'::text]))),
    CONSTRAINT enrollments_authority_shape_check CHECK ((((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text])) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (authority_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL)))),
    CONSTRAINT enrollments_connection_authority_shape_chk CHECK ((((connection_instance_id IS NULL) AND (connection_lease_expires_at IS NULL)) OR ((connection_instance_id IS NOT NULL) AND ((length(connection_instance_id) >= 1) AND (length(connection_instance_id) <= 128)) AND (connection_lease_expires_at IS NOT NULL)))),
    CONSTRAINT enrollments_connection_duplicate_denied_count_chk CHECK ((connection_duplicate_denied_count >= 0)),
    CONSTRAINT enrollments_connection_generation_chk CHECK ((connection_generation >= 0)),
    CONSTRAINT enrollments_exposure_check CHECK ((exposure = 'whole-machine'::text)),
    CONSTRAINT enrollments_generation_check CHECK ((generation > 0)),
    CONSTRAINT enrollments_kind_check CHECK ((kind = ANY (ARRAY['machine'::text, 'sandbox'::text]))),
    CONSTRAINT enrollments_operation_cpu_shape_chk CHECK (((operation_cpu_max_millicores IS NULL) OR ((operation_cpu_max_millicores >= 1) AND (operation_cpu_max_millicores <= '4294967295'::bigint)))),
    CONSTRAINT enrollments_operation_memory_high_shape_chk CHECK (((operation_memory_high_bytes IS NULL) OR ((operation_memory_high_bytes > 0) AND (operation_memory_high_bytes <= '9007199254740991'::bigint)))),
    CONSTRAINT enrollments_operation_memory_max_shape_chk CHECK (((operation_memory_max_bytes IS NULL) OR ((operation_memory_max_bytes > 0) AND (operation_memory_max_bytes <= '9007199254740991'::bigint)))),
    CONSTRAINT enrollments_operation_memory_order_chk CHECK (((operation_memory_max_bytes IS NULL) OR (operation_memory_high_bytes IS NULL) OR (operation_memory_high_bytes <= operation_memory_max_bytes))),
    CONSTRAINT enrollments_operation_policy_revision_chk CHECK ((operation_policy_revision >= 0)),
    CONSTRAINT enrollments_os_check CHECK ((os = ANY (ARRAY['linux'::text, 'macos'::text, 'windows'::text]))),
    CONSTRAINT enrollments_sandbox_binding_check CHECK ((((kind = 'machine'::text) AND (sandbox_group_id IS NULL) AND (pubkey IS NOT NULL) AND (link_epoch IS NULL)) OR ((kind = 'sandbox'::text) AND (sandbox_group_id IS NOT NULL) AND (pubkey IS NULL) AND (authority_scope = 'workspace'::text)))),
    CONSTRAINT enrollments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT enrollments_workspace_root_shape CHECK (((workspace_root IS NULL) OR ((length(workspace_root) >= 1) AND (length(workspace_root) <= 4096))))
);

ALTER TABLE ONLY enrollments FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN enrollments.authority_scope IS 'Connected Machine owner scope; human approval defaults to organization+user.';

CREATE TABLE event_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    status text NOT NULL,
    reason text,
    dedupe_key text NOT NULL,
    body bytea,
    body_bytes integer NOT NULL,
    body_sha256 text NOT NULL,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL,
    event_count integer DEFAULT 0 NOT NULL,
    duplicate_count integer DEFAULT 0 NOT NULL,
    last_duplicate_at timestamp with time zone,
    replay_of_delivery_id uuid,
    stream_key text DEFAULT ''::text NOT NULL,
    CONSTRAINT event_deliveries_body_bytes_check CHECK ((body_bytes >= 0)),
    CONSTRAINT event_deliveries_body_chk CHECK (((body IS NULL) OR (octet_length(body) = body_bytes))),
    CONSTRAINT event_deliveries_body_sha256_check CHECK ((body_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT event_deliveries_dedupe_key_check CHECK (((octet_length(dedupe_key) >= 1) AND (octet_length(dedupe_key) <= 512))),
    CONSTRAINT event_deliveries_duplicate_count_check CHECK ((duplicate_count >= 0)),
    CONSTRAINT event_deliveries_event_count_check CHECK ((event_count >= 0)),
    CONSTRAINT event_deliveries_headers_check CHECK (((jsonb_typeof(headers) = 'object'::text) AND (octet_length((headers)::text) <= 8192))),
    CONSTRAINT event_deliveries_reason_check CHECK (((reason IS NULL) OR ((char_length(reason) >= 1) AND (char_length(reason) <= 500)))),
    CONSTRAINT event_deliveries_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'ignored'::text, 'rejected'::text, 'failed'::text]))),
    CONSTRAINT event_deliveries_stream_key_check CHECK (((stream_key = ''::text) OR (stream_key ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY event_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE event_ingress_routes (
    route_id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    kind text NOT NULL,
    external_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_ingress_routes_external_key_check CHECK (((external_key IS NULL) OR ((octet_length(external_key) >= 1) AND (octet_length(external_key) <= 512)))),
    CONSTRAINT event_ingress_routes_kind_check CHECK ((kind = ANY (ARRAY['webhook'::text, 'github'::text, 'slack'::text, 'gmail'::text, 'mcp'::text])))
);

CREATE TABLE event_source_feeds (
    source_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    cursor text,
    gap_pending boolean DEFAULT false NOT NULL,
    next_action_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    failures integer DEFAULT 0 NOT NULL,
    failing_since timestamp with time zone,
    last_error text,
    last_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_source_feeds_cursor_check CHECK (((cursor IS NULL) OR ((octet_length(cursor) >= 1) AND (octet_length(cursor) <= 4096)))),
    CONSTRAINT event_source_feeds_failures_check CHECK ((failures >= 0)),
    CONSTRAINT event_source_feeds_last_error_check CHECK (((last_error IS NULL) OR ((char_length(last_error) >= 1) AND (char_length(last_error) <= 500))))
);

ALTER TABLE ONLY event_source_feeds FORCE ROW LEVEL SECURITY;

CREATE TABLE event_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    adapter text,
    name text NOT NULL,
    owner_subject_id text,
    visibility text DEFAULT 'private'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    status_reason text,
    secret_encrypted text,
    external_key text,
    mcp_server_id text,
    connection_id uuid,
    last_delivery_at timestamp with time zone,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    status_reason_code text,
    status_reason_detail text,
    CONSTRAINT event_sources_adapter_check CHECK (((adapter IS NULL) OR (adapter = ANY (ARRAY['standard'::text, 'linear'::text, 'sentry'::text])))),
    CONSTRAINT event_sources_created_by_subject_id_check CHECK (((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 4096))),
    CONSTRAINT event_sources_external_key_check CHECK (((external_key IS NULL) OR ((octet_length(external_key) >= 1) AND (octet_length(external_key) <= 512)))),
    CONSTRAINT event_sources_kind_check CHECK ((kind = ANY (ARRAY['webhook'::text, 'github'::text, 'slack'::text, 'gmail'::text, 'mcp'::text, 'workspace'::text]))),
    CONSTRAINT event_sources_mcp_server_id_check CHECK (((mcp_server_id IS NULL) OR ((octet_length(mcp_server_id) >= 1) AND (octet_length(mcp_server_id) <= 256)))),
    CONSTRAINT event_sources_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT event_sources_owner_subject_id_check CHECK (((owner_subject_id IS NULL) OR ((octet_length(owner_subject_id) >= 1) AND (octet_length(owner_subject_id) <= 4096)))),
    CONSTRAINT event_sources_shape_chk CHECK ((((kind = 'webhook'::text) = (adapter IS NOT NULL)) AND ((kind <> 'webhook'::text) OR (secret_encrypted IS NOT NULL) OR ((adapter = ANY (ARRAY['linear'::text, 'sentry'::text])) AND (status <> 'active'::text))) AND ((kind = 'mcp'::text) = (mcp_server_id IS NOT NULL)) AND ((kind <> ALL (ARRAY['github'::text, 'slack'::text, 'gmail'::text])) OR (external_key IS NOT NULL)) AND ((kind <> ALL (ARRAY['webhook'::text, 'gmail'::text, 'mcp'::text, 'workspace'::text])) OR (owner_subject_id IS NOT NULL)) AND ((kind <> 'workspace'::text) OR (visibility = 'private'::text)) AND ((status = 'active'::text) = (status_reason IS NULL)))),
    CONSTRAINT event_sources_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'blocked'::text]))),
    CONSTRAINT event_sources_status_reason_check CHECK (((status_reason IS NULL) OR ((char_length(status_reason) >= 1) AND (char_length(status_reason) <= 500)))),
    CONSTRAINT event_sources_status_reason_code_chk CHECK ((((status_reason_code IS NULL) OR (status_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)) AND ((status_reason_detail IS NULL) OR ((status_reason_code IS NOT NULL) AND ((char_length(status_reason_detail) >= 1) AND (char_length(status_reason_detail) <= 500)))))),
    CONSTRAINT event_sources_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'workspace'::text])))
);

ALTER TABLE ONLY event_sources FORCE ROW LEVEL SECURITY;

CREATE TABLE event_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    task_id uuid NOT NULL,
    source_id uuid NOT NULL,
    "position" smallint NOT NULL,
    event_types text[] NOT NULL,
    conditions jsonb DEFAULT '[]'::jsonb NOT NULL,
    include_own_events boolean DEFAULT false NOT NULL,
    arguments jsonb,
    status text DEFAULT 'active'::text NOT NULL,
    status_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stream_key text DEFAULT ''::text NOT NULL,
    status_reason_code text,
    status_reason_detail text,
    CONSTRAINT event_triggers_arguments_check CHECK (((arguments IS NULL) OR ((jsonb_typeof(arguments) = 'object'::text) AND (octet_length((arguments)::text) <= 16384)))),
    CONSTRAINT event_triggers_conditions_check CHECK (((jsonb_typeof(conditions) = 'array'::text) AND (jsonb_array_length(conditions) <= 16) AND (octet_length((conditions)::text) <= 32768))),
    CONSTRAINT event_triggers_event_types_check CHECK (((cardinality(event_types) >= 1) AND (cardinality(event_types) <= 32))),
    CONSTRAINT event_triggers_position_check CHECK ((("position" >= 0) AND ("position" <= 15))),
    CONSTRAINT event_triggers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'blocked'::text, 'disabled'::text]))),
    CONSTRAINT event_triggers_status_chk CHECK (((status = 'active'::text) = (status_reason IS NULL))),
    CONSTRAINT event_triggers_status_reason_check CHECK (((status_reason IS NULL) OR ((char_length(status_reason) >= 1) AND (char_length(status_reason) <= 500)))),
    CONSTRAINT event_triggers_status_reason_code_chk CHECK ((((status_reason_code IS NULL) OR (status_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'::text)) AND ((status_reason_detail IS NULL) OR ((status_reason_code IS NOT NULL) AND ((char_length(status_reason_detail) >= 1) AND (char_length(status_reason_detail) <= 500)))))),
    CONSTRAINT event_triggers_stream_key_check CHECK (((stream_key = ''::text) OR (stream_key ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY event_triggers FORCE ROW LEVEL SECURITY;

CREATE TABLE external_identities (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    subject_id text NOT NULL,
    organization_membership_id uuid NOT NULL,
    personal_workspace_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    authorization_revision bigint DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT external_identities_authorization_revision_check CHECK ((authorization_revision > 0)),
    CONSTRAINT external_identities_check CHECK ((subject_id = ('external_user:'::text || (id)::text))),
    CONSTRAINT external_identities_external_id_check CHECK (((char_length(external_id) >= 1) AND (char_length(external_id) <= 1024))),
    CONSTRAINT external_identities_source_check CHECK (((char_length(source) >= 1) AND (char_length(source) <= 200))),
    CONSTRAINT external_identities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'revoked'::text])))
);

ALTER TABLE ONLY external_identities FORCE ROW LEVEL SECURITY;

CREATE TABLE external_identity_links (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    external_identity_id uuid NOT NULL,
    external_subject_id text NOT NULL,
    external_authorization_revision bigint NOT NULL,
    native_subject_id text,
    native_membership_id uuid,
    native_authorization_revision bigint,
    status text DEFAULT 'pending'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    permissions jsonb NOT NULL,
    challenge_digest text NOT NULL,
    confirm_before timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    confirmed_at timestamp with time zone,
    revoked_at timestamp with time zone,
    CONSTRAINT external_identity_links_challenge_digest_check CHECK ((challenge_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT external_identity_links_check CHECK ((((status = 'pending'::text) AND (native_subject_id IS NULL) AND (native_membership_id IS NULL) AND (native_authorization_revision IS NULL) AND (confirmed_at IS NULL)) OR ((status = 'active'::text) AND (native_subject_id IS NOT NULL) AND (native_membership_id IS NOT NULL) AND (native_authorization_revision IS NOT NULL) AND (confirmed_at IS NOT NULL)) OR (status = 'revoked'::text))),
    CONSTRAINT external_identity_links_check1 CHECK (((status = 'revoked'::text) = (revoked_at IS NOT NULL))),
    CONSTRAINT external_identity_links_check2 CHECK ((external_subject_id = ('external_user:'::text || (external_identity_id)::text))),
    CONSTRAINT external_identity_links_external_authorization_revision_check CHECK (((external_authorization_revision >= 1) AND (external_authorization_revision <= '9007199254740991'::bigint))),
    CONSTRAINT external_identity_links_native_authorization_revision_check CHECK (((native_authorization_revision >= 1) AND (native_authorization_revision <= '9007199254740991'::bigint))),
    CONSTRAINT external_identity_links_native_subject_id_check CHECK (((native_subject_id ~ '^user:[^\r\n]+$'::text) AND (octet_length(native_subject_id) <= 4096))),
    CONSTRAINT external_identity_links_permissions_check CHECK (((jsonb_typeof(permissions) = 'array'::text) AND ((jsonb_array_length(permissions) >= 1) AND (jsonb_array_length(permissions) <= 512)))),
    CONSTRAINT external_identity_links_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT external_identity_links_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY external_identity_links FORCE ROW LEVEL SECURITY;

CREATE TABLE external_link_task_authorities (
    task_id uuid NOT NULL,
    task_revision bigint NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    link_id uuid NOT NULL,
    link_revision bigint NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT external_link_task_authorities_canonical_snapshot_check CHECK (((jsonb_typeof(canonical_snapshot) = 'object'::text) AND (octet_length((canonical_snapshot)::text) <= 65536))),
    CONSTRAINT external_link_task_authorities_link_revision_check CHECK (((link_revision >= 1) AND (link_revision <= '9007199254740991'::bigint))),
    CONSTRAINT external_link_task_authorities_task_revision_check CHECK (((task_revision >= 1) AND (task_revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY external_link_task_authorities FORCE ROW LEVEL SECURITY;

CREATE TABLE external_link_turn_authorities (
    turn_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    link_id uuid NOT NULL,
    link_revision bigint NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    source_kind text NOT NULL,
    source_turn_id uuid,
    source_task_id uuid,
    source_task_revision bigint,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT external_link_turn_authorities_canonical_snapshot_check CHECK (((jsonb_typeof(canonical_snapshot) = 'object'::text) AND (octet_length((canonical_snapshot)::text) <= 65536))),
    CONSTRAINT external_link_turn_authorities_check CHECK ((((source_kind = 'direct'::text) AND (source_turn_id IS NULL) AND (source_task_id IS NULL) AND (source_task_revision IS NULL)) OR ((source_kind = ANY (ARRAY['causal'::text, 'child'::text, 'agent'::text])) AND (source_turn_id IS NOT NULL) AND (source_task_id IS NULL) AND (source_task_revision IS NULL)) OR ((source_kind = 'scheduled'::text) AND (source_turn_id IS NULL) AND (source_task_id IS NOT NULL) AND (source_task_revision > 0)))),
    CONSTRAINT external_link_turn_authorities_link_revision_check CHECK (((link_revision >= 1) AND (link_revision <= '9007199254740991'::bigint))),
    CONSTRAINT external_link_turn_authorities_source_kind_check CHECK ((source_kind = ANY (ARRAY['direct'::text, 'causal'::text, 'child'::text, 'scheduled'::text, 'agent'::text])))
);

ALTER TABLE ONLY external_link_turn_authorities FORCE ROW LEVEL SECURITY;

CREATE TABLE feedback_submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    principal_kind text,
    idempotency_key uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    sentiment text,
    comment text,
    comment_codec_version integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    context jsonb,
    screenshots jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT feedback_submissions_check CHECK (((turn_id IS NULL) OR (session_id IS NOT NULL))),
    CONSTRAINT feedback_submissions_check1 CHECK (((sentiment IS NULL) OR (session_id IS NOT NULL))),
    CONSTRAINT feedback_submissions_check2 CHECK (((sentiment IS NOT NULL) OR ((comment IS NOT NULL) AND (length(btrim(comment)) > 0)))),
    CONSTRAINT feedback_submissions_check3 CHECK (((comment IS NULL) = (comment_codec_version IS NULL))),
    CONSTRAINT feedback_submissions_comment_codec_version_check CHECK ((comment_codec_version = 1)),
    CONSTRAINT feedback_submissions_context_check CHECK (((context IS NULL) OR (jsonb_typeof(context) = 'object'::text))),
    CONSTRAINT feedback_submissions_screenshots_check CHECK (((jsonb_typeof(screenshots) = 'array'::text) AND (jsonb_array_length(screenshots) <= 3))),
    CONSTRAINT feedback_submissions_sentiment_check CHECK ((sentiment = ANY (ARRAY['positive'::text, 'negative'::text]))),
    CONSTRAINT feedback_submissions_subject_id_check CHECK ((length(btrim(subject_id)) > 0))
);

ALTER TABLE ONLY feedback_submissions FORCE ROW LEVEL SECURITY;

CREATE TABLE file_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    private_file_owner_subject_id text DEFAULT NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text)
);

ALTER TABLE ONLY file_uploads FORCE ROW LEVEL SECURITY;

CREATE TABLE generated_image_artifacts (
    artifact_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    attempt_id uuid,
    upload_id uuid,
    settlement_key text NOT NULL,
    tool_call_id text NOT NULL,
    source_strategy text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    provider_item_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    media_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    sandbox_path text NOT NULL,
    ready_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_image_artifacts_binding_hash_chk CHECK ((provider_binding_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT generated_image_artifacts_dimensions_chk CHECK ((((width >= 1) AND (width <= 16384)) AND ((height >= 1) AND (height <= 16384)) AND (((width)::bigint * (height)::bigint) <= 67108864))),
    CONSTRAINT generated_image_artifacts_identity_bounds_chk CHECK (((settlement_key ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(tool_call_id) >= 1) AND (octet_length(tool_call_id) <= 512)) AND ((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 128)) AND ((provider_item_id IS NULL) OR ((octet_length(provider_item_id) >= 1) AND (octet_length(provider_item_id) <= 512))) AND ((last_error IS NULL) OR (octet_length(last_error) <= 16384)))),
    CONSTRAINT generated_image_artifacts_media_type_chk CHECK ((media_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text, 'image/webp'::text]))),
    CONSTRAINT generated_image_artifacts_ready_shape_chk CHECK (((status = 'ready'::text) = (ready_at IS NOT NULL))),
    CONSTRAINT generated_image_artifacts_sandbox_path_chk CHECK ((sandbox_path ~ '^/workspace/generated-images/generated-image-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$'::text)),
    CONSTRAINT generated_image_artifacts_sha256_chk CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT generated_image_artifacts_size_chk CHECK (((size_bytes > 0) AND (size_bytes <= 67108864))),
    CONSTRAINT generated_image_artifacts_source_shape_chk CHECK ((((source_strategy = 'native_hosted'::text) AND (provider_item_id IS NOT NULL)) OR ((source_strategy = 'provider_adapter'::text) AND (provider_item_id IS NULL)))),
    CONSTRAINT generated_image_artifacts_source_strategy_chk CHECK ((source_strategy = ANY (ARRAY['native_hosted'::text, 'provider_adapter'::text]))),
    CONSTRAINT generated_image_artifacts_status_chk CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text])))
);

ALTER TABLE ONLY generated_image_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE generated_video_artifacts (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    primary_file_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    attempt_id uuid,
    model_id text NOT NULL,
    source_mode text NOT NULL,
    prompt_digest text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    duration_millis integer NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    fps_milli integer NOT NULL,
    video_codec text NOT NULL,
    audio_codec text,
    has_audio boolean NOT NULL,
    sandbox_filename text NOT NULL,
    deleted_at timestamp with time zone,
    ready_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT generated_video_artifacts_values_chk CHECK (((content_type = 'video/mp4'::text) AND (size_bytes > 0) AND (size_bytes <= 536870912) AND (sha256 ~ '^[0-9a-f]{64}$'::text) AND (prompt_digest ~ '^[0-9a-f]{64}$'::text) AND ((duration_millis >= 1) AND (duration_millis <= 120000)) AND ((width >= 1) AND (width <= 8192)) AND ((height >= 1) AND (height <= 8192)) AND ((fps_milli >= 1) AND (fps_milli <= 120000)) AND (video_codec = 'h264'::text) AND ((has_audio AND (audio_codec = 'aac'::text)) OR ((NOT has_audio) AND (audio_codec IS NULL))) AND (sandbox_filename = (('generated-video-'::text || (id)::text) || '.mp4'::text))))
);

ALTER TABLE ONLY generated_video_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE github_installation_repositories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    installation_id integer NOT NULL,
    repository_id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY github_installation_repositories FORCE ROW LEVEL SECURITY;

CREATE TABLE github_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    installation_id integer NOT NULL,
    account_login text,
    account_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    repository_scope text DEFAULT 'all'::text NOT NULL,
    linked_by_subject_id text,
    github_account_id bigint,
    github_actor_id bigint,
    github_actor_login text,
    authority_kind text,
    authority_checked_at timestamp with time zone,
    authority_expires_at timestamp with time zone,
    authority_nonce text,
    CONSTRAINT github_installations_authority_kind_check CHECK ((((github_account_id IS NULL) AND (github_actor_id IS NULL) AND (github_actor_login IS NULL) AND (authority_kind IS NULL) AND (authority_checked_at IS NULL) AND (authority_expires_at IS NULL) AND (authority_nonce IS NULL)) OR ((github_account_id IS NOT NULL) AND (github_account_id > 0) AND (github_actor_id IS NOT NULL) AND (github_actor_id > 0) AND (github_actor_login IS NOT NULL) AND (length(github_actor_login) > 0) AND (account_login IS NOT NULL) AND (length(account_login) > 0) AND (account_type IS NOT NULL) AND (linked_by_subject_id IS NOT NULL) AND (length(linked_by_subject_id) > 0) AND (authority_kind IS NOT NULL) AND (authority_checked_at IS NOT NULL) AND (authority_expires_at IS NOT NULL) AND (authority_checked_at < authority_expires_at) AND (authority_expires_at <= (authority_checked_at + '00:10:00'::interval)) AND (authority_nonce IS NOT NULL) AND (length(authority_nonce) > 0) AND (repository_scope = 'selected'::text) AND (((authority_kind = 'personal_owner'::text) AND (account_type = 'User'::text) AND (github_actor_id = github_account_id)) OR ((authority_kind = 'organization_owner'::text) AND (account_type = 'Organization'::text)))))),
    CONSTRAINT github_installations_repository_scope_check CHECK ((repository_scope = ANY (ARRAY['all'::text, 'selected'::text])))
);

ALTER TABLE ONLY github_installations FORCE ROW LEVEL SECURITY;

CREATE TABLE google_drive_object_acl_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    knowledge_source_object_id uuid NOT NULL,
    knowledge_document_version_id uuid NOT NULL,
    document_id uuid NOT NULL,
    file_id uuid NOT NULL,
    index_obligation_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    source_principal_hash text NOT NULL,
    source_sync_generation bigint NOT NULL,
    source_config_generation bigint NOT NULL,
    source_lifecycle_generation bigint NOT NULL,
    object_lifecycle_generation bigint NOT NULL,
    object_version_generation bigint NOT NULL,
    provider_revision text,
    drive_id text,
    acl_revision text NOT NULL,
    acl_hash text NOT NULL,
    eligibility text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    citation_locator jsonb NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT google_drive_object_acl_evidence_bounds_chk CHECK (((connection_version > 0) AND (source_sync_generation >= 0) AND (source_config_generation > 0) AND (source_lifecycle_generation > 0) AND (object_lifecycle_generation > 0) AND (object_version_generation > 0) AND (source_principal_hash ~ '^[0-9a-f]{64}$'::text) AND ((provider_revision IS NULL) OR ((length(provider_revision) >= 1) AND (length(provider_revision) <= 1024))) AND ((drive_id IS NULL) OR ((length(drive_id) >= 1) AND (length(drive_id) <= 1024))) AND ((length(btrim(acl_revision)) >= 1) AND (length(btrim(acl_revision)) <= 1024)) AND (acl_hash ~ '^[0-9a-f]{64}$'::text) AND (eligibility = ANY (ARRAY['eligible'::text, 'denied'::text])) AND (expires_at > observed_at) AND (jsonb_typeof(citation_locator) = 'object'::text) AND (octet_length(convert_to((citation_locator)::text, 'UTF8'::name)) <= 16384) AND ((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY google_drive_object_acl_evidence FORCE ROW LEVEL SECURITY;

CREATE TABLE google_drive_object_acl_principals (
    evidence_id uuid NOT NULL,
    ordinal integer NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    principal_type text NOT NULL,
    permission_id_hash text,
    email_hash text,
    domain_hash text,
    role text NOT NULL,
    inherited boolean DEFAULT false NOT NULL,
    allow_file_discovery boolean,
    expiration_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT google_drive_object_acl_principals_bounds_chk CHECK (((ordinal >= 0) AND (ordinal < 10000) AND (principal_type = ANY (ARRAY['user'::text, 'group'::text, 'domain'::text, 'anyone'::text])) AND ((permission_id_hash IS NULL) OR (permission_id_hash ~ '^[0-9a-f]{64}$'::text)) AND ((email_hash IS NULL) OR (email_hash ~ '^[0-9a-f]{64}$'::text)) AND ((domain_hash IS NULL) OR (domain_hash ~ '^[0-9a-f]{64}$'::text)) AND (role = ANY (ARRAY['owner'::text, 'organizer'::text, 'fileOrganizer'::text, 'writer'::text, 'commenter'::text, 'reader'::text])) AND (((principal_type = 'user'::text) AND ((permission_id_hash IS NOT NULL) OR (email_hash IS NOT NULL))) OR ((principal_type = 'group'::text) AND ((permission_id_hash IS NOT NULL) OR (email_hash IS NOT NULL))) OR ((principal_type = 'domain'::text) AND (domain_hash IS NOT NULL)) OR ((principal_type = 'anyone'::text) AND (permission_id_hash IS NULL) AND (email_hash IS NULL) AND (domain_hash IS NULL)))))
);

ALTER TABLE ONLY google_drive_object_acl_principals FORCE ROW LEVEL SECURITY;

CREATE TABLE host_export_config (
    id integer DEFAULT 1 NOT NULL,
    session_events_enabled boolean DEFAULT false NOT NULL,
    usage_events_enabled boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    lifecycle_facts_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT host_export_config_singleton_check CHECK ((id = 1))
);

ALTER TABLE ONLY host_export_config FORCE ROW LEVEL SECURITY;

CREATE TABLE host_export_consumers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    consumer_id text NOT NULL,
    export_kind text NOT NULL,
    checkpoint bigint DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    lease_token uuid,
    lease_holder_id text,
    lease_expires_at timestamp with time zone,
    lease_from bigint,
    lease_through bigint,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    last_error_at timestamp with time zone,
    blocked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error_codec_version integer,
    CONSTRAINT host_export_consumers_checkpoint_check CHECK ((checkpoint >= 0)),
    CONSTRAINT host_export_consumers_id_check CHECK ((((length(consumer_id) >= 1) AND (length(consumer_id) <= 128)) AND (consumer_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'::text))),
    CONSTRAINT host_export_consumers_kind_check CHECK ((export_kind = ANY (ARRAY['session_event'::text, 'usage_event'::text, 'lifecycle_fact'::text]))),
    CONSTRAINT host_export_consumers_lease_check CHECK ((((lease_token IS NULL) AND (lease_holder_id IS NULL) AND (lease_expires_at IS NULL) AND (lease_from IS NULL) AND (lease_through IS NULL)) OR ((lease_token IS NOT NULL) AND (lease_holder_id IS NOT NULL) AND (lease_expires_at IS NOT NULL) AND (lease_from IS NOT NULL) AND (lease_through IS NOT NULL) AND (lease_through > lease_from))))
);

ALTER TABLE ONLY host_export_consumers FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN host_export_consumers.last_error IS 'Exact internal host-sink failure storage. Public logs use a separate fixed structural projection.';

COMMENT ON COLUMN host_export_consumers.last_error_codec_version IS 'Out-of-band codec truth for the complete last_error value. NULL is literal old-writer data; 1 means the application encoded the whole value.';

CREATE TABLE host_export_cursor_state (
    export_kind text NOT NULL,
    next_cursor bigint DEFAULT 1 NOT NULL,
    pruned_through bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT host_export_cursor_state_kind_check CHECK ((export_kind = ANY (ARRAY['session_event'::text, 'usage_event'::text, 'lifecycle_fact'::text]))),
    CONSTRAINT host_export_cursor_state_next_check CHECK (((next_cursor > 0) AND (pruned_through >= 0) AND (pruned_through < next_cursor)))
);

ALTER TABLE ONLY host_export_cursor_state FORCE ROW LEVEL SECURITY;

CREATE TABLE host_export_dead_letters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    consumer_id text NOT NULL,
    export_kind text NOT NULL,
    export_cursor bigint NOT NULL,
    source_id uuid NOT NULL,
    reason text NOT NULL,
    envelope jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    envelope_codec_version integer,
    event_payload_codec_version integer,
    CONSTRAINT host_export_dead_letters_envelope_bytes_check CHECK ((pg_column_size(envelope) <= 114688)),
    CONSTRAINT host_export_dead_letters_kind_check CHECK ((export_kind = ANY (ARRAY['session_event'::text, 'usage_event'::text, 'lifecycle_fact'::text]))),
    CONSTRAINT host_export_dead_letters_reason_check CHECK (((length(reason) >= 1) AND (length(reason) <= 500)))
);

ALTER TABLE ONLY host_export_dead_letters FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN host_export_dead_letters.envelope IS 'Original mixed dead-letter envelope. SQL-built envelopes remain literal with NULL envelope_codec_version; nested session-event payload codec truth is separate.';

COMMENT ON COLUMN host_export_dead_letters.event_payload_codec_version IS 'Out-of-band codec truth only for envelope.event.payload. It never implies that the surrounding mixed envelope is encoded.';

CREATE TABLE host_export_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    export_kind text NOT NULL,
    export_cursor bigint,
    source_id uuid NOT NULL,
    account_id uuid,
    workspace_id uuid,
    session_id uuid,
    turn_id uuid,
    turn_generation integer,
    turn_attempt_id uuid,
    session_sequence integer,
    client_event_id text,
    turn_association text,
    duplicate_of_event_id uuid,
    duplicate_reason text,
    event_type text NOT NULL,
    idempotency_key text NOT NULL,
    initiator jsonb,
    initiator_context jsonb DEFAULT '{}'::jsonb NOT NULL,
    origin text,
    payload jsonb NOT NULL,
    envelope_bytes integer NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    source_recorded_at timestamp with time zone NOT NULL,
    enqueued_at timestamp with time zone NOT NULL,
    root_session_id uuid,
    payload_codec_version integer,
    surface text,
    model_provider text,
    tool_family text,
    CONSTRAINT host_export_outbox_analytics_check CHECK ((((surface IS NULL) OR (surface = ANY (ARRAY['web'::text, 'slack'::text, 'api_key'::text, 'embedded'::text, 'scheduled'::text, 'agent'::text, 'voice'::text, 'site'::text, 'automation'::text, 'mcp'::text, 'system'::text]))) AND ((model_provider IS NULL) OR (model_provider = ANY (ARRAY['openai'::text, 'azure'::text, 'codex-subscription'::text, 'supergrok-subscription'::text, 'opengeni-gateway'::text, 'workspace-gateway'::text, 'organization-gateway'::text, 'openrouter'::text, 'workspace-openrouter'::text, 'organization-openrouter'::text, 'opper'::text, 'workspace-opper'::text, 'organization-opper'::text, 'organization-openai'::text, 'organization-azure-openai'::text, 'registry'::text]))) AND ((tool_family IS NULL) OR (tool_family ~ '^(custom|integration:[a-z0-9]([a-z0-9.-]{0,150}[a-z0-9])?|[a-z][a-z0-9_]{0,63})$'::text)))),
    CONSTRAINT host_export_outbox_context_bytes_check CHECK ((octet_length((initiator_context)::text) <= 4096)),
    CONSTRAINT host_export_outbox_cursor_check CHECK (((export_cursor IS NULL) OR (export_cursor > 0))),
    CONSTRAINT host_export_outbox_envelope_bytes_check CHECK (((envelope_bytes > 0) AND (envelope_bytes <= 98304))),
    CONSTRAINT host_export_outbox_initiator_check CHECK (((initiator IS NULL) OR ((jsonb_typeof(initiator) = 'object'::text) AND ((initiator ->> 'kind'::text) = ANY (ARRAY['subject'::text, 'service'::text])) AND (length((initiator ->> 'subjectId'::text)) > 0)))),
    CONSTRAINT host_export_outbox_kind_check CHECK ((export_kind = ANY (ARRAY['session_event'::text, 'usage_event'::text, 'lifecycle_fact'::text]))),
    CONSTRAINT host_export_outbox_origin_check CHECK (((origin IS NULL) OR (origin = ANY (ARRAY['user'::text, 'scheduled_task'::text, 'api'::text, 'goal'::text, 'system'::text, 'compaction'::text])))),
    CONSTRAINT host_export_outbox_payload_bytes_check CHECK ((pg_column_size(payload) <= 73728)),
    CONSTRAINT host_export_outbox_root_session_check CHECK (((session_id IS NULL) OR (root_session_id IS NOT NULL))),
    CONSTRAINT host_export_outbox_scope_check CHECK ((((export_kind <> 'lifecycle_fact'::text) AND (account_id IS NOT NULL) AND (workspace_id IS NOT NULL)) OR ((export_kind = 'lifecycle_fact'::text) AND ((workspace_id IS NULL) OR (account_id IS NOT NULL)) AND (session_id IS NULL)))),
    CONSTRAINT host_export_outbox_sequence_check CHECK (((session_sequence IS NULL) OR (session_sequence > 0)))
);

ALTER TABLE ONLY host_export_outbox FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN host_export_outbox.payload IS 'Immutable bounded host projection. Canonical session_events retains the complete payload; oversized host projections carry an explicit content-free truncation receipt.';

COMMENT ON COLUMN host_export_outbox.payload_codec_version IS 'Codec truth for the stored host projection. NULL means literal SQL JSON, including oversized-payload projections; 1 means the original application-coded payload was retained exactly.';

CREATE TABLE host_mcp_bindings (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    authorization_revision bigint NOT NULL,
    operation_id uuid NOT NULL,
    request_digest text NOT NULL,
    definition jsonb NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT host_mcp_bindings_authorization_revision_check CHECK (((authorization_revision >= 1) AND (authorization_revision <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_bindings_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT host_mcp_bindings_definition_check CHECK (((jsonb_typeof(definition) = 'object'::text) AND (octet_length((definition)::text) <= 131072))),
    CONSTRAINT host_mcp_bindings_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_bindings_human_owner_check CHECK ((owner_subject_id ~ '^(external_user:|user:)[^\r\n]+$'::text)),
    CONSTRAINT host_mcp_bindings_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT host_mcp_bindings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY host_mcp_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE host_mcp_delegations (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    owner_authorization_revision bigint NOT NULL,
    binding_id uuid NOT NULL,
    binding_generation bigint NOT NULL,
    operation_id uuid NOT NULL,
    request_digest text NOT NULL,
    grant_definition jsonb NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT host_mcp_delegations_binding_generation_check CHECK (((binding_generation >= 1) AND (binding_generation <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_delegations_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT host_mcp_delegations_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_delegations_grant_definition_check CHECK (((jsonb_typeof(grant_definition) = 'object'::text) AND (octet_length((grant_definition)::text) <= 4096))),
    CONSTRAINT host_mcp_delegations_human_owner_check CHECK ((owner_subject_id ~ '^(external_user:|user:)[^\r\n]+$'::text)),
    CONSTRAINT host_mcp_delegations_owner_authorization_revision_check CHECK (((owner_authorization_revision >= 1) AND (owner_authorization_revision <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_delegations_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT host_mcp_delegations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY host_mcp_delegations FORCE ROW LEVEL SECURITY;

CREATE TABLE host_mcp_resolver_operations (
    account_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    request_digest text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT host_mcp_resolver_operations_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY host_mcp_resolver_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE host_mcp_resolvers (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    external_source text NOT NULL,
    url text NOT NULL,
    secret_encrypted text NOT NULL,
    timeout_ms integer NOT NULL,
    generation bigint NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT host_mcp_resolvers_external_source_check CHECK ((((length(external_source) >= 1) AND (length(external_source) <= 200)) AND (external_source = btrim(external_source)))),
    CONSTRAINT host_mcp_resolvers_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT host_mcp_resolvers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text]))),
    CONSTRAINT host_mcp_resolvers_timeout_ms_check CHECK (((timeout_ms >= 100) AND (timeout_ms <= 30000))),
    CONSTRAINT host_mcp_resolvers_url_check CHECK (((length(url) >= 1) AND (length(url) <= 2048)))
);

ALTER TABLE ONLY host_mcp_resolvers FORCE ROW LEVEL SECURITY;

CREATE TABLE host_mcp_task_authorities (
    task_id uuid NOT NULL,
    task_authority_revision bigint NOT NULL,
    server_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    binding_id uuid NOT NULL,
    delegation_id uuid NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT host_mcp_task_authorities_canonical_snapshot_check CHECK (((jsonb_typeof(canonical_snapshot) = 'object'::text) AND (octet_length((canonical_snapshot)::text) <= 262144))),
    CONSTRAINT host_mcp_task_authorities_server_id_check CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 1024))),
    CONSTRAINT host_mcp_task_authorities_task_authority_revision_check CHECK ((task_authority_revision > 0))
);

ALTER TABLE ONLY host_mcp_task_authorities FORCE ROW LEVEL SECURITY;

CREATE TABLE host_mcp_turn_authorities (
    turn_id uuid NOT NULL,
    server_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    binding_id uuid NOT NULL,
    delegation_id uuid NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT host_mcp_turn_authorities_canonical_snapshot_check CHECK (((jsonb_typeof(canonical_snapshot) = 'object'::text) AND (octet_length((canonical_snapshot)::text) <= 262144))),
    CONSTRAINT host_mcp_turn_authorities_server_id_check CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 1024)))
);

ALTER TABLE ONLY host_mcp_turn_authorities FORCE ROW LEVEL SECURITY;

CREATE TABLE image_generation_operations (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    attempt_id uuid,
    operation_key text NOT NULL,
    tool_call_id text NOT NULL,
    provider_id text NOT NULL,
    provider_binding_hash text NOT NULL,
    model_id text NOT NULL,
    request_digest text NOT NULL,
    expected_artifact_id uuid NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    provider_started_at timestamp with time zone,
    completed_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    priced_cost_micros bigint DEFAULT 0 NOT NULL,
    credit_state text DEFAULT 'not_applicable'::text NOT NULL,
    credit_usage_model_id text,
    CONSTRAINT image_generation_operations_credit_chk CHECK ((((priced_cost_micros = 0) AND (credit_state = 'not_applicable'::text) AND (credit_usage_model_id IS NULL)) OR (((priced_cost_micros >= 1) AND (priced_cost_micros <= 1000000000)) AND ((credit_usage_model_id IS NULL) OR ((octet_length(credit_usage_model_id) >= 1) AND (octet_length(credit_usage_model_id) <= 256))) AND (((credit_state = 'pending'::text) AND (status <> 'completed'::text)) OR ((credit_state = 'debited'::text) AND (status = 'completed'::text)))))),
    CONSTRAINT image_generation_operations_digest_chk CHECK (((operation_key ~ '^[0-9a-f]{64}$'::text) AND (provider_binding_hash ~ '^[0-9a-f]{64}$'::text) AND (request_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT image_generation_operations_identity_bounds_chk CHECK ((((octet_length(tool_call_id) >= 1) AND (octet_length(tool_call_id) <= 512)) AND ((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 128)) AND ((octet_length(model_id) >= 1) AND (octet_length(model_id) <= 256)) AND ((last_error IS NULL) OR (octet_length(last_error) <= 16384)))),
    CONSTRAINT image_generation_operations_state_chk CHECK ((((status = 'prepared'::text) AND (provider_started_at IS NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['provider_started'::text, 'outcome_unknown'::text, 'retention_failed'::text])) AND (provider_started_at IS NOT NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (provider_started_at IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT image_generation_operations_status_chk CHECK ((status = ANY (ARRAY['prepared'::text, 'provider_started'::text, 'completed'::text, 'outcome_unknown'::text, 'retention_failed'::text])))
);

ALTER TABLE ONLY image_generation_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE import_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source text NOT NULL,
    snapshot_date timestamp with time zone NOT NULL,
    snapshot_ref text,
    attribution_note text NOT NULL,
    imported_count integer DEFAULT 0 NOT NULL,
    skipped_count integer DEFAULT 0 NOT NULL,
    quarantined_count integer DEFAULT 0 NOT NULL,
    logo_failure_count integer DEFAULT 0 NOT NULL,
    stale_count integer DEFAULT 0 NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY import_batches FORCE ROW LEVEL SECURITY;

CREATE TABLE inbound_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    delivery_id uuid,
    external_id text,
    stream_key text DEFAULT ''::text NOT NULL,
    type text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    subject text,
    summary text NOT NULL,
    url text,
    actor_kind text DEFAULT 'unknown'::text NOT NULL,
    actor_name text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    data_truncated boolean DEFAULT false NOT NULL,
    gap_before boolean DEFAULT false NOT NULL,
    CONSTRAINT inbound_events_actor_kind_check CHECK ((actor_kind = ANY (ARRAY['person'::text, 'bot'::text, 'opengeni'::text, 'unknown'::text]))),
    CONSTRAINT inbound_events_actor_name_check CHECK (((actor_name IS NULL) OR (char_length(actor_name) <= 200))),
    CONSTRAINT inbound_events_data_check CHECK (((jsonb_typeof(data) = 'object'::text) AND (octet_length((data)::text) <= 98304))),
    CONSTRAINT inbound_events_external_id_check CHECK (((external_id IS NULL) OR ((octet_length(external_id) >= 1) AND (octet_length(external_id) <= 512)))),
    CONSTRAINT inbound_events_stream_key_check CHECK ((octet_length(stream_key) <= 512)),
    CONSTRAINT inbound_events_subject_check CHECK (((subject IS NULL) OR (char_length(subject) <= 300))),
    CONSTRAINT inbound_events_summary_check CHECK (((char_length(summary) >= 1) AND (char_length(summary) <= 500))),
    CONSTRAINT inbound_events_type_check CHECK (((octet_length(type) >= 1) AND (octet_length(type) <= 200))),
    CONSTRAINT inbound_events_url_check CHECK (((url IS NULL) OR (octet_length(url) <= 2048)))
);

ALTER TABLE ONLY inbound_events FORCE ROW LEVEL SECURITY;

CREATE TABLE sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    initial_message text NOT NULL,
    resources jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    model text NOT NULL,
    sandbox_backend text NOT NULL,
    temporal_workflow_id text,
    active_turn_id uuid,
    last_sequence integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    variable_set_id uuid,
    first_party_mcp_permissions jsonb,
    parent_session_id uuid,
    last_input_tokens integer,
    compact_requested boolean DEFAULT false NOT NULL,
    create_idempotency_key text,
    sandbox_os text DEFAULT 'linux'::text NOT NULL,
    sandbox_group_id uuid NOT NULL,
    title text,
    title_source text,
    active_sandbox_id uuid,
    active_epoch integer DEFAULT 0 NOT NULL,
    working_dir text,
    codex_pinned_credential_id uuid,
    codex_last_credential_id uuid,
    instructions text,
    rig_id uuid,
    rig_version_id uuid,
    codex_pin_source text,
    queue_version integer DEFAULT 0 NOT NULL,
    queue_head_position bigint DEFAULT 0 NOT NULL,
    queue_tail_position bigint DEFAULT 0 NOT NULL,
    direct_control_state text DEFAULT 'active'::text NOT NULL,
    direct_pause_revision bigint,
    subtree_run_override_revision bigint,
    control_version bigint DEFAULT 0 NOT NULL,
    direct_control_reason text,
    direct_control_changed_by text,
    direct_control_changed_at timestamp with time zone,
    tool_policy jsonb NOT NULL,
    activity_revision bigint DEFAULT 0 NOT NULL,
    created_by_kind text DEFAULT 'service'::text NOT NULL,
    created_by_subject_id text DEFAULT 'unattributed-legacy'::text NOT NULL,
    created_by_context jsonb DEFAULT '{"backfill": true}'::jsonb NOT NULL,
    initial_model_context text,
    root_session_id uuid NOT NULL,
    nested_agent_depth integer NOT NULL,
    max_nested_agent_depth_override integer,
    effective_max_nested_agent_depth integer NOT NULL,
    nested_agent_depth_policy_source text NOT NULL,
    nested_agent_depth_policy_session_id uuid,
    tool_policy_version integer DEFAULT 1 NOT NULL,
    skills jsonb DEFAULT '[]'::jsonb NOT NULL,
    first_party_mcp_tools jsonb DEFAULT '["set_session_title", "goal_set", "goal_update", "goal_complete", "goal_pause", "memory_search", "memory_save", "memory_correct", "preference_registry_summary", "preference_registry_get", "sandboxes_list", "sandbox_attach", "sandbox_swap", "run_on", "sandbox_provision", "connected_machine_remove", "rig_list", "rig_get", "rig_propose_change", "rig_verify", "rig_promote", "sessions_list", "session_get", "session_events", "session_create", "session_send_message", "session_pause", "session_resume", "session_steer", "set_other_session_title", "variable_set_list", "environment_list", "variable_set_set_variable", "environment_set_variable", "github_connect_link", "github_repositories_list", "social_connections_list", "social_posts_recent", "social_daily_analysis_context", "social_search_live", "social_mentions_live", "social_thread_fetch", "social_posts_sync", "social_post_reply", "scheduled_tasks_list", "scheduled_tasks_get", "scheduled_tasks_create", "scheduled_tasks_update", "scheduled_tasks_pause", "scheduled_tasks_resume", "scheduled_tasks_trigger", "scheduled_tasks_delete", "scheduled_task_runs_list", "slack_bot_list_channels", "slack_bot_channel_history", "slack_bot_thread_replies", "slack_bot_list_users", "slack_bot_list_files", "slack_bot_file_info", "slack_bot_file_content", "slack_bot_post_message", "slack_bot_delete_message", "artifacts_list", "artifacts_get_source", "artifacts_create", "artifacts_publish", "artifacts_rollback"]'::jsonb NOT NULL,
    codex_compaction_mode text DEFAULT 'portable'::text NOT NULL,
    initial_personal_connection_delegations jsonb DEFAULT '[]'::jsonb NOT NULL,
    parent_turn_id uuid,
    policy_role text,
    initial_message_codec_version integer,
    activity_revision_pending_xid bigint,
    owner_organization_membership_id uuid,
    visibility text DEFAULT 'workspace_shared'::text NOT NULL,
    authority_epoch integer DEFAULT 1 NOT NULL,
    forked_from_session_id uuid,
    forked_from_authority_epoch integer,
    forked_from_visibility text,
    forked_at timestamp with time zone,
    forked_by_organization_membership_id uuid,
    channel_id uuid,
    owner_subject_id text,
    initial_xai_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    reasoning_effort text NOT NULL,
    latency_mode text NOT NULL,
    initial_personal_resource_attachment_intent jsonb,
    create_requested_visibility text DEFAULT 'workspace_shared'::text NOT NULL,
    variable_set_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_wait_turn_id uuid,
    input_wait_until timestamp with time zone,
    input_wait_reason text,
    input_wait_set_at timestamp with time zone,
    agent_access text DEFAULT 'workspace'::text NOT NULL,
    end_user_source text,
    end_user_id text,
    memory_scope text DEFAULT 'workspace'::text NOT NULL,
    scope_subject_id text,
    admission_block jsonb,
    mcp_approval_policies jsonb DEFAULT '{}'::jsonb NOT NULL,
    initial_mcp_account_bindings jsonb,
    execution_authority_epoch integer DEFAULT 1 NOT NULL,
    code_search_enabled boolean,
    agent_config jsonb,
    imported_archive_import_id text,
    imported_archive_imported_at timestamp with time zone,
    imported_archive_request_hash text,
    imported_archive_subject_id text,
    imported_archive_next_offset integer,
    initial_claude_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    execution_context_turn_id uuid,
    keep_live boolean DEFAULT false NOT NULL,
    content_archive_state text,
    content_archive_started_at timestamp with time zone,
    content_archived_at timestamp with time zone,
    content_archive jsonb,
    content_archive_purged_at timestamp with time zone,
    authority_inserted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    vault_policy jsonb DEFAULT '{"mode": "all"}'::jsonb NOT NULL,
    initial_connection_account_intent jsonb,
    site_id uuid,
    site_access_root_id uuid,
    site_viewer_principal text,
    site_owner_subject_id text,
    activity_xid xid8 DEFAULT '0'::xid8 NOT NULL,
    agent_creation_attempt_id uuid,
    CONSTRAINT sessions_admission_block_shape CHECK (((admission_block IS NULL) OR (((jsonb_typeof(admission_block) = 'object'::text) AND (admission_block ?& ARRAY['reason'::text, 'sqlState'::text, 'retryPolicy'::text, 'blockedAt'::text, 'attemptId'::text, 'fence'::text, 'previousStatus'::text]) AND ((admission_block - ARRAY['reason'::text, 'sqlState'::text, 'retryPolicy'::text, 'blockedAt'::text, 'attemptId'::text, 'fence'::text, 'previousStatus'::text]) = '{}'::jsonb) AND ((admission_block ->> 'previousStatus'::text) = ANY (ARRAY['queued'::text, 'idle'::text, 'running'::text, 'recovering'::text, 'waiting_capacity'::text, 'requires_action'::text])) AND ((admission_block ->> 'reason'::text) = ANY (ARRAY['database_claim_rejected'::text, 'initiator_membership_required'::text, 'personal_resource_grant_required'::text])) AND ((admission_block ->> 'retryPolicy'::text) = 'explicit_recheck'::text) AND (((admission_block -> 'sqlState'::text) = 'null'::jsonb) OR ((admission_block ->> 'sqlState'::text) ~ '^[0-9A-Z]{5}$'::text)) AND (jsonb_typeof((admission_block -> 'blockedAt'::text)) = 'string'::text) AND (jsonb_typeof((admission_block -> 'attemptId'::text)) = 'string'::text) AND ((admission_block ->> 'attemptId'::text) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'::text) AND (jsonb_typeof((admission_block -> 'fence'::text)) = 'object'::text) AND ((admission_block -> 'fence'::text) ?& ARRAY['lastSequence'::text, 'controlVersion'::text]) AND (((admission_block -> 'fence'::text) - ARRAY['lastSequence'::text, 'controlVersion'::text]) = '{}'::jsonb) AND (jsonb_typeof((admission_block #> '{fence,lastSequence}'::text[])) = 'number'::text) AND (jsonb_typeof((admission_block #> '{fence,controlVersion}'::text[])) = 'number'::text) AND ((admission_block #>> '{fence,lastSequence}'::text[]) ~ '^[0-9]+$'::text) AND ((admission_block #>> '{fence,controlVersion}'::text[]) ~ '^[0-9]+$'::text)) IS TRUE))),
    CONSTRAINT sessions_agent_access_check CHECK ((agent_access = ANY (ARRAY['session'::text, 'user'::text, 'workspace'::text]))),
    CONSTRAINT sessions_authority_epoch_check CHECK ((authority_epoch > 0)),
    CONSTRAINT sessions_claude_authority_snapshot_chk CHECK (claude_provider_account_authority_snapshot_v1_valid(initial_claude_provider_account_authority_snapshot)),
    CONSTRAINT sessions_codex_compaction_mode_chk CHECK ((codex_compaction_mode = ANY (ARRAY['remote_v2'::text, 'portable'::text]))),
    CONSTRAINT sessions_codex_pin_source_check CHECK (((codex_pin_source IS NULL) OR (codex_pin_source = ANY (ARRAY['manual'::text, 'policy'::text])))),
    CONSTRAINT sessions_content_archive_size_check CHECK (((content_archive IS NULL) OR (octet_length((content_archive)::text) <= 65536))),
    CONSTRAINT sessions_content_archive_state_check CHECK ((((content_archive_state IS NULL) AND (content_archive_started_at IS NULL) AND (content_archived_at IS NULL) AND (content_archive IS NULL) AND (content_archive_purged_at IS NULL)) OR ((content_archive_state = 'archiving'::text) AND (content_archive_started_at IS NOT NULL) AND (content_archived_at IS NULL) AND (jsonb_typeof(content_archive) = 'object'::text) AND (content_archive_purged_at IS NULL)) OR ((content_archive_state = 'archived'::text) AND (content_archive_started_at IS NOT NULL) AND (content_archived_at IS NOT NULL) AND (jsonb_typeof(content_archive) = 'object'::text) AND (content_archive ? 'sha256'::text)))),
    CONSTRAINT sessions_control_revision_order_check CHECK (((control_version >= 0) AND ((direct_pause_revision IS NULL) OR (direct_pause_revision <= control_version)) AND ((subtree_run_override_revision IS NULL) OR (subtree_run_override_revision <= control_version)))),
    CONSTRAINT sessions_create_requested_visibility_check CHECK ((create_requested_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text]))),
    CONSTRAINT sessions_created_by_kind_check CHECK ((created_by_kind = ANY (ARRAY['subject'::text, 'service'::text]))),
    CONSTRAINT sessions_direct_control_state_check CHECK ((direct_control_state = ANY (ARRAY['active'::text, 'paused'::text]))),
    CONSTRAINT sessions_direct_pause_revision_check CHECK ((((direct_control_state = 'active'::text) AND (direct_pause_revision IS NULL)) OR ((direct_control_state = 'paused'::text) AND (direct_pause_revision IS NOT NULL)))),
    CONSTRAINT sessions_end_user_pair_check CHECK (((end_user_source IS NULL) = (end_user_id IS NULL))),
    CONSTRAINT sessions_execution_authority_epoch_bounds CHECK (((execution_authority_epoch > 0) AND (execution_authority_epoch <= authority_epoch))),
    CONSTRAINT sessions_first_party_mcp_tools_array_chk CHECK (((first_party_mcp_tools IS NULL) OR (jsonb_typeof(first_party_mcp_tools) = 'array'::text))),
    CONSTRAINT sessions_first_party_mcp_tools_no_model_credentials_chk CHECK ((NOT (first_party_mcp_tools @> '["github_token"]'::jsonb))),
    CONSTRAINT sessions_fork_provenance_check CHECK ((((forked_from_session_id IS NULL) AND (forked_from_authority_epoch IS NULL) AND (forked_from_visibility IS NULL) AND (forked_at IS NULL) AND (forked_by_organization_membership_id IS NULL)) OR ((forked_from_session_id IS NOT NULL) AND (forked_from_authority_epoch IS NOT NULL) AND (forked_from_authority_epoch > 0) AND (forked_from_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (forked_at IS NOT NULL) AND (forked_by_organization_membership_id IS NOT NULL)))),
    CONSTRAINT sessions_imported_archive_identity_check CHECK ((((imported_archive_import_id IS NULL) AND (imported_archive_imported_at IS NULL) AND (imported_archive_request_hash IS NULL) AND (imported_archive_subject_id IS NULL) AND (imported_archive_next_offset IS NULL)) OR ((imported_archive_import_id IS NOT NULL) AND ((octet_length(imported_archive_import_id) >= 1) AND (octet_length(imported_archive_import_id) <= 800)) AND (imported_archive_imported_at IS NOT NULL) AND (imported_archive_request_hash IS NOT NULL) AND (imported_archive_request_hash ~ '^[0-9a-f]{64}$'::text) AND (imported_archive_subject_id IS NOT NULL) AND (imported_archive_next_offset IS NOT NULL) AND (imported_archive_next_offset >= 0)))),
    CONSTRAINT sessions_imported_archive_inert_check CHECK (((imported_archive_import_id IS NULL) OR ((status = 'idle'::text) AND (active_turn_id IS NULL) AND (temporal_workflow_id IS NULL) AND (parent_session_id IS NULL)))),
    CONSTRAINT sessions_initial_connection_account_intent_shape CHECK (opengeni_private.connection_account_intent_is_valid(initial_connection_account_intent)),
    CONSTRAINT sessions_initial_mcp_account_bindings_check CHECK (((initial_mcp_account_bindings IS NULL) OR (jsonb_typeof(initial_mcp_account_bindings) = 'array'::text))),
    CONSTRAINT sessions_initial_model_context_check CHECK (((initial_model_context IS NULL) OR opengeni_private.model_context_value_valid(initial_model_context))),
    CONSTRAINT sessions_initial_personal_delegations_array_chk CHECK (((jsonb_typeof(initial_personal_connection_delegations) = 'array'::text) AND (jsonb_array_length(initial_personal_connection_delegations) <= 128))),
    CONSTRAINT sessions_initial_xai_authority_snapshot_chk CHECK (xai_provider_account_authority_snapshot_v1_valid(initial_xai_provider_account_authority_snapshot)),
    CONSTRAINT sessions_input_wait_check CHECK ((((input_wait_turn_id IS NULL) AND (input_wait_until IS NULL) AND (input_wait_reason IS NULL) AND (input_wait_set_at IS NULL)) OR ((input_wait_turn_id IS NOT NULL) AND (input_wait_until IS NOT NULL) AND (input_wait_reason IS NOT NULL) AND ((octet_length(btrim(input_wait_reason)) >= 1) AND (octet_length(btrim(input_wait_reason)) <= 2048)) AND (input_wait_set_at IS NOT NULL)))),
    CONSTRAINT sessions_latency_mode_check CHECK ((latency_mode = ANY (ARRAY['standard'::text, 'priority'::text, 'fast'::text]))),
    CONSTRAINT sessions_lifecycle_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'idle'::text, 'requires_action'::text, 'recovering'::text, 'waiting_capacity'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT sessions_mcp_approval_policies_check CHECK ((jsonb_typeof(mcp_approval_policies) = 'object'::text)),
    CONSTRAINT sessions_memory_scope_check CHECK ((memory_scope = ANY (ARRAY['workspace'::text, 'user'::text, 'session'::text, 'off'::text]))),
    CONSTRAINT sessions_nested_agent_depth_check CHECK (((nested_agent_depth >= 0) AND (nested_agent_depth <= 2147483647) AND (effective_max_nested_agent_depth >= 0) AND (effective_max_nested_agent_depth <= 2147483647) AND ((max_nested_agent_depth_override IS NULL) OR ((max_nested_agent_depth_override >= 0) AND (max_nested_agent_depth_override <= 2147483647))))),
    CONSTRAINT sessions_nested_agent_depth_not_null_check CHECK ((nested_agent_depth IS NOT NULL)),
    CONSTRAINT sessions_nested_agent_effective_max_not_null_check CHECK ((effective_max_nested_agent_depth IS NOT NULL)),
    CONSTRAINT sessions_nested_agent_override_check CHECK (((max_nested_agent_depth_override IS NULL) OR ((nested_agent_depth_policy_source = 'session'::text) AND (nested_agent_depth_policy_session_id = id) AND (effective_max_nested_agent_depth = max_nested_agent_depth_override)))),
    CONSTRAINT sessions_nested_agent_policy_snapshot_check CHECK ((((nested_agent_depth_policy_source = 'session'::text) AND (nested_agent_depth_policy_session_id IS NOT NULL)) OR ((nested_agent_depth_policy_source <> 'session'::text) AND (nested_agent_depth_policy_session_id IS NULL) AND (max_nested_agent_depth_override IS NULL)))),
    CONSTRAINT sessions_nested_agent_policy_source_check CHECK ((nested_agent_depth_policy_source = ANY (ARRAY['session'::text, 'workspace'::text, 'deployment'::text, 'default'::text]))),
    CONSTRAINT sessions_nested_agent_policy_source_not_null_check CHECK ((nested_agent_depth_policy_source IS NOT NULL)),
    CONSTRAINT sessions_nested_agent_root_not_null_check CHECK ((root_session_id IS NOT NULL)),
    CONSTRAINT sessions_owner_subject_pair_check CHECK (((owner_organization_membership_id IS NULL) = (owner_subject_id IS NULL))),
    CONSTRAINT sessions_parent_not_self_check CHECK (((parent_session_id IS NULL) OR (parent_session_id <> id))),
    CONSTRAINT sessions_policy_role_chk CHECK (((policy_role IS NULL) OR ((policy_role = lower(btrim(policy_role))) AND ((length(policy_role) >= 1) AND (length(policy_role) <= 64)) AND (policy_role ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (policy_role !~ '--'::text)))),
    CONSTRAINT sessions_private_owner_check CHECK (((visibility <> 'user_private'::text) OR (owner_organization_membership_id IS NOT NULL))),
    CONSTRAINT sessions_reasoning_effort_check CHECK ((reasoning_effort = ANY (ARRAY['none'::text, 'minimal'::text, 'low'::text, 'medium'::text, 'high'::text, 'xhigh'::text, 'max'::text]))),
    CONSTRAINT sessions_sandbox_os_check CHECK ((sandbox_os = ANY (ARRAY['linux'::text, 'macos'::text, 'windows'::text]))),
    CONSTRAINT sessions_scope_subject_id_check CHECK (((scope_subject_id IS NULL) OR (((octet_length(scope_subject_id) >= 1) AND (octet_length(scope_subject_id) <= 1024)) AND (scope_subject_id ~ '^(user:|external_user:).+'::text)))),
    CONSTRAINT sessions_tool_policy_shape_check CHECK (((jsonb_typeof(tool_policy) = 'object'::text) AND (tool_policy ? 'mode'::text) AND ((tool_policy ->> 'mode'::text) = ANY (ARRAY['workspace_default'::text, 'explicit'::text, 'inherited'::text])) AND (tool_policy ? 'inheritedFromSessionId'::text) AND (((tool_policy ->> 'inheritedFromSessionId'::text) IS NULL) OR ((tool_policy ->> 'inheritedFromSessionId'::text) ~ '^[0-9a-fA-F-]{36}$'::text)))),
    CONSTRAINT sessions_vault_policy_check CHECK (opengeni_private.vault_policy_is_valid(vault_policy)),
    CONSTRAINT sessions_visibility_check CHECK ((visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])))
)
WITH (autovacuum_analyze_scale_factor='0', autovacuum_analyze_threshold='50000');

ALTER TABLE ONLY sessions FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN sessions.initial_model_context IS 'Application context frozen with the winning initial user message; ordinary model-visible user-role content, omitted by standard timeline rendering.';

COMMENT ON COLUMN sessions.visibility IS 'Generic user_private/workspace_shared tenancy visibility; Slice A adds storage only.';

COMMENT ON COLUMN sessions.authority_epoch IS 'Monotonic execution-authority fence for later sharing/fork runtime; Slice A baseline is 1.';

COMMENT ON COLUMN sessions.initial_xai_provider_account_authority_snapshot IS 'Immutable create-time xAI provider-account authority staging snapshot copied to the first turn.';

COMMENT ON COLUMN sessions.variable_set_ids IS 'Ordered low-to-high precedence Variable Set ids; the final entry is mirrored in legacy variable_set_id.';

COMMENT ON COLUMN sessions.input_wait_turn_id IS 'Exact turn that declared wait_for_input; current only while it remains the latest finished turn.';

COMMENT ON COLUMN sessions.input_wait_until IS 'Absolute timeout safety-wake deadline persisted from wait_for_input timeoutSeconds.';

COMMENT ON COLUMN sessions.input_wait_reason IS 'Bounded agent-declared reason for the session-level wait.';

COMMENT ON COLUMN sessions.input_wait_set_at IS 'Database time when the current wait_for_input obligation was recorded.';

CREATE VIEW insights_audience_sessions WITH (security_invoker='true', security_barrier='true') AS
 SELECT id,
    status,
    initial_message,
    resources,
    tools,
    metadata,
    model,
    sandbox_backend,
    temporal_workflow_id,
    active_turn_id,
    last_sequence,
    created_at,
    updated_at,
    account_id,
    workspace_id,
    variable_set_id,
    first_party_mcp_permissions,
    parent_session_id,
    last_input_tokens,
    compact_requested,
    create_idempotency_key,
    sandbox_os,
    sandbox_group_id,
    title,
    title_source,
    active_sandbox_id,
    active_epoch,
    working_dir,
    codex_pinned_credential_id,
    codex_last_credential_id,
    instructions,
    rig_id,
    rig_version_id,
    codex_pin_source,
    queue_version,
    queue_head_position,
    queue_tail_position,
    direct_control_state,
    direct_pause_revision,
    subtree_run_override_revision,
    control_version,
    direct_control_reason,
    direct_control_changed_by,
    direct_control_changed_at,
    tool_policy,
    activity_revision,
    created_by_kind,
    created_by_subject_id,
    created_by_context,
    initial_model_context,
    root_session_id,
    nested_agent_depth,
    max_nested_agent_depth_override,
    effective_max_nested_agent_depth,
    nested_agent_depth_policy_source,
    nested_agent_depth_policy_session_id,
    tool_policy_version,
    skills,
    first_party_mcp_tools,
    codex_compaction_mode,
    initial_personal_connection_delegations,
    parent_turn_id,
    policy_role,
    initial_message_codec_version,
    activity_revision_pending_xid,
    owner_organization_membership_id,
    visibility,
    authority_epoch,
    forked_from_session_id,
    forked_from_authority_epoch,
    forked_from_visibility,
    forked_at,
    forked_by_organization_membership_id,
    channel_id,
    owner_subject_id,
    initial_xai_provider_account_authority_snapshot,
    reasoning_effort,
    latency_mode,
    initial_personal_resource_attachment_intent,
    create_requested_visibility,
    variable_set_ids,
    input_wait_turn_id,
    input_wait_until,
    input_wait_reason,
    input_wait_set_at,
    agent_access,
    end_user_source,
    end_user_id,
    memory_scope,
    scope_subject_id,
    admission_block,
    mcp_approval_policies,
    initial_mcp_account_bindings,
    execution_authority_epoch,
    code_search_enabled,
    agent_config,
    imported_archive_import_id,
    imported_archive_imported_at,
    imported_archive_request_hash,
    imported_archive_subject_id,
    imported_archive_next_offset,
    initial_claude_provider_account_authority_snapshot,
    execution_context_turn_id,
    keep_live,
    content_archive_state,
    content_archive_started_at,
    content_archived_at,
    content_archive,
    content_archive_purged_at,
    authority_inserted_at,
    vault_policy,
    initial_connection_account_intent,
    site_id,
    site_access_root_id,
    site_viewer_principal,
    site_owner_subject_id
   FROM sessions
  WHERE session_site_actor_visible(site_id, site_access_root_id, root_session_id, site_viewer_principal, site_owner_subject_id);

CREATE TABLE integration_facet_binding_owners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    binding_id uuid NOT NULL,
    owner_kind text NOT NULL,
    owner_id text NOT NULL,
    removable boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_facet_binding_owners_id_chk CHECK ((((length(owner_id) >= 1) AND (length(owner_id) <= 512)) AND (owner_id !~ '[[:cntrl:]]'::text))),
    CONSTRAINT integration_facet_binding_owners_kind_chk CHECK ((owner_kind = ANY (ARRAY['direct'::text, 'plugin'::text, 'migration'::text])))
);

ALTER TABLE ONLY integration_facet_binding_owners FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_facet_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    facet_definition_id uuid NOT NULL,
    integration_facet_installation_id uuid NOT NULL,
    binding_key text NOT NULL,
    display_name text NOT NULL,
    runtime_key text,
    connection_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    last_success_at timestamp with time zone,
    last_error_code text,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_facet_bindings_identity_chk CHECK ((((length(binding_key) >= 1) AND (length(binding_key) <= 128)) AND (binding_key = lower(btrim(binding_key))) AND (binding_key ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'::text) AND ((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 200)) AND ((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024)))),
    CONSTRAINT integration_facet_bindings_runtime_chk CHECK (((runtime_key IS NULL) OR (((length(runtime_key) >= 1) AND (length(runtime_key) <= 128)) AND (runtime_key ~ '^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$'::text)))),
    CONSTRAINT integration_facet_bindings_state_chk CHECK (((jsonb_typeof(config) = 'object'::text) AND (jsonb_typeof(cursor) = 'object'::text) AND (octet_length(convert_to((config)::text, 'UTF8'::name)) <= 131072) AND (octet_length(convert_to((cursor)::text, 'UTF8'::name)) <= 131072) AND (version > 0) AND ((last_error_code IS NULL) OR ((length(last_error_code) >= 1) AND (length(last_error_code) <= 120))))),
    CONSTRAINT integration_facet_bindings_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'needs_attention'::text, 'disabled'::text])))
);

ALTER TABLE ONLY integration_facet_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_facet_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_facet_id uuid NOT NULL,
    facet_key text NOT NULL,
    kind text NOT NULL,
    config_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_facet_definitions_key_chk CHECK ((((length(facet_key) >= 1) AND (length(facet_key) <= 200)) AND (facet_key = lower(btrim(facet_key))) AND (facet_key ~ '^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$'::text))),
    CONSTRAINT integration_facet_definitions_kind_chk CHECK ((kind = ANY (ARRAY['tools'::text, 'knowledge_source'::text, 'inbound_trigger'::text, 'delivery_destination'::text, 'identity_link'::text]))),
    CONSTRAINT integration_facet_definitions_schema_chk CHECK (((jsonb_typeof(config_schema) = 'object'::text) AND (jsonb_typeof(capabilities) = 'object'::text) AND (octet_length(convert_to((config_schema)::text, 'UTF8'::name)) <= 131072) AND (octet_length(convert_to((capabilities)::text, 'UTF8'::name)) <= 131072)))
);

ALTER TABLE ONLY integration_facet_definitions FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_oauth_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    issuer text NOT NULL,
    authorization_server text NOT NULL,
    client_id text NOT NULL,
    client_secret_encrypted text,
    token_endpoint_auth_method text DEFAULT 'none'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_oauth_clients_metadata_object_chk CHECK ((jsonb_typeof(metadata) = 'object'::text))
);

CREATE TABLE integration_oauth_pending_states (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    state_encrypted text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_oauth_pending_states_state_encrypted_check CHECK (((octet_length(state_encrypted) >= 1) AND (octet_length(state_encrypted) <= 32768)))
);

ALTER TABLE ONLY integration_oauth_pending_states FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_oauth_state_nonces (
    nonce text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY integration_oauth_state_nonces FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_spec_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    api_facet_id uuid NOT NULL,
    revision integer NOT NULL,
    protocol text NOT NULL,
    source_url text,
    spec_digest text NOT NULL,
    spec jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_spec_revisions_protocol_chk CHECK ((protocol = ANY (ARRAY['openapi'::text, 'graphql'::text]))),
    CONSTRAINT integration_spec_revisions_revision_chk CHECK ((revision > 0)),
    CONSTRAINT integration_spec_revisions_source_chk CHECK (((source_url IS NULL) OR (((length(source_url) >= 1) AND (length(source_url) <= 2048)) AND (source_url ~ '^https://'::text) AND (source_url !~ '[[:cntrl:][:space:]]'::text)))),
    CONSTRAINT integration_spec_revisions_spec_chk CHECK (((spec_digest ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof(spec) = 'object'::text) AND (octet_length(convert_to((spec)::text, 'UTF8'::name)) <= 4194304))),
    CONSTRAINT integration_spec_revisions_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'stale'::text, 'invalid'::text])))
);

ALTER TABLE ONLY integration_spec_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE integration_tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    facet_id uuid NOT NULL,
    tool_key text NOT NULL,
    name text NOT NULL,
    description text,
    input_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    output_schema jsonb,
    effect text DEFAULT 'read'::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integration_tools_effect_chk CHECK ((effect = ANY (ARRAY['read'::text, 'write'::text, 'destructive'::text]))),
    CONSTRAINT integration_tools_key_chk CHECK ((((length(tool_key) >= 1) AND (length(tool_key) <= 200)) AND (tool_key ~ '^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$'::text))),
    CONSTRAINT integration_tools_schema_chk CHECK (((jsonb_typeof(input_schema) = 'object'::text) AND ((output_schema IS NULL) OR (jsonb_typeof(output_schema) = 'object'::text)) AND (octet_length(convert_to((input_schema)::text, 'UTF8'::name)) <= 262144) AND ((output_schema IS NULL) OR (octet_length(convert_to((output_schema)::text, 'UTF8'::name)) <= 262144)))),
    CONSTRAINT integration_tools_text_chk CHECK ((((length(name) >= 1) AND (length(name) <= 200)) AND ((description IS NULL) OR (length(description) <= 4000))))
);

ALTER TABLE ONLY integration_tools FORCE ROW LEVEL SECURITY;

CREATE TABLE interaction_interventions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    target_id text NOT NULL,
    controller_generation text NOT NULL,
    target_generation text NOT NULL,
    document_generation text,
    kind text NOT NULL,
    reason text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    auth_run_id uuid,
    originating_session_id uuid NOT NULL,
    originating_turn_id uuid,
    originating_attempt_id uuid,
    originating_tool_operation_id uuid,
    response_actor_subject_id text,
    version bigint DEFAULT 1 NOT NULL,
    operation_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    originating_tool_call_id text,
    CONSTRAINT interaction_interventions_kind_check CHECK ((kind = ANY (ARRAY['manual_login'::text, 'mfa'::text, 'external_action'::text, 'confirmation'::text, 'other'::text]))),
    CONSTRAINT interaction_interventions_lifecycle_check CHECK ((((status = 'open'::text) AND (response_actor_subject_id IS NULL) AND (settled_at IS NULL)) OR ((status <> 'open'::text) AND (settled_at IS NOT NULL)))),
    CONSTRAINT interaction_interventions_originating_tool_call_check CHECK (((originating_tool_call_id IS NULL) OR ((originating_attempt_id IS NOT NULL) AND ((octet_length(originating_tool_call_id) >= 1) AND (octet_length(originating_tool_call_id) <= 1024))))),
    CONSTRAINT interaction_interventions_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['browser_session'::text, 'computer_session'::text]))),
    CONSTRAINT interaction_interventions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'dismissed'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT interaction_interventions_values_check CHECK ((((octet_length(target_id) >= 1) AND (octet_length(target_id) <= 512)) AND ((octet_length(controller_generation) >= 1) AND (octet_length(controller_generation) <= 256)) AND ((octet_length(target_generation) >= 1) AND (octet_length(target_generation) <= 256)) AND ((document_generation IS NULL) OR ((octet_length(document_generation) >= 1) AND (octet_length(document_generation) <= 256))) AND ((octet_length(reason) >= 1) AND (octet_length(reason) <= 2048)) AND (reason = btrim(reason)) AND ((originating_attempt_id IS NULL) OR (originating_turn_id IS NOT NULL)) AND ((originating_tool_operation_id IS NULL) OR (originating_attempt_id IS NOT NULL)) AND ((response_actor_subject_id IS NULL) OR ((octet_length(response_actor_subject_id) >= 1) AND (octet_length(response_actor_subject_id) <= 1024))) AND (version > 0)))
);

ALTER TABLE ONLY interaction_interventions FORCE ROW LEVEL SECURITY;

CREATE TABLE interaction_operations (
    operation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    kind text NOT NULL,
    request_digest text NOT NULL,
    state text DEFAULT 'prepared'::text NOT NULL,
    controller_generation text,
    error_code text,
    error_message text,
    error_retryable boolean,
    error_details jsonb,
    actor_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    settled_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT interaction_operations_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'resume'::text, 'suspend'::text, 'end'::text, 'publish'::text]))),
    CONSTRAINT interaction_operations_lifecycle_check CHECK ((((state = 'prepared'::text) AND (dispatched_at IS NULL) AND (settled_at IS NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (error_retryable IS NULL) AND (error_details IS NULL)) OR ((state = 'dispatched'::text) AND (dispatched_at IS NOT NULL) AND (settled_at IS NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (error_retryable IS NULL) AND (error_details IS NULL)) OR ((state = 'completed'::text) AND (dispatched_at IS NOT NULL) AND (settled_at IS NOT NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (error_retryable IS NULL) AND (error_details IS NULL)) OR ((state = ANY (ARRAY['failed'::text, 'outcome_unknown'::text])) AND (settled_at IS NOT NULL) AND (error_code IS NOT NULL) AND (error_message IS NOT NULL) AND (error_retryable IS NOT NULL)))),
    CONSTRAINT interaction_operations_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['browser_session'::text, 'computer_session'::text]))),
    CONSTRAINT interaction_operations_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'dispatched'::text, 'completed'::text, 'failed'::text, 'outcome_unknown'::text]))),
    CONSTRAINT interaction_operations_values_check CHECK (((request_digest ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 1024)) AND ((controller_generation IS NULL) OR ((octet_length(controller_generation) >= 1) AND (octet_length(controller_generation) <= 256))) AND ((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 512))) AND ((error_message IS NULL) OR ((octet_length(error_message) >= 1) AND (octet_length(error_message) <= 8192))) AND ((error_details IS NULL) OR ((jsonb_typeof(error_details) = 'object'::text) AND ((octet_length((error_details)::text) >= 2) AND (octet_length((error_details)::text) <= 65536))))))
);

ALTER TABLE ONLY interaction_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE interaction_resource_operations (
    operation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    resource_kind text NOT NULL,
    resource_id uuid NOT NULL,
    kind text NOT NULL,
    request_digest text NOT NULL,
    state text DEFAULT 'completed'::text NOT NULL,
    result_version bigint,
    result jsonb,
    error_code text,
    actor_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT interaction_resource_operations_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'update'::text, 'start'::text, 'report'::text, 'external_auth'::text, 'verify'::text, 'resolve'::text, 'save'::text]))),
    CONSTRAINT interaction_resource_operations_lifecycle_check CHECK ((((state = 'completed'::text) AND (result_version IS NOT NULL) AND (result IS NOT NULL) AND (error_code IS NULL) AND (settled_at IS NOT NULL)) OR ((state = ANY (ARRAY['failed'::text, 'outcome_unknown'::text])) AND (result_version IS NULL) AND (result IS NULL) AND (error_code IS NOT NULL) AND (settled_at IS NOT NULL)) OR ((state = ANY (ARRAY['prepared'::text, 'dispatched'::text])) AND (result_version IS NULL) AND (result IS NULL) AND (error_code IS NULL) AND (settled_at IS NULL)))),
    CONSTRAINT interaction_resource_operations_metadata_check CHECK (((jsonb_typeof(metadata) = 'object'::text) AND ((octet_length((metadata)::text) >= 2) AND (octet_length((metadata)::text) <= 65536)))),
    CONSTRAINT interaction_resource_operations_resource_kind_check CHECK ((resource_kind = ANY (ARRAY['browser_identity'::text, 'network_route'::text, 'site_auth_connection'::text, 'auth_run'::text, 'intervention'::text, 'browser_download'::text]))),
    CONSTRAINT interaction_resource_operations_state_check CHECK ((state = ANY (ARRAY['prepared'::text, 'dispatched'::text, 'completed'::text, 'failed'::text, 'outcome_unknown'::text]))),
    CONSTRAINT interaction_resource_operations_values_check CHECK (((request_digest ~ '^[0-9a-f]{64}$'::text) AND ((result_version IS NULL) OR (result_version > 0)) AND ((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND ((octet_length((result)::text) >= 2) AND (octet_length((result)::text) <= 262144)))) AND ((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 512))) AND ((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 1024))))
);

ALTER TABLE ONLY interaction_resource_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_change_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    target_kind text NOT NULL,
    target_scope text NOT NULL,
    target_key text,
    content text NOT NULL,
    content_hash text NOT NULL,
    claim_id uuid NOT NULL,
    evidence_id uuid NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_change_proposals_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_change_proposals_content_chk CHECK (((status = 'proposed'::text) AND (length(btrim(content)) > 0) AND (octet_length(content) <= 1048576) AND (content_hash ~ '^[0-9a-f]{64}$'::text) AND (content_hash = encode(sha256(convert_to(content, 'UTF8'::name)), 'hex'::text)))),
    CONSTRAINT knowledge_change_proposals_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id)))),
    CONSTRAINT knowledge_change_proposals_target_chk CHECK ((((target_kind = 'instruction_policy'::text) AND (((target_scope = 'global'::text) AND (target_key IS NULL)) OR ((target_scope = 'role'::text) AND ((length(btrim(target_key)) >= 1) AND (length(btrim(target_key)) <= 96))))) OR ((target_kind = 'preference'::text) AND (target_scope = ANY (ARRAY['organization'::text, 'workspace'::text, 'personal'::text])) AND (target_key = lower(btrim(target_key))) AND ((length(target_key) >= 1) AND (length(target_key) <= 96)) AND (target_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text))))
);

ALTER TABLE ONLY knowledge_change_proposals FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_claim_evidence (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    claim_id uuid NOT NULL,
    document_version_id uuid,
    polarity text NOT NULL,
    document_chunk_id uuid,
    chunk_index integer,
    locator text,
    quote_hash text,
    content_hash text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    task_note_id uuid,
    task_note_root_session_id uuid,
    task_note_version integer,
    CONSTRAINT knowledge_claim_evidence_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_claim_evidence_location_chk CHECK (((polarity = ANY (ARRAY['supports'::text, 'contradicts'::text])) AND ((chunk_index IS NULL) OR (chunk_index >= 0)) AND ((locator IS NULL) OR ((length(locator) >= 1) AND (length(locator) <= 2048))) AND ((quote_hash IS NULL) OR (quote_hash ~ '^[0-9a-f]{64}$'::text)) AND (content_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_claim_evidence_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id)))),
    CONSTRAINT knowledge_claim_evidence_source_shape_chk CHECK ((((document_version_id IS NOT NULL) AND (task_note_id IS NULL) AND (task_note_root_session_id IS NULL) AND (task_note_version IS NULL)) OR ((document_version_id IS NULL) AND (task_note_id IS NOT NULL) AND (task_note_root_session_id IS NOT NULL) AND (task_note_version = 1) AND (scope_kind = 'workspace'::text) AND (scope_workspace_id IS NOT NULL) AND (scope_subject_id IS NULL) AND (document_chunk_id IS NULL) AND (chunk_index IS NULL) AND (locator IS NULL) AND (quote_hash IS NULL))))
);

ALTER TABLE ONLY knowledge_claim_evidence FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_claim_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    relation_type text NOT NULL,
    from_claim_id uuid NOT NULL,
    to_claim_id uuid NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_claim_relations_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_claim_relations_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id)))),
    CONSTRAINT knowledge_claim_relations_shape_chk CHECK (((relation_type = ANY (ARRAY['supersedes'::text, 'conflicts_with'::text])) AND (from_claim_id <> to_claim_id) AND ((relation_type <> 'conflicts_with'::text) OR ((from_claim_id)::text < (to_claim_id)::text))))
);

ALTER TABLE ONLY knowledge_claim_relations FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    fact_id uuid NOT NULL,
    origin text NOT NULL,
    confidence_bps integer NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone,
    extraction_method text NOT NULL,
    extraction_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_provider text,
    model_name text,
    model_version text,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_claims_assertion_chk CHECK (((origin = ANY (ARRAY['explicit'::text, 'inferred'::text])) AND ((confidence_bps >= 0) AND (confidence_bps <= 10000)) AND ((expires_at IS NULL) OR (effective_at < expires_at)) AND ((length(btrim(extraction_method)) >= 1) AND (length(btrim(extraction_method)) <= 128)))),
    CONSTRAINT knowledge_claims_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_claims_metadata_chk CHECK (((jsonb_typeof(extraction_metadata) = 'object'::text) AND (octet_length(convert_to((extraction_metadata)::text, 'UTF8'::name)) <= 16384) AND ((model_provider IS NULL) OR ((length(model_provider) >= 1) AND (length(model_provider) <= 128))) AND ((model_name IS NULL) OR ((length(model_name) >= 1) AND (length(model_name) <= 256))) AND ((model_version IS NULL) OR ((length(model_version) >= 1) AND (length(model_version) <= 256))))),
    CONSTRAINT knowledge_claims_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_claims FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_document_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    source_id uuid NOT NULL,
    object_id uuid NOT NULL,
    version_generation bigint NOT NULL,
    external_version_id text NOT NULL,
    content_sha256 text NOT NULL,
    ingestion_key text NOT NULL,
    source_cursor text,
    source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_created_at timestamp with time zone,
    source_updated_at timestamp with time zone,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    acl_version_id uuid NOT NULL,
    acl_generation bigint NOT NULL,
    document_id uuid,
    file_id uuid,
    location_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_document_versions_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_document_versions_idempotency_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_document_versions_identity_chk CHECK (((version_generation > 0) AND ((length(btrim(external_version_id)) >= 1) AND (length(btrim(external_version_id)) <= 1024)) AND ((length(btrim(ingestion_key)) >= 1) AND (length(btrim(ingestion_key)) <= 512)) AND (content_sha256 ~ '^[0-9a-f]{64}$'::text) AND (acl_generation > 0) AND ((source_cursor IS NULL) OR (length(source_cursor) <= 4096)))),
    CONSTRAINT knowledge_document_versions_metadata_chk CHECK (((jsonb_typeof(source_metadata) = 'object'::text) AND (jsonb_typeof(location_metadata) = 'object'::text) AND (octet_length(convert_to((source_metadata)::text, 'UTF8'::name)) <= 16384) AND (octet_length(convert_to((location_metadata)::text, 'UTF8'::name)) <= 16384))),
    CONSTRAINT knowledge_document_versions_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_document_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    entity_type text NOT NULL,
    normalized_key text NOT NULL,
    display_name text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_entities_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_entities_key_chk CHECK (((entity_type = lower(btrim(entity_type))) AND ((length(entity_type) >= 1) AND (length(entity_type) <= 96)) AND (entity_type ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (normalized_key = lower(btrim(normalized_key))) AND ((length(normalized_key) >= 1) AND (length(normalized_key) <= 512)) AND ((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 512)))),
    CONSTRAINT knowledge_entities_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_entities FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entity_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    entity_id uuid NOT NULL,
    entity_type text NOT NULL,
    alias text NOT NULL,
    normalized_alias text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_entity_aliases_alias_chk CHECK ((((length(btrim(alias)) >= 1) AND (length(btrim(alias)) <= 512)) AND (normalized_alias = lower(btrim(normalized_alias))) AND ((length(normalized_alias) >= 1) AND (length(normalized_alias) <= 512)))),
    CONSTRAINT knowledge_entity_aliases_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_entity_aliases_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_entity_aliases FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    version integer NOT NULL,
    outcome text NOT NULL,
    actor jsonb NOT NULL,
    policy_snapshot jsonb,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT knowledge_entry_decisions_outcome_check CHECK ((outcome = ANY (ARRAY['published'::text, 'pending'::text, 'rejected'::text, 'archived'::text, 'restored'::text]))),
    CONSTRAINT knowledge_entry_decisions_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY knowledge_entry_decisions FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_links (
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    ordinal integer NOT NULL,
    target_entry_id uuid NOT NULL,
    target_revision_id uuid,
    relation text NOT NULL,
    CONSTRAINT knowledge_entry_links_check CHECK ((entry_id <> target_entry_id)),
    CONSTRAINT knowledge_entry_links_check1 CHECK (((relation = 'evidence'::text) = (target_revision_id IS NOT NULL))),
    CONSTRAINT knowledge_entry_links_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT knowledge_entry_links_relation_check CHECK ((relation = ANY (ARRAY['evidence'::text, 'group'::text, 'related_to'::text, 'depends_on'::text, 'applies_to'::text, 'conflicts_with'::text, 'supersedes'::text])))
);

ALTER TABLE ONLY knowledge_entry_links FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_operations (
    account_id uuid NOT NULL,
    origin_workspace_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    actor jsonb NOT NULL,
    request_hash text NOT NULL,
    receipt jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE ONLY knowledge_entry_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    number integer NOT NULL,
    change_kind text DEFAULT 'upsert'::text NOT NULL,
    body jsonb NOT NULL,
    body_codec_version integer,
    legacy_snapshot jsonb,
    preview text DEFAULT ''::text NOT NULL,
    preview_codec_version integer,
    previous_revision_id uuid,
    restored_from_revision_id uuid,
    actor jsonb NOT NULL,
    created_by_session_id uuid,
    created_by_turn_id uuid,
    review_batch_id uuid,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT knowledge_entry_revisions_body_check CHECK ((jsonb_typeof(body) = 'object'::text)),
    CONSTRAINT knowledge_entry_revisions_body_codec_version_check CHECK (((body_codec_version IS NULL) OR (body_codec_version = 1))),
    CONSTRAINT knowledge_entry_revisions_change_kind_check CHECK ((change_kind = ANY (ARRAY['upsert'::text, 'archive'::text]))),
    CONSTRAINT knowledge_entry_revisions_number_check CHECK ((number > 0))
);

ALTER TABLE ONLY knowledge_entry_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_search (
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    search_vector tsvector NOT NULL,
    CONSTRAINT knowledge_entry_search_chunk_index_check CHECK ((chunk_index >= 0))
);

ALTER TABLE ONLY knowledge_entry_search FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_entry_vectors (
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    generation integer NOT NULL,
    chunk_index integer NOT NULL,
    model text NOT NULL,
    dimensions integer NOT NULL,
    field text NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    text text NOT NULL,
    text_codec_version integer NOT NULL,
    embedding vector NOT NULL,
    CONSTRAINT knowledge_entry_vectors_check CHECK ((end_offset >= start_offset)),
    CONSTRAINT knowledge_entry_vectors_check1 CHECK (((vector_dims(embedding) = dimensions) AND (vector_norm(embedding) > (0)::double precision))),
    CONSTRAINT knowledge_entry_vectors_dimensions_check CHECK (((dimensions >= 1) AND (dimensions <= 4096))),
    CONSTRAINT knowledge_entry_vectors_field_check CHECK ((field = ANY (ARRAY['title'::text, 'content'::text]))),
    CONSTRAINT knowledge_entry_vectors_start_offset_check CHECK ((start_offset >= 0)),
    CONSTRAINT knowledge_entry_vectors_text_codec_version_check CHECK ((text_codec_version = 1))
);

ALTER TABLE ONLY knowledge_entry_vectors FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_facts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    subject_entity_id uuid NOT NULL,
    predicate_key text NOT NULL,
    object_kind text NOT NULL,
    object_entity_id uuid,
    object_value jsonb,
    object_hash text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_facts_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_facts_hash_chk CHECK (((object_hash ~ '^[0-9a-f]{64}$'::text) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_facts_object_shape_chk CHECK ((((object_kind = 'entity'::text) AND (object_entity_id IS NOT NULL) AND (object_value IS NULL)) OR ((object_kind = ANY (ARRAY['text'::text, 'number'::text, 'boolean'::text, 'json'::text, 'timestamp'::text])) AND (object_entity_id IS NULL) AND (object_value IS NOT NULL)))),
    CONSTRAINT knowledge_facts_predicate_chk CHECK (((predicate_key = lower(btrim(predicate_key))) AND ((length(predicate_key) >= 1) AND (length(predicate_key) <= 128)) AND (predicate_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text))),
    CONSTRAINT knowledge_facts_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_facts FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_index_jobs (
    account_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    model text,
    dimensions integer,
    generation integer DEFAULT 0 NOT NULL,
    completed_generation integer,
    next_index integer DEFAULT 0 NOT NULL,
    lease_id uuid,
    lease_until timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    last_failure text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    billing_mode text,
    billed_generation integer,
    billing_rate_micros_per_million_bytes bigint,
    billing_attribution jsonb DEFAULT '{"kind": "unknown"}'::jsonb NOT NULL,
    CONSTRAINT knowledge_index_billing_attribution_check CHECK (((jsonb_typeof(billing_attribution) = 'object'::text) AND COALESCE(
CASE (billing_attribution ->> 'kind'::text)
    WHEN 'unknown'::text THEN (billing_attribution = '{"kind": "unknown"}'::jsonb)
    WHEN 'service'::text THEN (billing_attribution = '{"kind": "service"}'::jsonb)
    WHEN 'human'::text THEN ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))
    WHEN 'turn'::text THEN ((COALESCE((billing_attribution ->> 'turnId'::text), ''::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text) AND (((billing_attribution -> 'initiatingHumanSubjectId'::text) = 'null'::jsonb) OR ((jsonb_typeof((billing_attribution -> 'initiatingHumanSubjectId'::text)) = 'string'::text) AND ((octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) >= 1) AND (octet_length((billing_attribution ->> 'initiatingHumanSubjectId'::text)) <= 1024)))))
    ELSE false
END, false))),
    CONSTRAINT knowledge_index_jobs_billing_mode_check CHECK ((billing_mode = ANY (ARRAY['usage_only'::text, 'shadow'::text, 'credits'::text]))),
    CONSTRAINT knowledge_index_jobs_billing_rate_micros_per_million_byte_check CHECK ((billing_rate_micros_per_million_bytes >= 0)),
    CONSTRAINT knowledge_index_jobs_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'obsolete'::text])))
);

ALTER TABLE ONLY knowledge_index_jobs FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_lifecycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    target_kind text NOT NULL,
    provider_id uuid,
    source_id uuid,
    object_id uuid,
    event_type text NOT NULL,
    old_state text NOT NULL,
    new_state text NOT NULL,
    old_generation bigint NOT NULL,
    new_generation bigint NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    reason_code text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_lifecycle_events_audit_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND ((length(btrim(reason_code)) >= 1) AND (length(btrim(reason_code)) <= 128)) AND opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id))),
    CONSTRAINT knowledge_lifecycle_events_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id)))),
    CONSTRAINT knowledge_lifecycle_events_target_chk CHECK ((((target_kind = 'provider'::text) AND (provider_id IS NOT NULL) AND (source_id IS NULL) AND (object_id IS NULL)) OR ((target_kind = 'source'::text) AND (provider_id IS NULL) AND (source_id IS NOT NULL) AND (object_id IS NULL)) OR ((target_kind = 'object'::text) AND (provider_id IS NULL) AND (source_id IS NULL) AND (object_id IS NOT NULL)))),
    CONSTRAINT knowledge_lifecycle_events_transition_chk CHECK (((event_type = ANY (ARRAY['deleted'::text, 'revoked'::text, 'restored'::text, 'acl_changed'::text, 'sync_succeeded'::text, 'sync_failed'::text, 'object_version_added'::text])) AND (old_state = ANY (ARRAY['active'::text, 'deleted'::text, 'revoked'::text])) AND (new_state = ANY (ARRAY['active'::text, 'deleted'::text, 'revoked'::text])) AND (old_generation > 0) AND (new_generation >= old_generation) AND (((event_type = ANY (ARRAY['deleted'::text, 'revoked'::text, 'restored'::text])) AND (new_generation = (old_generation + 1))) OR ((event_type <> ALL (ARRAY['deleted'::text, 'revoked'::text, 'restored'::text])) AND (new_generation = old_generation) AND (new_state = old_state)))))
);

ALTER TABLE ONLY knowledge_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    kind text DEFAULT 'semantic'::text NOT NULL,
    scope text DEFAULT 'workspace'::text NOT NULL,
    text text NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    confidence integer DEFAULT 50 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by_session_id uuid,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    embedding vector(3072),
    embedding_model text,
    pinned boolean DEFAULT false NOT NULL,
    usage_count integer DEFAULT 0 NOT NULL,
    last_used_at timestamp with time zone,
    supersedes_id uuid,
    superseded_by_id uuid,
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone,
    text_hash text,
    scope_type text DEFAULT 'workspace'::text NOT NULL,
    scope_subject_id text,
    scope_role_key text,
    scope_session_id uuid,
    namespace_key text DEFAULT 'general'::text NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    memory_version integer DEFAULT 1 NOT NULL,
    created_by_kind text DEFAULT 'service'::text NOT NULL,
    created_by_subject_id text DEFAULT 'unattributed-legacy'::text NOT NULL,
    created_by_context jsonb DEFAULT '{"backfill": true}'::jsonb NOT NULL,
    text_codec_version integer,
    CONSTRAINT knowledge_memories_creator_chk CHECK (((created_by_kind = ANY (ARRAY['subject'::text, 'service'::text])) AND ((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024)) AND (jsonb_typeof(created_by_context) = 'object'::text) AND ((created_by_context - ARRAY['backfill'::text, 'legacyWriter'::text, 'sessionId'::text, 'turnId'::text, 'attemptId'::text, 'executionGeneration'::text]) = '{}'::jsonb))),
    CONSTRAINT knowledge_memories_labels_chk CHECK (opengeni_private.memory_labels_valid(labels)),
    CONSTRAINT knowledge_memories_namespace_chk CHECK ((((length(namespace_key) >= 1) AND (length(namespace_key) <= 128)) AND (namespace_key ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?(?:/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)*$'::text))),
    CONSTRAINT knowledge_memories_scope_selector_chk CHECK ((((scope_type = 'workspace'::text) AND (scope_subject_id IS NULL) AND (scope_role_key IS NULL) AND (scope_session_id IS NULL)) OR ((scope_type = 'user'::text) AND ((length(btrim(scope_subject_id)) >= 1) AND (length(btrim(scope_subject_id)) <= 1024)) AND (scope_role_key IS NULL) AND (scope_session_id IS NULL)) OR ((scope_type = 'role'::text) AND (scope_subject_id IS NULL) AND (scope_role_key ~ '^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$'::text) AND (scope_session_id IS NULL)) OR ((scope_type = 'session'::text) AND (scope_subject_id IS NULL) AND (scope_role_key IS NULL) AND (scope_session_id IS NOT NULL)) OR ((scope_type = 'ephemeral'::text) AND (scope_subject_id IS NULL) AND (scope_role_key IS NULL) AND (scope_session_id IS NOT NULL) AND (valid_until IS NOT NULL)) OR ((scope_type = 'legacy'::text) AND (scope_subject_id IS NULL) AND (scope_role_key IS NULL) AND (scope_session_id IS NULL)))),
    CONSTRAINT knowledge_memories_valid_window_chk CHECK (((valid_until IS NULL) OR (valid_from <= valid_until))),
    CONSTRAINT knowledge_memories_version_chk CHECK ((memory_version > 0))
);

ALTER TABLE ONLY knowledge_memories FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN knowledge_memories.text IS 'Canonical exact memory text; PostgreSQL-unsafe code units use the application text codec.';

CREATE TABLE knowledge_memory_lifecycle_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    action text NOT NULL,
    operation_type text NOT NULL,
    target_memory_id uuid NOT NULL,
    related_memory_id uuid,
    relationship_id uuid,
    relationship_type text,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    actor_session_id uuid,
    actor_turn_id uuid,
    actor_attempt_id uuid,
    actor_execution_generation integer,
    plan_hash text NOT NULL,
    before_state jsonb NOT NULL,
    after_state jsonb NOT NULL,
    reverts_event_id uuid,
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT knowledge_memory_lifecycle_events_action_chk CHECK ((action = ANY (ARRAY['apply'::text, 'revert'::text]))),
    CONSTRAINT knowledge_memory_lifecycle_events_actor_chk CHECK (((actor_kind = ANY (ARRAY['subject'::text, 'service'::text])) AND ((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)))),
    CONSTRAINT knowledge_memory_lifecycle_events_attempt_shape_chk CHECK ((((actor_session_id IS NULL) AND (actor_turn_id IS NULL) AND (actor_attempt_id IS NULL) AND (actor_execution_generation IS NULL)) OR ((actor_session_id IS NOT NULL) AND (actor_turn_id IS NOT NULL) AND (actor_attempt_id IS NOT NULL) AND (actor_execution_generation > 0)))),
    CONSTRAINT knowledge_memory_lifecycle_events_operation_chk CHECK ((operation_type = ANY (ARRAY['reclassify'::text, 'archive'::text, 'relationship_add'::text, 'relationship_remove'::text, 'supersede'::text, 'correct'::text]))),
    CONSTRAINT knowledge_memory_lifecycle_events_plan_hash_chk CHECK ((plan_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT knowledge_memory_lifecycle_events_relationship_chk CHECK ((((operation_type = ANY (ARRAY['relationship_add'::text, 'relationship_remove'::text, 'supersede'::text, 'correct'::text])) AND (related_memory_id IS NOT NULL) AND (relationship_id IS NOT NULL) AND (relationship_type IS NOT NULL)) OR ((operation_type = ANY (ARRAY['reclassify'::text, 'archive'::text])) AND (related_memory_id IS NULL) AND (relationship_id IS NULL) AND (relationship_type IS NULL)))),
    CONSTRAINT knowledge_memory_lifecycle_events_revert_shape_chk CHECK ((((action = 'apply'::text) AND (reverts_event_id IS NULL)) OR ((action = 'revert'::text) AND (reverts_event_id IS NOT NULL)))),
    CONSTRAINT knowledge_memory_lifecycle_events_state_chk CHECK (((jsonb_typeof(before_state) = 'object'::text) AND (jsonb_typeof(after_state) = 'object'::text) AND (NOT (before_state ?| ARRAY['text'::text, 'sourceRefs'::text, 'source_refs'::text, 'metadata'::text, 'embedding'::text])) AND (NOT (after_state ?| ARRAY['text'::text, 'sourceRefs'::text, 'source_refs'::text, 'metadata'::text, 'embedding'::text]))))
);

ALTER TABLE ONLY knowledge_memory_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_memory_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_memory_id uuid NOT NULL,
    target_memory_id uuid NOT NULL,
    relationship_type text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by_event_id uuid NOT NULL,
    removed_by_event_id uuid,
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    removed_at timestamp with time zone,
    CONSTRAINT knowledge_memory_relationships_distinct_chk CHECK ((source_memory_id <> target_memory_id)),
    CONSTRAINT knowledge_memory_relationships_removed_shape_chk CHECK ((((removed_by_event_id IS NULL) AND (removed_at IS NULL)) OR ((removed_by_event_id IS NOT NULL) AND (removed_at IS NOT NULL)))),
    CONSTRAINT knowledge_memory_relationships_type_chk CHECK ((relationship_type = ANY (ARRAY['derived_from'::text, 'supersedes'::text, 'corrects'::text, 'conflicts_with'::text, 'related_to'::text, 'depends_on'::text, 'applies_to'::text]))),
    CONSTRAINT knowledge_memory_relationships_version_chk CHECK ((version > 0))
);

ALTER TABLE ONLY knowledge_memory_relationships FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_operation_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    operation_kind text NOT NULL,
    operation_namespace text NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    result_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_operation_receipts_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_operation_receipts_identity_chk CHECK (((operation_kind = ANY (ARRAY['provider'::text, 'source'::text, 'source_object'::text, 'document_version'::text, 'entity'::text, 'entity_alias'::text, 'fact'::text, 'claim_relation'::text])) AND ((length(btrim(operation_namespace)) >= 1) AND (length(btrim(operation_namespace)) <= 256)) AND ((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_operation_receipts_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_operation_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    provider_key text NOT NULL,
    external_tenant_id text NOT NULL,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    lifecycle_generation bigint DEFAULT 1 NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_providers_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_providers_external_identity_chk CHECK (((length(btrim(external_tenant_id)) >= 1) AND (length(btrim(external_tenant_id)) <= 1024))),
    CONSTRAINT knowledge_providers_idempotency_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_providers_lifecycle_chk CHECK (((lifecycle_state = ANY (ARRAY['active'::text, 'deleted'::text, 'revoked'::text])) AND (lifecycle_generation > 0))),
    CONSTRAINT knowledge_providers_provider_key_chk CHECK (((provider_key = lower(btrim(provider_key))) AND ((length(provider_key) >= 1) AND (length(provider_key) <= 96)) AND (provider_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (provider_key !~ '--'::text))),
    CONSTRAINT knowledge_providers_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_providers FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_review_batches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    origin_workspace_id uuid NOT NULL,
    owner_key text NOT NULL,
    session_id uuid,
    turn_id uuid,
    scheduled_task_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY knowledge_review_batches FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_acl_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    source_id uuid NOT NULL,
    source_scope_key text NOT NULL,
    generation bigint NOT NULL,
    acl_version text,
    acl_hash text NOT NULL,
    agent_access boolean DEFAULT true NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_acl_versions_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_source_acl_versions_bounds_chk CHECK ((((acl_version IS NULL) OR ((length(acl_version) >= 1) AND (length(acl_version) <= 512))) AND ((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)))),
    CONSTRAINT knowledge_source_acl_versions_generation_chk CHECK ((generation > 0)),
    CONSTRAINT knowledge_source_acl_versions_hash_chk CHECK (((acl_hash ~ '^[0-9a-f]{64}$'::text) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_source_acl_versions_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_source_acl_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    source_id uuid NOT NULL,
    external_object_id text NOT NULL,
    document_id uuid,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    lifecycle_generation bigint DEFAULT 1 NOT NULL,
    version_generation bigint DEFAULT 0 NOT NULL,
    current_version_id uuid,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_objects_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_source_objects_generation_chk CHECK (((lifecycle_state = ANY (ARRAY['active'::text, 'deleted'::text, 'revoked'::text])) AND (lifecycle_generation > 0) AND (version_generation >= 0) AND ((current_version_id IS NULL) = (version_generation = 0)))),
    CONSTRAINT knowledge_source_objects_idempotency_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT knowledge_source_objects_identity_chk CHECK (((length(btrim(external_object_id)) >= 1) AND (length(btrim(external_object_id)) <= 1024))),
    CONSTRAINT knowledge_source_objects_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_source_objects FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_sync_index_obligations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    scheduled_task_run_id uuid,
    source_id uuid NOT NULL,
    source_sync_generation bigint NOT NULL,
    initiating_subject_id text NOT NULL,
    external_object_id text NOT NULL,
    knowledge_source_object_id uuid NOT NULL,
    knowledge_document_version_id uuid NOT NULL,
    document_id uuid NOT NULL,
    source_config_generation bigint NOT NULL,
    source_lifecycle_generation bigint NOT NULL,
    object_lifecycle_generation bigint NOT NULL,
    object_version_generation bigint NOT NULL,
    citation_locator jsonb NOT NULL,
    acl_eligibility text DEFAULT 'pending'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    google_drive_acl_evidence_id uuid,
    CONSTRAINT knowledge_source_sync_index_obligations_bounds_chk CHECK ((((length(btrim(external_object_id)) >= 1) AND (length(btrim(external_object_id)) <= 1024)) AND (source_sync_generation >= 0) AND ((length(btrim(initiating_subject_id)) >= 1) AND (length(btrim(initiating_subject_id)) <= 1024)) AND (source_config_generation > 0) AND (source_lifecycle_generation > 0) AND (object_lifecycle_generation > 0) AND (object_version_generation > 0) AND (jsonb_typeof(citation_locator) = 'object'::text) AND (octet_length(convert_to((citation_locator)::text, 'UTF8'::name)) <= 16384) AND (acl_eligibility = ANY (ARRAY['pending'::text, 'eligible'::text, 'denied'::text])) AND (status = ANY (ARRAY['pending'::text, 'indexed'::text, 'failed'::text, 'invalidated'::text])) AND ((failure_code IS NULL) OR ((length(btrim(failure_code)) >= 1) AND (length(btrim(failure_code)) <= 128)))))
);

ALTER TABLE ONLY knowledge_source_sync_index_obligations FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_sync_item_outcomes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    scheduled_task_run_id uuid NOT NULL,
    knowledge_sync_run_id uuid,
    source_id uuid NOT NULL,
    source_config_generation bigint NOT NULL,
    source_lifecycle_generation bigint NOT NULL,
    external_object_id text NOT NULL,
    provider_revision text,
    metadata_hash text,
    acl_eligibility text DEFAULT 'pending'::text NOT NULL,
    acl_evidence jsonb,
    index_obligation_id uuid,
    outcome text NOT NULL,
    reason_code text,
    detail text,
    content_sha256 text,
    size_bytes bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_sync_item_outcomes_bounds_chk CHECK ((((length(btrim(external_object_id)) >= 1) AND (length(btrim(external_object_id)) <= 1024)) AND (source_config_generation > 0) AND (source_lifecycle_generation > 0) AND (outcome = ANY (ARRAY['imported'::text, 'unchanged'::text, 'skipped'::text, 'failed'::text, 'tombstoned'::text])) AND ((provider_revision IS NULL) OR ((length(provider_revision) >= 1) AND (length(provider_revision) <= 1024))) AND ((metadata_hash IS NULL) OR (metadata_hash ~ '^[0-9a-f]{64}$'::text)) AND (acl_eligibility = ANY (ARRAY['pending'::text, 'eligible'::text, 'denied'::text])) AND ((acl_evidence IS NULL) OR ((jsonb_typeof(acl_evidence) = 'object'::text) AND (octet_length(convert_to((acl_evidence)::text, 'UTF8'::name)) <= 16384))) AND ((reason_code IS NULL) OR ((length(btrim(reason_code)) >= 1) AND (length(btrim(reason_code)) <= 128))) AND ((detail IS NULL) OR (length(detail) <= 1000)) AND ((content_sha256 IS NULL) OR (content_sha256 ~ '^[0-9a-f]{64}$'::text)) AND ((size_bytes IS NULL) OR (size_bytes >= 0))))
);

ALTER TABLE ONLY knowledge_source_sync_item_outcomes FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_sync_object_observations (
    source_id uuid NOT NULL,
    external_object_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    scheduled_task_run_id uuid,
    scan_generation bigint NOT NULL,
    provider_revision text,
    metadata_hash text,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_sync_object_observations_bounds_chk CHECK ((((length(btrim(external_object_id)) >= 1) AND (length(btrim(external_object_id)) <= 1024)) AND (scan_generation > 0) AND ((provider_revision IS NULL) OR ((length(provider_revision) >= 1) AND (length(provider_revision) <= 1024))) AND ((metadata_hash IS NULL) OR (metadata_hash ~ '^[0-9a-f]{64}$'::text))))
);

ALTER TABLE ONLY knowledge_source_sync_object_observations FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_sync_states (
    source_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    scheduled_task_id uuid NOT NULL,
    source_sync_generation bigint NOT NULL,
    source_lifecycle_generation bigint NOT NULL,
    source_config_generation bigint NOT NULL,
    control_workspace_id uuid NOT NULL,
    provider_coordination_key text NOT NULL,
    connection_id uuid NOT NULL,
    connection_version bigint NOT NULL,
    connection_provider_domain text NOT NULL,
    connection_kind text NOT NULL,
    connection_owner_subject_id text NOT NULL,
    initiating_subject_id text NOT NULL,
    destination jsonb NOT NULL,
    execution_checkpoint jsonb,
    execution_checkpoint_generation bigint DEFAULT 0 NOT NULL,
    active_scan_generation bigint DEFAULT 0 NOT NULL,
    provider_cursor jsonb,
    wake_revision bigint DEFAULT 0 NOT NULL,
    pending_wake_count integer DEFAULT 0 NOT NULL,
    lease_id uuid,
    lease_until timestamp with time zone,
    buffered_wake boolean DEFAULT false NOT NULL,
    buffered_scheduled_task_run_id uuid,
    reconnect_required boolean DEFAULT false NOT NULL,
    last_success_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    last_summary jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_sync_states_authority_chk CHECK (((source_sync_generation >= 0) AND (source_lifecycle_generation > 0) AND (source_config_generation > 0) AND (control_workspace_id = workspace_id) AND ((length(btrim(provider_coordination_key)) >= 1) AND (length(btrim(provider_coordination_key)) <= 1024)) AND (connection_version > 0) AND ((length(btrim(connection_provider_domain)) >= 1) AND (length(btrim(connection_provider_domain)) <= 2048)) AND (connection_kind = ANY (ARRAY['oauth2'::text, 'api_key'::text, 'app_install'::text, 'delegated'::text])) AND ((length(btrim(connection_owner_subject_id)) >= 1) AND (length(btrim(connection_owner_subject_id)) <= 1024)) AND ((length(btrim(initiating_subject_id)) >= 1) AND (length(btrim(initiating_subject_id)) <= 1024)) AND (jsonb_typeof(destination) = 'object'::text) AND ((execution_checkpoint IS NULL) OR ((jsonb_typeof(execution_checkpoint) = 'object'::text) AND (octet_length(convert_to((execution_checkpoint)::text, 'UTF8'::name)) <= 2097152))) AND (execution_checkpoint_generation >= 0) AND (active_scan_generation >= 0) AND ((provider_cursor IS NULL) OR ((jsonb_typeof(provider_cursor) = 'object'::text) AND (octet_length(convert_to((provider_cursor)::text, 'UTF8'::name)) <= 1048576))) AND (wake_revision >= 0) AND (pending_wake_count >= 0) AND (((lease_id IS NULL) AND (lease_until IS NULL)) OR ((lease_id IS NOT NULL) AND (lease_until IS NOT NULL))) AND (((buffered_wake = true) AND (buffered_scheduled_task_run_id IS NOT NULL)) OR ((buffered_wake = false) AND (buffered_scheduled_task_run_id IS NULL))) AND ((last_summary IS NULL) OR ((jsonb_typeof(last_summary) = 'object'::text) AND (octet_length(convert_to((last_summary)::text, 'UTF8'::name)) <= 16384)))))
);

ALTER TABLE ONLY knowledge_source_sync_states FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_source_sync_wakes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    scheduled_task_id uuid NOT NULL,
    scheduled_task_run_id uuid NOT NULL,
    cause text NOT NULL,
    producer_key text NOT NULL,
    source_config_generation bigint NOT NULL,
    source_lifecycle_generation bigint NOT NULL,
    coalesced boolean DEFAULT false NOT NULL,
    claimed_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_source_sync_wakes_bounds_chk CHECK (((cause = ANY (ARRAY['scheduled'::text, 'manual'::text, 'initial'::text, 'provider_event'::text, 'retry'::text, 'repair'::text])) AND ((length(btrim(producer_key)) >= 1) AND (length(btrim(producer_key)) <= 1024)) AND (source_config_generation > 0) AND (source_lifecycle_generation > 0) AND ((completed_at IS NULL) OR (claimed_at IS NOT NULL))))
);

ALTER TABLE ONLY knowledge_source_sync_wakes FORCE ROW LEVEL SECURITY;

CREATE TABLE knowledge_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    scope_kind text NOT NULL,
    scope_workspace_id uuid,
    scope_subject_id text,
    scope_key text NOT NULL,
    provider_id uuid NOT NULL,
    external_source_id text NOT NULL,
    source_kind text NOT NULL,
    source_uri text,
    current_acl_generation bigint,
    sync_generation bigint DEFAULT 0 NOT NULL,
    sync_cursor text,
    lifecycle_state text DEFAULT 'active'::text NOT NULL,
    lifecycle_generation bigint DEFAULT 1 NOT NULL,
    operation_id text NOT NULL,
    input_hash text NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT knowledge_sources_actor_chk CHECK (opengeni_private.scoped_knowledge_actor_valid(actor_kind, actor_subject_id, initiating_human_subject_id)),
    CONSTRAINT knowledge_sources_generations_chk CHECK ((((current_acl_generation IS NULL) OR (current_acl_generation > 0)) AND (sync_generation >= 0) AND (lifecycle_generation > 0) AND (lifecycle_state = ANY (ARRAY['active'::text, 'deleted'::text, 'revoked'::text])))),
    CONSTRAINT knowledge_sources_idempotency_chk CHECK ((((length(btrim(operation_id)) >= 1) AND (length(btrim(operation_id)) <= 256)) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND ((sync_cursor IS NULL) OR (length(sync_cursor) <= 4096)))),
    CONSTRAINT knowledge_sources_identity_chk CHECK ((((length(btrim(external_source_id)) >= 1) AND (length(btrim(external_source_id)) <= 1024)) AND ((length(btrim(source_kind)) >= 1) AND (length(btrim(source_kind)) <= 96)) AND ((source_uri IS NULL) OR ((length(source_uri) >= 1) AND (length(source_uri) <= 4096))))),
    CONSTRAINT knowledge_sources_scope_chk CHECK ((opengeni_private.scoped_knowledge_scope_valid(scope_kind, scope_workspace_id, scope_subject_id) AND (scope_key = opengeni_private.scoped_knowledge_scope_key(scope_kind, scope_workspace_id, scope_subject_id))))
);

ALTER TABLE ONLY knowledge_sources FORCE ROW LEVEL SECURITY;

CREATE TABLE machine_metrics_latest (
    enrollment_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    cpu_percent numeric,
    load1 numeric,
    load5 numeric,
    load15 numeric,
    mem_used_bytes bigint,
    mem_total_bytes bigint,
    disk_used_bytes bigint,
    disk_total_bytes bigint,
    gpu_util_percent numeric,
    gpu_mem_used_bytes bigint,
    gpu_mem_total_bytes bigint,
    contention numeric,
    sampled_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY machine_metrics_latest FORCE ROW LEVEL SECURITY;

CREATE TABLE machine_metrics_series (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    enrollment_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    cpu_percent numeric,
    load1 numeric,
    load5 numeric,
    load15 numeric,
    mem_used_bytes bigint,
    mem_total_bytes bigint,
    disk_used_bytes bigint,
    disk_total_bytes bigint,
    gpu_util_percent numeric,
    gpu_mem_used_bytes bigint,
    gpu_mem_total_bytes bigint,
    contention numeric,
    sampled_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY machine_metrics_series FORCE ROW LEVEL SECURITY;

CREATE TABLE machine_removal_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    enrollment_id uuid NOT NULL,
    operation_key text NOT NULL,
    request_fingerprint text NOT NULL,
    outcome text NOT NULL,
    result jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT machine_removal_operations_operation_key_chk CHECK ((((length(btrim(operation_key)) >= 1) AND (length(btrim(operation_key)) <= 200)) AND (operation_key = btrim(operation_key)))),
    CONSTRAINT machine_removal_operations_outcome_chk CHECK ((outcome = ANY (ARRAY['removed'::text, 'already_removed'::text, 'blocked'::text]))),
    CONSTRAINT machine_removal_operations_request_fingerprint_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY machine_removal_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE managed_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    external_source text,
    external_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE managed_auth_actor_mutation_leases (
    session_set_id uuid NOT NULL,
    request_id uuid NOT NULL,
    actor_epoch bigint NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT managed_auth_actor_mutation_leases_epoch_check CHECK ((actor_epoch > 0)),
    CONSTRAINT managed_auth_actor_mutation_leases_expiry_check CHECK (((expires_at > acquired_at) AND (expires_at <= (acquired_at + '00:15:00'::interval))))
);

ALTER TABLE ONLY managed_auth_actor_mutation_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE managed_auth_browser_installations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    authority_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    idle_expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    absolute_expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval) NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT managed_auth_browser_installations_expiry_check CHECK (((idle_expires_at > created_at) AND (idle_expires_at <= absolute_expires_at) AND (absolute_expires_at <= (created_at + '180 days'::interval)))),
    CONSTRAINT managed_auth_browser_installations_hash_check CHECK ((authority_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY managed_auth_browser_installations FORCE ROW LEVEL SECURITY;

CREATE TABLE managed_auth_login_return_intents (
    id uuid NOT NULL,
    session_set_id uuid NOT NULL,
    path text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT managed_auth_login_return_intents_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT managed_auth_login_return_intents_path_check CHECK ((((octet_length(path) >= 1) AND (octet_length(path) <= 2048)) AND ("left"(path, 1) = '/'::text) AND ("left"(path, 2) <> '//'::text) AND (POSITION(('?'::text) IN (path)) = 0) AND (POSITION(('#'::text) IN (path)) = 0) AND (POSITION(('\'::text) IN (path)) = 0) AND (path !~ '[[:cntrl:]]'::text) AND (path ~* '^/(sessions/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(/sessions(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?)?)$'::text)))
);

ALTER TABLE ONLY managed_auth_login_return_intents FORCE ROW LEVEL SECURITY;

CREATE TABLE managed_auth_login_slots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_set_id uuid NOT NULL,
    auth_session_id text,
    auth_user_id text NOT NULL,
    identity_id uuid NOT NULL,
    login_binding_id uuid NOT NULL,
    identity_revision bigint NOT NULL,
    auth_revision bigint NOT NULL,
    login_binding_revision bigint NOT NULL,
    display_name text NOT NULL,
    verified_email text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT managed_auth_login_slots_display_check CHECK ((((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 256)) AND ((length(btrim(verified_email)) >= 3) AND (length(btrim(verified_email)) <= 320)))),
    CONSTRAINT managed_auth_login_slots_revision_check CHECK (((identity_revision > 0) AND (auth_revision > 0) AND (login_binding_revision > 0))),
    CONSTRAINT managed_auth_login_slots_revocation_check CHECK ((((status = 'revoked'::text) AND (revoked_at IS NOT NULL)) OR ((status <> 'revoked'::text) AND (revoked_at IS NULL)))),
    CONSTRAINT managed_auth_login_slots_status_check CHECK ((status = ANY (ARRAY['active'::text, 'reauth_required'::text, 'revoked'::text])))
);

ALTER TABLE ONLY managed_auth_login_slots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE managed_auth_login_slots IS 'Bounded provider-neutral login slots; references Better Auth sessions server-side and never duplicates their tokens.';

CREATE TABLE managed_auth_login_transaction_rate_limits (
    scope_kind text NOT NULL,
    scope_hash text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempt_count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT managed_auth_login_transaction_rate_limits_count_check CHECK (((attempt_count > 0) AND (expires_at > window_started_at))),
    CONSTRAINT managed_auth_login_transaction_rate_limits_scope_check CHECK (((scope_kind = ANY (ARRAY['global'::text, 'client'::text, 'set'::text])) AND (scope_hash ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY managed_auth_login_transaction_rate_limits FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE managed_auth_login_transaction_rate_limits IS 'Bounded multi-replica global, secret-hashed client, and session-set rate buckets for browser login transactions.';

CREATE TABLE managed_auth_login_transactions (
    id uuid NOT NULL,
    session_set_id uuid NOT NULL,
    secret_hash text NOT NULL,
    kind text NOT NULL,
    target_slot_id uuid,
    expected_identity_id uuid,
    expected_login_binding_id uuid,
    expected_identity_revision bigint,
    expected_auth_revision bigint,
    expected_login_binding_revision bigint,
    expected_generation bigint NOT NULL,
    return_intent_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT managed_auth_login_transactions_expiry_check CHECK ((expires_at > created_at)),
    CONSTRAINT managed_auth_login_transactions_generation_check CHECK (((expected_generation > 0) AND ((expected_identity_revision IS NULL) OR (expected_identity_revision > 0)) AND ((expected_auth_revision IS NULL) OR (expected_auth_revision > 0)) AND ((expected_login_binding_revision IS NULL) OR (expected_login_binding_revision > 0)))),
    CONSTRAINT managed_auth_login_transactions_hash_check CHECK ((secret_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT managed_auth_login_transactions_kind_check CHECK ((kind = ANY (ARRAY['add'::text, 'reauth'::text]))),
    CONSTRAINT managed_auth_login_transactions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'consumed'::text, 'cancelled'::text]))),
    CONSTRAINT managed_auth_login_transactions_target_check CHECK ((((kind = 'add'::text) AND (target_slot_id IS NULL) AND (expected_identity_id IS NULL) AND (expected_login_binding_id IS NULL) AND (expected_identity_revision IS NULL) AND (expected_auth_revision IS NULL) AND (expected_login_binding_revision IS NULL)) OR ((kind = 'reauth'::text) AND (target_slot_id IS NOT NULL) AND (expected_identity_id IS NOT NULL) AND (expected_login_binding_id IS NOT NULL) AND (expected_identity_revision IS NOT NULL) AND (expected_auth_revision IS NOT NULL) AND (expected_login_binding_revision IS NOT NULL))))
);

ALTER TABLE ONLY managed_auth_login_transactions FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE managed_auth_login_transactions IS 'One-use isolated add/reauth transactions; only SHA-256 secret digests are durable.';

CREATE TABLE managed_auth_session_set_operations (
    operation_id uuid NOT NULL,
    session_set_id uuid NOT NULL,
    operation_type text NOT NULL,
    request_digest text NOT NULL,
    expected_generation bigint NOT NULL,
    result_generation bigint NOT NULL,
    result_actor_epoch bigint NOT NULL,
    target_slot_id uuid,
    replacement_slot_id uuid,
    outcome text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT managed_auth_session_set_operations_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT managed_auth_session_set_operations_generation_check CHECK (((expected_generation > 0) AND (result_generation > 0) AND (result_actor_epoch > 0))),
    CONSTRAINT managed_auth_session_set_operations_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'converged'::text]))),
    CONSTRAINT managed_auth_session_set_operations_result_check CHECK (((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384))),
    CONSTRAINT managed_auth_session_set_operations_type_check CHECK ((operation_type = ANY (ARRAY['bootstrap'::text, 'begin_add'::text, 'begin_reauth'::text, 'complete_add'::text, 'complete_reauth'::text, 'cancel_transaction'::text, 'select'::text, 'logout_one'::text, 'logout_all'::text])))
);

ALTER TABLE ONLY managed_auth_session_set_operations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE managed_auth_session_set_operations IS 'Append-only, secret-free idempotency and security evidence; expired slot-free pre-auth sets are physically purged.';

CREATE TABLE managed_auth_session_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    installation_id uuid NOT NULL,
    authority_hash text NOT NULL,
    csrf_hash text NOT NULL,
    generation bigint DEFAULT 1 NOT NULL,
    actor_epoch bigint DEFAULT 1 NOT NULL,
    selected_slot_id uuid,
    state text DEFAULT 'ready'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    idle_expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval) NOT NULL,
    absolute_expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval) NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT managed_auth_session_sets_expiry_check CHECK (((idle_expires_at > created_at) AND (idle_expires_at <= absolute_expires_at) AND (absolute_expires_at <= (created_at + '180 days'::interval)))),
    CONSTRAINT managed_auth_session_sets_generation_check CHECK (((generation > 0) AND (actor_epoch > 0))),
    CONSTRAINT managed_auth_session_sets_hash_check CHECK (((authority_hash ~ '^[0-9a-f]{64}$'::text) AND (csrf_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT managed_auth_session_sets_state_check CHECK ((state = ANY (ARRAY['ready'::text, 'actor_change_required'::text])))
);

ALTER TABLE ONLY managed_auth_session_sets FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE managed_auth_session_sets IS 'Hash-only browser installation/session-set authority with explicit generation and actor-epoch fences.';

CREATE TABLE managed_sign_in_method_operations (
    operation_id uuid NOT NULL,
    auth_user_id text NOT NULL,
    request_digest text NOT NULL,
    kind text NOT NULL,
    provider text NOT NULL,
    notification_email text NOT NULL,
    notification_status text DEFAULT 'pending'::text NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_id uuid,
    lease_until timestamp with time zone,
    first_attempt_at timestamp with time zone,
    retry_until timestamp with time zone,
    sender text,
    provider_scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT managed_sign_in_method_operations_kind_check CHECK ((kind = ANY (ARRAY['password'::text, 'disconnect'::text, 'connect'::text, 'automatic_link'::text, 'recovery'::text]))),
    CONSTRAINT managed_sign_in_method_operations_notification_status_check CHECK ((notification_status = ANY (ARRAY['pending'::text, 'sent'::text, 'failed'::text, 'outcome_unknown'::text]))),
    CONSTRAINT managed_sign_in_method_operations_provider_check CHECK ((provider = ANY (ARRAY['password'::text, 'google'::text, 'github'::text]))),
    CONSTRAINT managed_sign_in_method_operations_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY managed_sign_in_method_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE mcp_event_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_id uuid NOT NULL,
    stream_key text NOT NULL,
    event_name text NOT NULL,
    arguments jsonb DEFAULT '{}'::jsonb NOT NULL,
    mode text,
    cursor text,
    gap_pending boolean DEFAULT false NOT NULL,
    route_id uuid,
    secret_encrypted text,
    server_subscription_id text,
    refresh_before timestamp with time zone,
    next_action_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    failures integer DEFAULT 0 NOT NULL,
    failing_since timestamp with time zone,
    last_error text,
    last_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_event_subscriptions_arguments_check CHECK (((jsonb_typeof(arguments) = 'object'::text) AND (octet_length((arguments)::text) <= 16384))),
    CONSTRAINT mcp_event_subscriptions_cursor_check CHECK (((cursor IS NULL) OR (octet_length(cursor) <= 4096))),
    CONSTRAINT mcp_event_subscriptions_event_name_check CHECK (((octet_length(event_name) >= 1) AND (octet_length(event_name) <= 200))),
    CONSTRAINT mcp_event_subscriptions_failures_check CHECK ((failures >= 0)),
    CONSTRAINT mcp_event_subscriptions_last_error_check CHECK (((last_error IS NULL) OR ((char_length(last_error) >= 1) AND (char_length(last_error) <= 500)))),
    CONSTRAINT mcp_event_subscriptions_mode_check CHECK (((mode IS NULL) OR (mode = ANY (ARRAY['poll'::text, 'webhook'::text])))),
    CONSTRAINT mcp_event_subscriptions_server_subscription_id_check CHECK (((server_subscription_id IS NULL) OR ((octet_length(server_subscription_id) >= 1) AND (octet_length(server_subscription_id) <= 512)))),
    CONSTRAINT mcp_event_subscriptions_stream_key_check CHECK ((stream_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT mcp_event_subscriptions_webhook_chk CHECK ((((route_id IS NULL) = (secret_encrypted IS NULL)) AND ((server_subscription_id IS NULL) OR (COALESCE(mode, ''::text) = 'webhook'::text))))
);

ALTER TABLE ONLY mcp_event_subscriptions FORCE ROW LEVEL SECURITY;

CREATE TABLE mcp_oauth_access_tokens (
    token_hash text NOT NULL,
    refresh_family_id uuid NOT NULL,
    refresh_generation integer NOT NULL,
    client_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    subject_id text NOT NULL,
    resource text NOT NULL,
    permissions jsonb NOT NULL,
    tool_identities jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_access jsonb,
    CONSTRAINT mcp_oauth_access_tokens_permissions_check CHECK ((jsonb_typeof(permissions) = 'array'::text)),
    CONSTRAINT mcp_oauth_access_tokens_refresh_generation_check CHECK ((refresh_generation > 0)),
    CONSTRAINT mcp_oauth_access_tokens_resource_check CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048))),
    CONSTRAINT mcp_oauth_access_tokens_subject_id_check CHECK (((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024))),
    CONSTRAINT mcp_oauth_access_tokens_target_check CHECK (((workspace_id IS NULL) <> (organization_access IS NULL))),
    CONSTRAINT mcp_oauth_access_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT mcp_oauth_access_tokens_tool_identities_check CHECK (((jsonb_typeof(tool_identities) = 'array'::text) AND (jsonb_array_length(tool_identities) <= 4096)))
);

CREATE TABLE mcp_oauth_authorization_codes (
    code_hash text NOT NULL,
    client_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    subject_id text NOT NULL,
    resource text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    permissions jsonb NOT NULL,
    tool_identities jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_access jsonb,
    CONSTRAINT mcp_oauth_authorization_codes_code_challenge_check CHECK ((code_challenge ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT mcp_oauth_authorization_codes_code_hash_check CHECK ((code_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT mcp_oauth_authorization_codes_permissions_check CHECK ((jsonb_typeof(permissions) = 'array'::text)),
    CONSTRAINT mcp_oauth_authorization_codes_redirect_uri_check CHECK (((octet_length(redirect_uri) >= 1) AND (octet_length(redirect_uri) <= 2048))),
    CONSTRAINT mcp_oauth_authorization_codes_resource_check CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048))),
    CONSTRAINT mcp_oauth_authorization_codes_subject_id_check CHECK (((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024))),
    CONSTRAINT mcp_oauth_authorization_codes_target_check CHECK (((workspace_id IS NULL) <> (organization_access IS NULL))),
    CONSTRAINT mcp_oauth_authorization_codes_tool_identities_check CHECK (((jsonb_typeof(tool_identities) = 'array'::text) AND (jsonb_array_length(tool_identities) <= 4096)))
);

CREATE TABLE mcp_oauth_authorization_requests (
    request_hash text NOT NULL,
    client_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    subject_id text NOT NULL,
    resource text NOT NULL,
    redirect_uri text NOT NULL,
    code_challenge text NOT NULL,
    state text,
    permissions jsonb NOT NULL,
    tool_identities jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_access jsonb,
    CONSTRAINT mcp_oauth_authorization_requests_code_challenge_check CHECK ((code_challenge ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT mcp_oauth_authorization_requests_permissions_check CHECK ((jsonb_typeof(permissions) = 'array'::text)),
    CONSTRAINT mcp_oauth_authorization_requests_redirect_uri_check CHECK (((octet_length(redirect_uri) >= 1) AND (octet_length(redirect_uri) <= 2048))),
    CONSTRAINT mcp_oauth_authorization_requests_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT mcp_oauth_authorization_requests_resource_check CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048))),
    CONSTRAINT mcp_oauth_authorization_requests_state_check CHECK (((state IS NULL) OR ((octet_length(state) >= 1) AND (octet_length(state) <= 1024)))),
    CONSTRAINT mcp_oauth_authorization_requests_subject_id_check CHECK (((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024))),
    CONSTRAINT mcp_oauth_authorization_requests_target_check CHECK (((workspace_id IS NULL) <> (organization_access IS NULL))),
    CONSTRAINT mcp_oauth_authorization_requests_tool_identities_check CHECK (((jsonb_typeof(tool_identities) = 'array'::text) AND (jsonb_array_length(tool_identities) <= 4096)))
);

CREATE TABLE mcp_oauth_refresh_tokens (
    token_hash text NOT NULL,
    family_id uuid NOT NULL,
    generation integer NOT NULL,
    client_id text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    subject_id text NOT NULL,
    resource text NOT NULL,
    permissions jsonb NOT NULL,
    tool_identities jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    organization_access jsonb,
    connected_at timestamp with time zone,
    CONSTRAINT mcp_oauth_refresh_tokens_generation_check CHECK ((generation > 0)),
    CONSTRAINT mcp_oauth_refresh_tokens_permissions_check CHECK ((jsonb_typeof(permissions) = 'array'::text)),
    CONSTRAINT mcp_oauth_refresh_tokens_resource_check CHECK (((octet_length(resource) >= 1) AND (octet_length(resource) <= 2048))),
    CONSTRAINT mcp_oauth_refresh_tokens_subject_id_check CHECK (((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024))),
    CONSTRAINT mcp_oauth_refresh_tokens_target_check CHECK (((workspace_id IS NULL) <> (organization_access IS NULL))),
    CONSTRAINT mcp_oauth_refresh_tokens_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT mcp_oauth_refresh_tokens_tool_identities_check CHECK (((jsonb_typeof(tool_identities) = 'array'::text) AND (jsonb_array_length(tool_identities) <= 4096)))
);

CREATE TABLE mcp_operations (
    operation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    source_turn_id uuid NOT NULL,
    source_attempt_id uuid NOT NULL,
    source_execution_generation integer NOT NULL,
    source_call_id text,
    principal_kind text NOT NULL,
    principal_id text NOT NULL,
    principal_membership_id uuid,
    principal_membership_revision bigint,
    server_id text NOT NULL,
    original_tool text NOT NULL,
    observer_tool text NOT NULL,
    argument_digest text NOT NULL,
    destination_digest text NOT NULL,
    authority_digest text NOT NULL,
    original_outcome text DEFAULT 'captured'::text NOT NULL,
    original_result jsonb,
    original_result_codec_version integer,
    observation_result jsonb,
    observation_result_codec_version integer,
    receipt_revision text,
    receipt_digest text,
    observation_claim_id uuid,
    observation_claim_attempt_id uuid,
    observation_claim_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    observed_at timestamp with time zone,
    CONSTRAINT mcp_operations_argument_digest_check CHECK ((argument_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT mcp_operations_authority_digest_check CHECK ((authority_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT mcp_operations_claim_check CHECK ((((observation_claim_id IS NULL) AND (observation_claim_attempt_id IS NULL) AND (observation_claim_expires_at IS NULL)) OR ((observation_claim_id IS NOT NULL) AND (observation_claim_attempt_id IS NOT NULL) AND (observation_claim_expires_at IS NOT NULL)))),
    CONSTRAINT mcp_operations_destination_digest_check CHECK ((destination_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT mcp_operations_observation_result_codec_version_check CHECK ((observation_result_codec_version = 1)),
    CONSTRAINT mcp_operations_observer_check CHECK ((original_tool <> observer_tool)),
    CONSTRAINT mcp_operations_observer_tool_check CHECK (((octet_length(observer_tool) >= 1) AND (octet_length(observer_tool) <= 512))),
    CONSTRAINT mcp_operations_original_check CHECK ((((original_outcome = 'completed'::text) = (original_result IS NOT NULL)) AND ((original_result IS NULL) OR ((jsonb_typeof(original_result) = 'object'::text) AND (octet_length((original_result)::text) <= 16777216))))),
    CONSTRAINT mcp_operations_original_outcome_check CHECK ((original_outcome = ANY (ARRAY['captured'::text, 'completed'::text, 'outcome_unknown'::text]))),
    CONSTRAINT mcp_operations_original_result_codec_version_check CHECK ((original_result_codec_version = 1)),
    CONSTRAINT mcp_operations_original_tool_check CHECK (((octet_length(original_tool) >= 1) AND (octet_length(original_tool) <= 512))),
    CONSTRAINT mcp_operations_principal_id_check CHECK (((octet_length(principal_id) >= 1) AND (octet_length(principal_id) <= 1024))),
    CONSTRAINT mcp_operations_principal_kind_check CHECK ((principal_kind = ANY (ARRAY['subject'::text, 'service'::text]))),
    CONSTRAINT mcp_operations_receipt_check CHECK ((((observation_result IS NULL) AND (receipt_revision IS NULL) AND (receipt_digest IS NULL) AND (observed_at IS NULL)) OR ((jsonb_typeof(observation_result) = 'object'::text) AND (receipt_revision IS NOT NULL) AND (receipt_digest IS NOT NULL) AND (observed_at IS NOT NULL) AND (octet_length((observation_result)::text) <= 16777216)))),
    CONSTRAINT mcp_operations_receipt_digest_check CHECK ((receipt_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT mcp_operations_receipt_revision_check CHECK (((octet_length(receipt_revision) >= 1) AND (octet_length(receipt_revision) <= 1024))),
    CONSTRAINT mcp_operations_server_id_check CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 512))),
    CONSTRAINT mcp_operations_source_call_id_check CHECK (((octet_length(source_call_id) >= 1) AND (octet_length(source_call_id) <= 1024))),
    CONSTRAINT mcp_operations_source_execution_generation_check CHECK ((source_execution_generation > 0))
);

ALTER TABLE ONLY mcp_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE memory_slack_publication_configurations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision integer NOT NULL,
    enabled boolean NOT NULL,
    connection_id uuid,
    slack_team_id text,
    slack_channel_id text,
    slack_channel_name text,
    auto_importances text[] DEFAULT ARRAY['major'::text] NOT NULL,
    review_importances text[] DEFAULT ARRAY['normal'::text] NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_slack_publication_configurations_actor_check CHECK (((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024))),
    CONSTRAINT memory_slack_publication_configurations_channel_name_check CHECK (((slack_channel_name IS NULL) OR ((octet_length(slack_channel_name) >= 1) AND (octet_length(slack_channel_name) <= 256)))),
    CONSTRAINT memory_slack_publication_configurations_destination_check CHECK (((NOT enabled) OR ((connection_id IS NOT NULL) AND ((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_channel_id) >= 1) AND (octet_length(slack_channel_id) <= 64))))),
    CONSTRAINT memory_slack_publication_configurations_policy_check CHECK (((auto_importances <@ ARRAY['major'::text, 'normal'::text, 'minor'::text]) AND (review_importances <@ ARRAY['major'::text, 'normal'::text, 'minor'::text]) AND (cardinality(auto_importances) <= 3) AND (cardinality(review_importances) <= 3) AND (NOT (auto_importances && review_importances)))),
    CONSTRAINT memory_slack_publication_configurations_revision_check CHECK ((revision > 0))
);

ALTER TABLE ONLY memory_slack_publication_configurations FORCE ROW LEVEL SECURITY;

CREATE TABLE memory_slack_publication_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    sequence integer NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    attempt_number integer NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    operation_id uuid NOT NULL,
    error_code text,
    retry_at timestamp with time zone,
    slack_channel_id text,
    slack_message_timestamp text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_slack_publication_receipts_actor_check CHECK (((actor_kind = ANY (ARRAY['human'::text, 'agent'::text, 'service'::text])) AND ((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 1024)))),
    CONSTRAINT memory_slack_publication_receipts_attempt_check CHECK (((sequence > 0) AND (attempt_number >= 0))),
    CONSTRAINT memory_slack_publication_receipts_error_check CHECK (((error_code IS NULL) OR ((octet_length(error_code) >= 1) AND (octet_length(error_code) <= 128)))),
    CONSTRAINT memory_slack_publication_receipts_kind_check CHECK ((kind = ANY (ARRAY['enqueued'::text, 'review_approved'::text, 'review_rejected'::text, 'delivery_claimed'::text, 'retry_scheduled'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text, 'manual_retry'::text]))),
    CONSTRAINT memory_slack_publication_receipts_provider_check CHECK ((((slack_channel_id IS NULL) = (slack_message_timestamp IS NULL)) AND ((slack_channel_id IS NULL) OR ((octet_length(slack_channel_id) >= 1) AND (octet_length(slack_channel_id) <= 64))) AND ((slack_message_timestamp IS NULL) OR ((octet_length(slack_message_timestamp) >= 1) AND (octet_length(slack_message_timestamp) <= 64))))),
    CONSTRAINT memory_slack_publication_receipts_state_check CHECK ((state = ANY (ARRAY['review_pending'::text, 'queued'::text, 'delivering'::text, 'retry_wait'::text, 'delivered'::text, 'rejected'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY memory_slack_publication_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE model_call_fact_reconciliation_candidates (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    source_key text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    batch_id uuid
);

ALTER TABLE ONLY model_call_fact_reconciliation_candidates FORCE ROW LEVEL SECURITY;

CREATE TABLE model_call_fact_reconciliation_progress (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    checkpoint jsonb,
    CONSTRAINT model_call_fact_reconciliation_progress_checkpoint_check CHECK (((checkpoint IS NULL) OR (jsonb_typeof(checkpoint) = 'object'::text)))
);

ALTER TABLE ONLY model_call_fact_reconciliation_progress FORCE ROW LEVEL SECURITY;

CREATE TABLE nested_agent_depth_configuration (
    singleton boolean DEFAULT true NOT NULL,
    max_nested_agent_depth integer NOT NULL,
    policy_source text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT nested_agent_depth_configuration_max_check CHECK (((max_nested_agent_depth >= 0) AND (max_nested_agent_depth <= 2147483647))),
    CONSTRAINT nested_agent_depth_configuration_singleton_check CHECK (singleton),
    CONSTRAINT nested_agent_depth_configuration_source_check CHECK ((policy_source = ANY (ARRAY['deployment'::text, 'default'::text])))
);

CREATE TABLE network_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    configuration jsonb NOT NULL,
    consistency jsonb NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    create_operation_id uuid NOT NULL,
    created_by_subject_id text NOT NULL,
    updated_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT network_routes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT network_routes_values_check CHECK ((((octet_length(name) >= 1) AND (octet_length(name) <= 200)) AND (name = btrim(name)) AND (jsonb_typeof(configuration) = 'object'::text) AND ((octet_length((configuration)::text) >= 2) AND (octet_length((configuration)::text) <= 65536)) AND (jsonb_typeof(consistency) = 'object'::text) AND ((octet_length((consistency)::text) >= 2) AND (octet_length((consistency)::text) <= 65536)) AND (version > 0) AND ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)) AND ((octet_length(updated_by_subject_id) >= 1) AND (octet_length(updated_by_subject_id) <= 1024))))
);

ALTER TABLE ONLY network_routes FORCE ROW LEVEL SECURITY;

CREATE TABLE new_session_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    resources jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text NOT NULL,
    reasoning_effort text NOT NULL,
    session_options jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    latency_mode text DEFAULT 'standard'::text NOT NULL,
    selected_project_channel_id uuid,
    selected_project_compute_snapshot jsonb,
    CONSTRAINT new_session_drafts_latency_mode_check CHECK ((latency_mode = ANY (ARRAY['standard'::text, 'priority'::text, 'fast'::text]))),
    CONSTRAINT new_session_drafts_project_provenance_check CHECK ((((selected_project_compute_snapshot IS NULL) AND (selected_project_channel_id IS NULL)) OR (jsonb_typeof(selected_project_compute_snapshot) = 'object'::text))),
    CONSTRAINT new_session_drafts_revision_check CHECK ((revision >= 1)),
    CONSTRAINT new_session_drafts_subject_check CHECK ((length(btrim(subject_id)) > 0))
);

ALTER TABLE ONLY new_session_drafts FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_agent_admin_access (
    account_id uuid NOT NULL,
    session_admin_access_allowed boolean DEFAULT false NOT NULL,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    chat_actions_allowed boolean DEFAULT true NOT NULL
);

ALTER TABLE ONLY organization_agent_admin_access FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_api_key_workspaces (
    api_key_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL
);

ALTER TABLE ONLY organization_api_key_workspaces FORCE ROW LEVEL SECURITY;

CREATE TABLE organization_codex_rotation_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    active_credential_id uuid,
    rotation_enabled boolean DEFAULT false NOT NULL,
    rotation_strategy text DEFAULT 'sharded'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY organization_codex_rotation_settings FORCE ROW LEVEL SECURITY;
