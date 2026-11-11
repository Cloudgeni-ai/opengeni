-- deployment-mode: rolling
-- Opengeni baseline part 4 of 22: the schema as of migration 0977,
-- replacing migrations 0000-0977 (see packages/db/src/migration-baseline.ts).
-- A fresh database runs every part; a database that applied all of 0000-0977
-- records the parts without running them. The runner replaces {{schema}},
-- {{schema_oid}}, {{owner}} and {{migrated_at}} with the migration session's
-- current schema, its OID, the current user and now().

CREATE TABLE session_turn_startup_milestones (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    milestone text NOT NULL,
    outcome text NOT NULL,
    canonical_source text NOT NULL,
    event_id uuid,
    occurred_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_turn_startup_milestones_canonical_source_chk CHECK ((((canonical_source = 'inserted_event'::text) AND (event_id IS NOT NULL) AND (occurred_at IS NOT NULL)) OR ((canonical_source = 'pre_ledger_history'::text) AND (outcome = 'completed'::text) AND (event_id IS NULL) AND (occurred_at IS NULL)))),
    CONSTRAINT session_turn_startup_milestones_checkpoint_chk CHECK (((outcome = 'completed'::text) OR (milestone = 'first_byte'::text))),
    CONSTRAINT session_turn_startup_milestones_milestone_chk CHECK ((milestone = ANY (ARRAY['queue'::text, 'provider_dispatch'::text, 'first_byte'::text]))),
    CONSTRAINT session_turn_startup_milestones_outcome_chk CHECK ((outcome = ANY (ARRAY['completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY session_turn_startup_milestones FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_turn_startup_milestones IS 'Per-turn startup SLO checkpoint ledger: one row per (turn, milestone, outcome). The transaction whose INSERT ... ON CONFLICT DO NOTHING returns the row is the canonical inserter and the sole metric receipt; recovery and replay conflict. pre_ledger_history rows seal a turn whose startup predates the ledger so it never re-observes a checkpoint.';

COMMENT ON COLUMN session_turn_startup_milestones.canonical_source IS 'inserted_event: event_id/occurred_at name the canonical checkpoint event inserted by the claiming transaction. pre_ledger_history: the checkpoint was (or may have been) durable before any ledger-aware writer touched the turn; identity is deliberately not recovered from session_events.';

COMMENT ON COLUMN session_turn_startup_milestones.occurred_at IS 'The canonical event''s own occurred_at; the receipt duration is measured from session_turns.created_at to this instant.';

CREATE TABLE session_turns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    trigger_event_id uuid NOT NULL,
    temporal_workflow_id text NOT NULL,
    status text NOT NULL,
    source text DEFAULT 'user'::text NOT NULL,
    "position" bigint NOT NULL,
    prompt text NOT NULL,
    resources jsonb DEFAULT '[]'::jsonb NOT NULL,
    tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    model text NOT NULL,
    reasoning_effort text NOT NULL,
    sandbox_backend text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    sandbox_os text,
    codemode_call_count integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    execution_generation integer DEFAULT 0 NOT NULL,
    active_attempt_id uuid,
    lineage jsonb DEFAULT '{}'::jsonb NOT NULL,
    cancelled_by text,
    cancel_reason text,
    tools_provided boolean DEFAULT false NOT NULL,
    initiator_kind text DEFAULT 'service'::text NOT NULL,
    initiator_subject_id text DEFAULT 'unattributed-legacy'::text NOT NULL,
    initiator_context jsonb DEFAULT '{"backfill": true}'::jsonb NOT NULL,
    model_context text,
    latency_mode text DEFAULT 'standard'::text NOT NULL,
    personal_connection_delegations jsonb DEFAULT '[]'::jsonb NOT NULL,
    initiating_human_subject_id text,
    prompt_codec_version integer,
    annotations jsonb DEFAULT '[]'::jsonb NOT NULL,
    codex_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    xai_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    goal_snapshot jsonb,
    scheduled_task_run_id uuid,
    personal_resource_attachment_summary jsonb,
    personal_resource_protocol_version integer DEFAULT 0 NOT NULL,
    prompt_routing text,
    mcp_account_bindings jsonb,
    surface text,
    claude_provider_account_authority_snapshot jsonb DEFAULT '{"scope": "workspace", "version": 1}'::jsonb NOT NULL,
    execution_context_turn_id uuid,
    subscription_authority jsonb,
    authority_inserted_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    connection_account_intent jsonb,
    CONSTRAINT session_turns_annotations_check CHECK (((jsonb_typeof(annotations) = 'array'::text) AND (octet_length((annotations)::text) <= 1048576))),
    CONSTRAINT session_turns_claude_authority_snapshot_chk CHECK (claude_provider_account_authority_snapshot_v1_valid(claude_provider_account_authority_snapshot)),
    CONSTRAINT session_turns_codex_authority_snapshot_chk CHECK (codex_provider_account_authority_snapshot_v1_valid(codex_provider_account_authority_snapshot)),
    CONSTRAINT session_turns_connection_account_intent_shape CHECK (opengeni_private.connection_account_intent_is_valid(connection_account_intent)),
    CONSTRAINT session_turns_goal_root_constraints_chk CHECK (((goal_snapshot IS NULL) OR ((goal_snapshot ->> 'state'::text) = 'none'::text) OR (NOT (goal_snapshot ? 'rootConstraints'::text)) OR ((jsonb_typeof((goal_snapshot -> 'rootConstraints'::text)) = 'array'::text) AND ((goal_snapshot -> 'rootConstraints'::text) = session_goal_normalize_root_constraints((goal_snapshot -> 'rootConstraints'::text)))))),
    CONSTRAINT session_turns_goal_snapshot_chk CHECK (((goal_snapshot IS NULL) OR ((jsonb_typeof(goal_snapshot) = 'object'::text) AND ((goal_snapshot ->> 'state'::text) = ANY (ARRAY['none'::text, 'active'::text, 'paused'::text, 'completed'::text])) AND (jsonb_typeof((goal_snapshot -> 'capturedAt'::text)) = 'string'::text) AND ((((goal_snapshot ->> 'state'::text) = 'none'::text) AND (((goal_snapshot - 'state'::text) - 'capturedAt'::text) = '{}'::jsonb)) OR (((goal_snapshot ->> 'state'::text) = ANY (ARRAY['active'::text, 'paused'::text, 'completed'::text])) AND (jsonb_typeof((goal_snapshot -> 'goalId'::text)) = 'string'::text) AND (jsonb_typeof((goal_snapshot -> 'objectiveRevision'::text)) = 'number'::text) AND ((goal_snapshot ->> 'objectiveRevision'::text) ~ '^[1-9][0-9]*$'::text) AND (jsonb_typeof((goal_snapshot -> 'text'::text)) = 'string'::text) AND (length((goal_snapshot ->> 'text'::text)) > 0) AND (octet_length((goal_snapshot ->> 'text'::text)) <= 8192) AND (((goal_snapshot -> 'successCriteria'::text) = 'null'::jsonb) OR ((jsonb_typeof((goal_snapshot -> 'successCriteria'::text)) = 'string'::text) AND (octet_length((goal_snapshot ->> 'successCriteria'::text)) <= 8192))) AND ((goal_snapshot ->> 'mutationPolicy'::text) = ANY (ARRAY['review_changes'::text, 'preserve_intent'::text, 'autonomous_adaptation'::text]))))))),
    CONSTRAINT session_turns_initiating_human_subject_id_chk CHECK (((initiating_human_subject_id IS NULL) OR ((length(btrim(initiating_human_subject_id)) >= 1) AND (length(btrim(initiating_human_subject_id)) <= 1024)))),
    CONSTRAINT session_turns_initiator_kind_check CHECK ((initiator_kind = ANY (ARRAY['subject'::text, 'service'::text]))),
    CONSTRAINT session_turns_latency_mode_check CHECK ((latency_mode = ANY (ARRAY['standard'::text, 'priority'::text, 'fast'::text]))),
    CONSTRAINT session_turns_mcp_account_bindings_check CHECK (((mcp_account_bindings IS NULL) OR (jsonb_typeof(mcp_account_bindings) = 'array'::text))),
    CONSTRAINT session_turns_model_context_check CHECK (((model_context IS NULL) OR opengeni_private.model_context_value_valid(model_context))),
    CONSTRAINT session_turns_personal_delegations_array_chk CHECK (((jsonb_typeof(personal_connection_delegations) = 'array'::text) AND (jsonb_array_length(personal_connection_delegations) <= 128))),
    CONSTRAINT session_turns_personal_resource_protocol_chk CHECK ((personal_resource_protocol_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT session_turns_prompt_routing_check CHECK (((prompt_routing IS NULL) OR (prompt_routing = ANY (ARRAY['accepted_for_execution'::text, 'queued_for_execution'::text, 'accepted_for_steering'::text])))),
    CONSTRAINT session_turns_queue_purity_check CHECK (((status <> 'queued'::text) OR (source = ANY (ARRAY['user'::text, 'api'::text])))),
    CONSTRAINT session_turns_sandbox_os_check CHECK (((sandbox_os IS NULL) OR (sandbox_os = ANY (ARRAY['linux'::text, 'macos'::text, 'windows'::text])))),
    CONSTRAINT session_turns_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'requires_action'::text, 'recovering'::text, 'waiting_capacity'::text, 'completed'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'withdrawn_for_edit'::text]))),
    CONSTRAINT session_turns_subscription_authority_v2_chk CHECK (((subscription_authority IS NULL) OR subscription_personal_authority_v2_valid(subscription_authority))),
    CONSTRAINT session_turns_surface_check CHECK (((surface IS NULL) OR (surface = ANY (ARRAY['web'::text, 'slack'::text, 'api_key'::text, 'embedded'::text, 'scheduled'::text, 'agent'::text, 'voice'::text, 'site'::text, 'automation'::text, 'mcp'::text, 'system'::text])))),
    CONSTRAINT session_turns_xai_authority_snapshot_chk CHECK (xai_provider_account_authority_snapshot_v1_valid(xai_provider_account_authority_snapshot))
);

ALTER TABLE ONLY session_turns FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN session_turns.model_context IS 'Application context for the exact accepted user message; copied into canonical model history at first claim.';

COMMENT ON COLUMN session_turns.codex_provider_account_authority_snapshot IS 'Opaque identifier-free Codex provider-account authority snapshot; inert until a later activation slice.';

COMMENT ON COLUMN session_turns.xai_provider_account_authority_snapshot IS 'Immutable identifier-free xAI provider-account authority snapshot for the accepted logical turn.';

COMMENT ON COLUMN session_turns.prompt_routing IS 'Immutable admission intent for human/API prompts. Null is rolling/legacy compatibility; status remains physical execution state.';

COMMENT ON COLUMN session_turns.surface IS 'Immutable product surface the turn request entered through. Analytics only, never authority. Null is rolling/legacy compatibility.';

COMMENT ON COLUMN session_turns.subscription_authority IS 'Nullable M3 v2 accepted-authority slot. The v1 Codex snapshot remains authoritative until drained cutover.';

CREATE TABLE session_variable_set_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    variable_set_id uuid NOT NULL,
    "position" integer NOT NULL,
    session_status text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_variable_set_attachments_position_check CHECK ((("position" >= 0) AND ("position" < 25))),
    CONSTRAINT session_variable_set_attachments_status_check CHECK ((session_status = ANY (ARRAY['queued'::text, 'running'::text, 'idle'::text, 'requires_action'::text, 'recovering'::text, 'waiting_capacity'::text, 'failed'::text, 'cancelled'::text])))
);

ALTER TABLE ONLY session_variable_set_attachments FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE session_variable_set_attachments IS 'FK-backed lifecycle-only projection of ordered session Variable Set selection; values never appear here.';

CREATE TABLE session_visibility_write_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL
);

ALTER TABLE ONLY session_visibility_write_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE session_work_claim_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    claim_id uuid NOT NULL,
    session_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    mutation_kind text NOT NULL,
    prior_revision integer,
    resulting_revision integer NOT NULL,
    subject_namespace text NOT NULL,
    subject_type text NOT NULL,
    canonical_key text NOT NULL,
    subject_digest text NOT NULL,
    display_label text,
    role text NOT NULL,
    state text NOT NULL,
    provenance text NOT NULL,
    version_kind text,
    version_value text,
    observed_at timestamp with time zone NOT NULL,
    claim_created_at timestamp with time zone NOT NULL,
    claim_updated_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    actor_session_id uuid,
    actor_turn_id uuid,
    actor_attempt_id uuid,
    actor_execution_generation integer,
    reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_work_claim_revisions_actor_check CHECK (((actor_kind = ANY (ARRAY['agent_attempt'::text, 'human'::text, 'integration'::text, 'system'::text])) AND ((octet_length(actor_subject_id) >= 1) AND (octet_length(actor_subject_id) <= 4096)) AND (((actor_kind = 'agent_attempt'::text) AND (actor_session_id IS NOT NULL) AND (actor_turn_id IS NOT NULL) AND (actor_attempt_id IS NOT NULL) AND (actor_execution_generation > 0)) OR ((actor_kind <> 'agent_attempt'::text) AND (actor_attempt_id IS NULL) AND (actor_execution_generation IS NULL))))),
    CONSTRAINT session_work_claim_revisions_hash_check CHECK (((input_hash ~ '^[0-9a-f]{64}$'::text) AND (subject_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT session_work_claim_revisions_mutation_check CHECK (((mutation_kind = ANY (ARRAY['created'::text, 'updated'::text, 'released'::text, 'superseded'::text, 'stale'::text])) AND (((mutation_kind = 'created'::text) AND (prior_revision IS NULL) AND (resulting_revision = 1)) OR ((mutation_kind <> 'created'::text) AND (prior_revision > 0) AND (resulting_revision = (prior_revision + 1)))))),
    CONSTRAINT session_work_claim_revisions_reason_check CHECK (((reason IS NULL) OR (reason = ANY (ARRAY['completed'::text, 'cancelled'::text, 'failed'::text, 'superseded'::text, 'no_longer_active'::text, 'corrected'::text, 'external_state_changed'::text, 'other'::text]))))
);

ALTER TABLE ONLY session_work_claim_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE session_work_claim_write_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL
);

ALTER TABLE ONLY session_work_claim_write_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE session_work_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    subject_namespace text NOT NULL,
    subject_type text NOT NULL,
    canonical_key text NOT NULL,
    subject_digest text NOT NULL,
    display_label text,
    role text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    provenance text NOT NULL,
    version_kind text,
    version_value text,
    observed_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    CONSTRAINT session_work_claims_digest_check CHECK ((subject_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT session_work_claims_key_check CHECK (((canonical_key = btrim(canonical_key)) AND (canonical_key = NORMALIZE(canonical_key, NFKC)) AND ((octet_length(canonical_key) >= 1) AND (octet_length(canonical_key) <= 512)) AND (canonical_key !~ '[[:cntrl:]]'::text))),
    CONSTRAINT session_work_claims_label_check CHECK (((display_label IS NULL) OR ((display_label = btrim(display_label)) AND (display_label = NORMALIZE(display_label, NFKC)) AND ((octet_length(display_label) >= 1) AND (octet_length(display_label) <= 256)) AND (display_label !~ '[[:cntrl:]]'::text)))),
    CONSTRAINT session_work_claims_lifecycle_check CHECK ((((state = 'active'::text) AND (settled_at IS NULL)) OR ((state <> 'active'::text) AND (settled_at IS NOT NULL)))),
    CONSTRAINT session_work_claims_namespace_check CHECK (((subject_namespace = lower(btrim(subject_namespace))) AND ((octet_length(subject_namespace) >= 1) AND (octet_length(subject_namespace) <= 64)) AND (subject_namespace ~ '^[a-z0-9]([a-z0-9._:-]{0,62}[a-z0-9])?$'::text))),
    CONSTRAINT session_work_claims_provenance_check CHECK ((provenance = ANY (ARRAY['explicit_agent'::text, 'user_api'::text, 'trusted_integration'::text, 'session_resource'::text, 'system_lifecycle'::text]))),
    CONSTRAINT session_work_claims_revision_check CHECK ((revision > 0)),
    CONSTRAINT session_work_claims_role_check CHECK ((role = ANY (ARRAY['working'::text, 'reviewing'::text, 'monitoring'::text, 'delivering'::text]))),
    CONSTRAINT session_work_claims_state_check CHECK ((state = ANY (ARRAY['active'::text, 'released'::text, 'superseded'::text, 'stale'::text]))),
    CONSTRAINT session_work_claims_timestamp_check CHECK (((observed_at >= created_at) AND (updated_at >= observed_at) AND ((settled_at IS NULL) OR (settled_at >= created_at)))),
    CONSTRAINT session_work_claims_type_check CHECK ((subject_type = ANY (ARRAY['repository'::text, 'branch'::text, 'pull_request'::text, 'issue'::text, 'artifact'::text, 'release'::text, 'ci_run'::text, 'other'::text]))),
    CONSTRAINT session_work_claims_version_check CHECK ((((version_kind IS NULL) AND (version_value IS NULL)) OR ((version_kind = ANY (ARRAY['git_commit'::text, 'branch_head'::text, 'pull_request_head'::text, 'artifact_version'::text, 'release_version'::text, 'ci_run'::text, 'other'::text])) AND (version_value = btrim(version_value)) AND (version_value = NORMALIZE(version_value, NFKC)) AND ((octet_length(version_value) >= 1) AND (octet_length(version_value) <= 256)) AND (version_value !~ '[[:cntrl:]]'::text))))
);

ALTER TABLE ONLY session_work_claims FORCE ROW LEVEL SECURITY;

CREATE TABLE session_workflow_wake_outbox (
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    temporal_workflow_id text NOT NULL,
    wake_revision bigint DEFAULT 1 NOT NULL,
    delivered_revision bigint DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    control_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT session_workflow_wake_outbox_control_revision_check CHECK (((control_revision >= 0) AND (control_revision <= wake_revision) AND (control_revision <= '9007199254740991'::bigint))),
    CONSTRAINT session_workflow_wake_outbox_revision_check CHECK (((wake_revision > 0) AND (delivered_revision >= 0) AND (delivered_revision <= wake_revision))),
    CONSTRAINT session_workflow_wake_outbox_revision_safe_check CHECK (((wake_revision <= '9007199254740991'::bigint) AND (delivered_revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY session_workflow_wake_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE site_abuse_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    hostname text NOT NULL,
    category text NOT NULL,
    message text DEFAULT ''::text NOT NULL,
    contact_email text,
    reporter_principal text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_abuse_reports_category_check CHECK ((category = ANY (ARRAY['phishing'::text, 'malware'::text, 'spam'::text, 'illegal'::text, 'harassment'::text, 'copyright'::text, 'other'::text]))),
    CONSTRAINT site_abuse_reports_contact_email_check CHECK (((contact_email IS NULL) OR (char_length(contact_email) <= 320))),
    CONSTRAINT site_abuse_reports_hostname_check CHECK (((char_length(hostname) >= 1) AND (char_length(hostname) <= 253))),
    CONSTRAINT site_abuse_reports_message_check CHECK ((char_length(message) <= 4000)),
    CONSTRAINT site_abuse_reports_reporter_principal_check CHECK (((char_length(reporter_principal) >= 1) AND (char_length(reporter_principal) <= 300))),
    CONSTRAINT site_abuse_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'dismissed'::text, 'actioned'::text])))
);

ALTER TABLE ONLY site_abuse_reports FORCE ROW LEVEL SECURITY;

CREATE TABLE site_auth_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    code_hash text NOT NULL,
    hostname text NOT NULL,
    code_challenge text NOT NULL,
    redirect_uri text NOT NULL,
    subject_id text NOT NULL,
    viewer_kind text NOT NULL,
    email text,
    display_name text,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_auth_codes_code_challenge_check CHECK ((code_challenge ~ '^[A-Za-z0-9_-]{43}$'::text)),
    CONSTRAINT site_auth_codes_code_hash_check CHECK ((code_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT site_auth_codes_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) <= 300))),
    CONSTRAINT site_auth_codes_email_check CHECK (((email IS NULL) OR (char_length(email) <= 320))),
    CONSTRAINT site_auth_codes_hostname_check CHECK (((char_length(hostname) >= 1) AND (char_length(hostname) <= 253))),
    CONSTRAINT site_auth_codes_redirect_uri_check CHECK (((char_length(redirect_uri) >= 1) AND (char_length(redirect_uri) <= 2048))),
    CONSTRAINT site_auth_codes_subject_id_check CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 300))),
    CONSTRAINT site_auth_codes_viewer_kind_check CHECK ((viewer_kind = ANY (ARRAY['member'::text, 'invited'::text, 'user'::text])))
);

ALTER TABLE ONLY site_auth_codes FORCE ROW LEVEL SECURITY;

CREATE TABLE site_auth_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    account_label text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    origins jsonb NOT NULL,
    login_url text,
    verification_url_prefixes jsonb NOT NULL,
    authorities jsonb NOT NULL,
    methods jsonb NOT NULL,
    preferred_identity_id uuid,
    preferred_placement jsonb,
    preferred_network_route_id uuid,
    health_policy jsonb NOT NULL,
    verification_state text DEFAULT 'unknown'::text NOT NULL,
    last_verified_at timestamp with time zone,
    last_verified_url text,
    repair_code text,
    version bigint DEFAULT 1 NOT NULL,
    create_operation_id uuid NOT NULL,
    created_by_subject_id text NOT NULL,
    updated_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_checked_at timestamp with time zone,
    next_check_at timestamp with time zone,
    health_sequence bigint DEFAULT 0 NOT NULL,
    maintenance_operation_id uuid,
    maintenance_action text,
    maintenance_due_at timestamp with time zone,
    maintenance_claimed_at timestamp with time zone,
    maintenance_session_id uuid,
    maintenance_started_at timestamp with time zone,
    CONSTRAINT site_auth_connections_health_check CHECK (((((health_sequence = 0) AND (last_checked_at IS NULL)) OR ((health_sequence > 0) AND (last_checked_at IS NOT NULL))) AND (((status = 'active'::text) AND ((health_policy ->> 'mode'::text) = 'maintained'::text) AND (next_check_at IS NOT NULL)) OR ((NOT ((status = 'active'::text) AND ((health_policy ->> 'mode'::text) = 'maintained'::text))) AND (next_check_at IS NULL))))),
    CONSTRAINT site_auth_connections_maintenance_check CHECK ((((maintenance_operation_id IS NULL) AND (maintenance_action IS NULL) AND (maintenance_due_at IS NULL) AND (maintenance_claimed_at IS NULL) AND (maintenance_session_id IS NULL) AND (maintenance_started_at IS NULL)) OR ((status = 'active'::text) AND ((health_policy ->> 'mode'::text) = 'maintained'::text) AND (maintenance_operation_id IS NOT NULL) AND (maintenance_action = ANY (ARRAY['health_check'::text, 'repair'::text])) AND (maintenance_due_at IS NOT NULL) AND (maintenance_claimed_at IS NOT NULL) AND (maintenance_session_id IS NOT NULL) AND ((maintenance_started_at IS NULL) OR (maintenance_started_at >= maintenance_due_at))))),
    CONSTRAINT site_auth_connections_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT site_auth_connections_values_check CHECK ((((octet_length(name) >= 1) AND (octet_length(name) <= 200)) AND (name = btrim(name)) AND ((octet_length(account_label) >= 1) AND (octet_length(account_label) <= 200)) AND (account_label = btrim(account_label)) AND (jsonb_typeof(origins) = 'array'::text) AND ((octet_length((origins)::text) >= 3) AND (octet_length((origins)::text) <= 65536)) AND ((login_url IS NULL) OR ((octet_length(login_url) >= 1) AND (octet_length(login_url) <= 16384))) AND (jsonb_typeof(verification_url_prefixes) = 'array'::text) AND ((octet_length((verification_url_prefixes)::text) >= 2) AND (octet_length((verification_url_prefixes)::text) <= 65536)) AND (jsonb_typeof(authorities) = 'array'::text) AND ((octet_length((authorities)::text) >= 3) AND (octet_length((authorities)::text) <= 65536)) AND (jsonb_typeof(methods) = 'array'::text) AND ((octet_length((methods)::text) >= 3) AND (octet_length((methods)::text) <= 65536)) AND ((preferred_placement IS NULL) OR ((jsonb_typeof(preferred_placement) = 'object'::text) AND ((octet_length((preferred_placement)::text) >= 2) AND (octet_length((preferred_placement)::text) <= 65536)))) AND (jsonb_typeof(health_policy) = 'object'::text) AND ((octet_length((health_policy)::text) >= 2) AND (octet_length((health_policy)::text) <= 65536)) AND ((last_verified_url IS NULL) OR ((octet_length(last_verified_url) >= 1) AND (octet_length(last_verified_url) <= 16384))) AND ((repair_code IS NULL) OR ((octet_length(repair_code) >= 1) AND (octet_length(repair_code) <= 512))) AND (version > 0) AND ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)) AND ((octet_length(updated_by_subject_id) >= 1) AND (octet_length(updated_by_subject_id) <= 1024)))),
    CONSTRAINT site_auth_connections_verification_check CHECK ((((verification_state = 'verified'::text) AND (last_verified_at IS NOT NULL) AND (last_verified_url IS NOT NULL) AND (repair_code IS NULL)) OR ((verification_state = 'unknown'::text) AND (last_verified_at IS NULL) AND (last_verified_url IS NULL) AND (repair_code IS NULL)) OR ((verification_state = ANY (ARRAY['needs_repair'::text, 'failed'::text])) AND (repair_code IS NOT NULL)))),
    CONSTRAINT site_auth_connections_verification_state_check CHECK ((verification_state = ANY (ARRAY['unknown'::text, 'verified'::text, 'needs_repair'::text, 'failed'::text])))
);

ALTER TABLE ONLY site_auth_connections FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    name text NOT NULL,
    access_mode text NOT NULL,
    private_records boolean DEFAULT false NOT NULL,
    json_schema jsonb,
    indexed_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    unique_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    record_count bigint DEFAULT 0 NOT NULL,
    record_bytes bigint DEFAULT 0 NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    guest_access text DEFAULT 'none'::text NOT NULL,
    CONSTRAINT site_data_collections_access_mode_check CHECK ((access_mode = ANY (ARRAY['shared'::text, 'shared_read'::text, 'per_viewer'::text, 'append_only'::text]))),
    CONSTRAINT site_data_collections_guest_access_check CHECK ((guest_access = ANY (ARRAY['none'::text, 'read'::text, 'append'::text, 'own'::text]))),
    CONSTRAINT site_data_collections_indexed_fields_check CHECK ((jsonb_typeof(indexed_fields) = 'array'::text)),
    CONSTRAINT site_data_collections_json_schema_check CHECK (((json_schema IS NULL) OR (octet_length((json_schema)::text) <= 65536))),
    CONSTRAINT site_data_collections_name_check CHECK ((name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'::text)),
    CONSTRAINT site_data_collections_private_mode_check CHECK (((NOT private_records) OR (access_mode = 'per_viewer'::text))),
    CONSTRAINT site_data_collections_record_bytes_check CHECK ((record_bytes >= 0)),
    CONSTRAINT site_data_collections_record_count_check CHECK ((record_count >= 0)),
    CONSTRAINT site_data_collections_unique_fields_check CHECK ((jsonb_typeof(unique_fields) = 'array'::text))
);

ALTER TABLE ONLY site_data_collections FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    name text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    object_key text NOT NULL,
    scope text NOT NULL,
    owner_principal text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_data_files_content_type_check CHECK (((char_length(content_type) >= 1) AND (char_length(content_type) <= 255))),
    CONSTRAINT site_data_files_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 255))),
    CONSTRAINT site_data_files_owner_principal_check CHECK (((char_length(owner_principal) >= 1) AND (char_length(owner_principal) <= 300))),
    CONSTRAINT site_data_files_scope_check CHECK ((scope = ANY (ARRAY['shared'::text, 'private'::text]))),
    CONSTRAINT site_data_files_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT site_data_files_size_bytes_check CHECK ((size_bytes >= 0))
);

ALTER TABLE ONLY site_data_files FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_rate_windows (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    principal_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    operations integer NOT NULL,
    CONSTRAINT site_data_rate_windows_operations_check CHECK ((operations >= 0)),
    CONSTRAINT site_data_rate_windows_principal_key_check CHECK (((char_length(principal_key) >= 1) AND (char_length(principal_key) <= 300)))
);

ALTER TABLE ONLY site_data_rate_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_record_values (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    record_id uuid NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    scope text DEFAULT ''::text NOT NULL,
    value_hash text,
    value_text text COLLATE pg_catalog."C",
    value_num double precision,
    CONSTRAINT site_data_record_values_kind_check CHECK ((kind = ANY (ARRAY['unique'::text, 'index'::text]))),
    CONSTRAINT site_data_record_values_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 1024))),
    CONSTRAINT site_data_record_values_shape_check CHECK (((kind = 'unique'::text) = (value_hash IS NOT NULL))),
    CONSTRAINT site_data_record_values_value_hash_check CHECK (((value_hash IS NULL) OR (value_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT site_data_record_values_value_text_check CHECK (((value_text IS NULL) OR (char_length(value_text) <= 256)))
);

ALTER TABLE ONLY site_data_record_values FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    key_scope text DEFAULT ''::text NOT NULL,
    record_key text,
    data jsonb NOT NULL,
    owner_principal text NOT NULL,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    size_bytes integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_data_records_data_check CHECK ((jsonb_typeof(data) = 'object'::text)),
    CONSTRAINT site_data_records_owner_principal_check CHECK (((char_length(owner_principal) >= 1) AND (char_length(owner_principal) <= 300))),
    CONSTRAINT site_data_records_record_key_check CHECK (((record_key IS NULL) OR ((char_length(record_key) >= 1) AND (char_length(record_key) <= 256)))),
    CONSTRAINT site_data_records_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT site_data_records_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY site_data_records FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_usage (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    collection_count integer DEFAULT 0 NOT NULL,
    record_count bigint DEFAULT 0 NOT NULL,
    record_bytes bigint DEFAULT 0 NOT NULL,
    file_count integer DEFAULT 0 NOT NULL,
    file_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_data_usage_collection_count_check CHECK ((collection_count >= 0)),
    CONSTRAINT site_data_usage_file_bytes_check CHECK ((file_bytes >= 0)),
    CONSTRAINT site_data_usage_file_count_check CHECK ((file_count >= 0)),
    CONSTRAINT site_data_usage_record_bytes_check CHECK ((record_bytes >= 0)),
    CONSTRAINT site_data_usage_record_count_check CHECK ((record_count >= 0))
);

ALTER TABLE ONLY site_data_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_validation_windows (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    validation_micros bigint NOT NULL,
    CONSTRAINT site_data_validation_windows_validation_micros_check CHECK ((validation_micros >= 0))
);

ALTER TABLE ONLY site_data_validation_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE site_data_workspace_validation_windows (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    validation_micros bigint NOT NULL,
    CONSTRAINT site_data_workspace_validation_windows_validation_micros_check CHECK ((validation_micros >= 0))
);

ALTER TABLE ONLY site_data_workspace_validation_windows FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE site_host_generation_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE site_hostname_holds (
    label text NOT NULL,
    site_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    reason text NOT NULL,
    held_by text NOT NULL,
    kind text DEFAULT 'platform'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_hostname_holds_expiry_check CHECK (((kind = 'release'::text) = (expires_at IS NOT NULL))),
    CONSTRAINT site_hostname_holds_held_by_check CHECK (((char_length(held_by) >= 1) AND (char_length(held_by) <= 300))),
    CONSTRAINT site_hostname_holds_kind_check CHECK ((kind = ANY (ARRAY['platform'::text, 'release'::text]))),
    CONSTRAINT site_hostname_holds_label_check CHECK ((label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'::text)),
    CONSTRAINT site_hostname_holds_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 2000)))
);

ALTER TABLE ONLY site_hostname_holds FORCE ROW LEVEL SECURITY;

CREATE TABLE site_hostnames (
    label text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    released_at timestamp with time zone,
    CONSTRAINT site_hostnames_label_check CHECK ((label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'::text))
);

ALTER TABLE ONLY site_hostnames FORCE ROW LEVEL SECURITY;

CREATE TABLE site_limit_profiles (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    overrides jsonb,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_limit_profiles_kind_check CHECK ((kind = ANY (ARRAY['free'::text, 'credits'::text, 'unlimited'::text, 'custom'::text]))),
    CONSTRAINT site_limit_profiles_overrides_check CHECK (((overrides IS NULL) OR (jsonb_typeof(overrides) = 'object'::text)))
);

ALTER TABLE ONLY site_limit_profiles FORCE ROW LEVEL SECURITY;

CREATE TABLE site_opens (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    site_id uuid NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_opens_subject_id_check CHECK (((length(subject_id) >= 1) AND (length(subject_id) <= 512)))
);

ALTER TABLE ONLY site_opens FORCE ROW LEVEL SECURITY;

CREATE TABLE site_platform_brake (
    period_start date NOT NULL,
    alerted_at timestamp with time zone,
    engaged_at timestamp with time zone,
    engaged_by text,
    engaged_reason text,
    lifted_at timestamp with time zone,
    lifted_by text,
    lift_reason text,
    last_estimate_micros bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_platform_brake_engaged_by_check CHECK (((engaged_by IS NULL) OR (engaged_by = ANY (ARRAY['auto'::text, 'operator'::text])))),
    CONSTRAINT site_platform_brake_engaged_reason_check CHECK (((engaged_reason IS NULL) OR (char_length(engaged_reason) <= 2000))),
    CONSTRAINT site_platform_brake_last_estimate_micros_check CHECK ((last_estimate_micros >= 0)),
    CONSTRAINT site_platform_brake_lift_reason_check CHECK (((lift_reason IS NULL) OR (char_length(lift_reason) <= 2000))),
    CONSTRAINT site_platform_brake_lifted_by_check CHECK (((lifted_by IS NULL) OR ((char_length(lifted_by) >= 1) AND (char_length(lifted_by) <= 300))))
);

ALTER TABLE ONLY site_platform_brake FORCE ROW LEVEL SECURITY;

CREATE TABLE site_platform_storage (
    workspace_id uuid NOT NULL,
    storage_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_platform_storage_storage_bytes_check CHECK ((storage_bytes >= 0))
);

ALTER TABLE ONLY site_platform_storage FORCE ROW LEVEL SECURITY;

CREATE TABLE site_platform_totals (
    period_start date NOT NULL,
    shard smallint NOT NULL,
    requests bigint DEFAULT 0 NOT NULL,
    sql_rows_read bigint DEFAULT 0 NOT NULL,
    sql_rows_written bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_platform_totals_requests_check CHECK ((requests >= 0)),
    CONSTRAINT site_platform_totals_shard_check CHECK (((shard >= 0) AND (shard <= 7))),
    CONSTRAINT site_platform_totals_sql_rows_read_check CHECK ((sql_rows_read >= 0)),
    CONSTRAINT site_platform_totals_sql_rows_written_check CHECK ((sql_rows_written >= 0))
);

ALTER TABLE ONLY site_platform_totals FORCE ROW LEVEL SECURITY;

CREATE TABLE site_platform_usage (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    period_start date NOT NULL,
    requests bigint DEFAULT 0 NOT NULL,
    sql_rows_read bigint DEFAULT 0 NOT NULL,
    sql_rows_written bigint DEFAULT 0 NOT NULL,
    storage_bytes bigint DEFAULT 0 NOT NULL,
    storage_peak_bytes bigint DEFAULT 0 NOT NULL,
    charged_micros bigint DEFAULT 0 NOT NULL,
    shadow_micros bigint DEFAULT 0 NOT NULL,
    charge_seq integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_platform_usage_charge_seq_check CHECK ((charge_seq >= 0)),
    CONSTRAINT site_platform_usage_charged_micros_check CHECK ((charged_micros >= 0)),
    CONSTRAINT site_platform_usage_requests_check CHECK ((requests >= 0)),
    CONSTRAINT site_platform_usage_shadow_micros_check CHECK ((shadow_micros >= 0)),
    CONSTRAINT site_platform_usage_sql_rows_read_check CHECK ((sql_rows_read >= 0)),
    CONSTRAINT site_platform_usage_sql_rows_written_check CHECK ((sql_rows_written >= 0)),
    CONSTRAINT site_platform_usage_storage_bytes_check CHECK ((storage_bytes >= 0)),
    CONSTRAINT site_platform_usage_storage_peak_bytes_check CHECK ((storage_peak_bytes >= 0))
);

ALTER TABLE ONLY site_platform_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE site_publications (
    site_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    label text NOT NULL,
    access text DEFAULT 'members'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    noindex boolean DEFAULT true NOT NULL,
    agent_enabled boolean DEFAULT true NOT NULL,
    agent_model text,
    agent_instructions text,
    agent_tools jsonb,
    agent_guest_tools boolean DEFAULT false NOT NULL,
    limit_profile_kind text,
    limit_overrides jsonb,
    invited_emails jsonb DEFAULT '[]'::jsonb NOT NULL,
    suspended_at timestamp with time zone,
    suspended_by text,
    suspended_reason text,
    suspended_by_subject text,
    generation bigint DEFAULT nextval('site_host_generation_seq'::regclass) NOT NULL,
    edge_synced_generation bigint DEFAULT 0 NOT NULL,
    scan_status text DEFAULT 'none'::text NOT NULL,
    scan_findings jsonb,
    scanned_version_id uuid,
    scanned_at timestamp with time zone,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_publications_access_check CHECK ((access = ANY (ARRAY['members'::text, 'invited'::text, 'public'::text]))),
    CONSTRAINT site_publications_agent_instructions_check CHECK (((agent_instructions IS NULL) OR (char_length(agent_instructions) <= 8000))),
    CONSTRAINT site_publications_agent_model_check CHECK (((agent_model IS NULL) OR ((char_length(agent_model) >= 1) AND (char_length(agent_model) <= 200)))),
    CONSTRAINT site_publications_agent_tools_check CHECK (((agent_tools IS NULL) OR ((jsonb_typeof(agent_tools) = 'array'::text) AND (jsonb_array_length(agent_tools) <= 100)))),
    CONSTRAINT site_publications_edge_synced_generation_check CHECK ((edge_synced_generation >= 0)),
    CONSTRAINT site_publications_generation_check CHECK ((generation > 0)),
    CONSTRAINT site_publications_invited_emails_check CHECK (((jsonb_typeof(invited_emails) = 'array'::text) AND (jsonb_array_length(invited_emails) <= 500))),
    CONSTRAINT site_publications_label_check CHECK ((label ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'::text)),
    CONSTRAINT site_publications_limit_overrides_check CHECK (((limit_overrides IS NULL) OR (jsonb_typeof(limit_overrides) = 'object'::text))),
    CONSTRAINT site_publications_limit_profile_kind_check CHECK (((limit_profile_kind IS NULL) OR (limit_profile_kind = ANY (ARRAY['free'::text, 'credits'::text, 'unlimited'::text, 'custom'::text])))),
    CONSTRAINT site_publications_scan_findings_check CHECK (((scan_findings IS NULL) OR (jsonb_typeof(scan_findings) = 'array'::text))),
    CONSTRAINT site_publications_scan_status_check CHECK ((scan_status = ANY (ARRAY['none'::text, 'clean'::text, 'flagged'::text, 'error'::text]))),
    CONSTRAINT site_publications_status_check CHECK ((status = ANY (ARRAY['active'::text, 'unpublished'::text, 'suspended'::text]))),
    CONSTRAINT site_publications_suspended_by_check CHECK (((suspended_by IS NULL) OR (suspended_by = ANY (ARRAY['owner'::text, 'admin'::text, 'platform'::text])))),
    CONSTRAINT site_publications_suspended_reason_check CHECK (((suspended_reason IS NULL) OR (char_length(suspended_reason) <= 2000))),
    CONSTRAINT site_publications_suspension_check CHECK (((status = 'suspended'::text) = ((suspended_at IS NOT NULL) AND (suspended_by IS NOT NULL))))
);

ALTER TABLE ONLY site_publications FORCE ROW LEVEL SECURITY;

CREATE TABLE site_runtime_conversations (
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    viewer_principal text NOT NULL,
    viewer_kind text NOT NULL,
    tool_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    version_id uuid,
    turns integer DEFAULT 0 NOT NULL,
    metered_micros bigint DEFAULT 0 NOT NULL,
    limit_micros bigint,
    reserved_micros bigint DEFAULT 0 NOT NULL,
    reserved_day date,
    reserved_month date,
    admissions bigint DEFAULT 0 NOT NULL,
    swept_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    budget_key text DEFAULT '*'::text NOT NULL,
    reservation_windows_complete boolean DEFAULT false NOT NULL,
    viewer_email text,
    pending_admission_id uuid,
    pending_admission_until timestamp with time zone,
    CONSTRAINT site_runtime_conversations_admissions_check CHECK ((admissions >= 0)),
    CONSTRAINT site_runtime_conversations_limit_micros_check CHECK (((limit_micros IS NULL) OR (limit_micros >= 0))),
    CONSTRAINT site_runtime_conversations_metered_micros_check CHECK ((metered_micros >= 0)),
    CONSTRAINT site_runtime_conversations_reserved_micros_check CHECK ((reserved_micros >= 0)),
    CONSTRAINT site_runtime_conversations_tool_ids_check CHECK (((jsonb_typeof(tool_ids) = 'array'::text) AND (jsonb_array_length(tool_ids) <= 100))),
    CONSTRAINT site_runtime_conversations_turns_check CHECK ((turns >= 0)),
    CONSTRAINT site_runtime_conversations_viewer_kind_check CHECK ((viewer_kind = ANY (ARRAY['member'::text, 'invited'::text, 'user'::text, 'guest'::text]))),
    CONSTRAINT site_runtime_conversations_viewer_principal_check CHECK (((char_length(viewer_principal) >= 1) AND (char_length(viewer_principal) <= 300)))
);

ALTER TABLE ONLY site_runtime_conversations FORCE ROW LEVEL SECURITY;

CREATE TABLE site_runtime_rate_windows (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    principal_key text NOT NULL,
    bucket text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    operations integer NOT NULL,
    CONSTRAINT site_runtime_rate_windows_bucket_check CHECK ((bucket = ANY (ARRAY['requests'::text, 'guest_writes'::text, 'reports'::text, 'sign_in'::text]))),
    CONSTRAINT site_runtime_rate_windows_operations_check CHECK ((operations >= 0)),
    CONSTRAINT site_runtime_rate_windows_principal_key_check CHECK (((char_length(principal_key) >= 1) AND (char_length(principal_key) <= 300)))
);

ALTER TABLE ONLY site_runtime_rate_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE site_runtime_usage (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    principal_key text NOT NULL,
    period text NOT NULL,
    period_start date NOT NULL,
    conversations integer DEFAULT 0 NOT NULL,
    agent_micros bigint DEFAULT 0 NOT NULL,
    reserved_micros bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_runtime_usage_agent_micros_check CHECK ((agent_micros >= 0)),
    CONSTRAINT site_runtime_usage_conversations_check CHECK ((conversations >= 0)),
    CONSTRAINT site_runtime_usage_period_check CHECK ((period = ANY (ARRAY['day'::text, 'month'::text]))),
    CONSTRAINT site_runtime_usage_principal_key_check CHECK (((char_length(principal_key) >= 1) AND (char_length(principal_key) <= 300))),
    CONSTRAINT site_runtime_usage_reserved_micros_check CHECK ((reserved_micros >= 0))
);

ALTER TABLE ONLY site_runtime_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE site_session_access (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    session_id uuid NOT NULL,
    owner_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY site_session_access FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sidebar_states (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    site_id uuid NOT NULL,
    pinned_at timestamp with time zone,
    archived_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_sidebar_states_subject_id_check CHECK (((length(subject_id) >= 1) AND (length(subject_id) <= 512)))
);

ALTER TABLE ONLY site_sidebar_states FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sql_databases (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    migration_count integer DEFAULT 0 NOT NULL,
    rebuilt_at timestamp with time zone,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_sql_databases_migration_count_check CHECK ((migration_count >= 0))
);

ALTER TABLE ONLY site_sql_databases FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sql_migrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    ordinal integer NOT NULL,
    name text NOT NULL,
    sql text NOT NULL,
    checksum text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_sql_migrations_checksum_check CHECK ((checksum ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT site_sql_migrations_name_check CHECK ((name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'::text)),
    CONSTRAINT site_sql_migrations_ordinal_check CHECK ((ordinal > 0)),
    CONSTRAINT site_sql_migrations_sql_check CHECK (((char_length(sql) >= 1) AND (char_length(sql) <= 2097152)))
);

ALTER TABLE ONLY site_sql_migrations FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sql_queries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    name text NOT NULL,
    sql text NOT NULL,
    mode text NOT NULL,
    params jsonb DEFAULT '[]'::jsonb NOT NULL,
    audience text NOT NULL,
    description text,
    max_rows integer,
    created_by text NOT NULL,
    updated_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_sql_queries_audience_check CHECK ((audience = ANY (ARRAY['everyone'::text, 'signed_in'::text, 'managers'::text]))),
    CONSTRAINT site_sql_queries_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT site_sql_queries_max_rows_check CHECK (((max_rows IS NULL) OR ((max_rows >= 1) AND (max_rows <= 5000)))),
    CONSTRAINT site_sql_queries_mode_check CHECK ((mode = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT site_sql_queries_name_check CHECK ((name ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'::text)),
    CONSTRAINT site_sql_queries_params_check CHECK ((jsonb_typeof(params) = 'array'::text)),
    CONSTRAINT site_sql_queries_sql_check CHECK (((char_length(sql) >= 1) AND (char_length(sql) <= 16384)))
);

ALTER TABLE ONLY site_sql_queries FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sql_rate_windows (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    principal_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    operations integer NOT NULL,
    CONSTRAINT site_sql_rate_windows_operations_check CHECK ((operations >= 0)),
    CONSTRAINT site_sql_rate_windows_principal_key_check CHECK (((char_length(principal_key) >= 1) AND (char_length(principal_key) <= 300)))
);

ALTER TABLE ONLY site_sql_rate_windows FORCE ROW LEVEL SECURITY;

CREATE TABLE site_sql_usage (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    storage_bytes bigint DEFAULT 0 NOT NULL,
    storage_peak_bytes bigint DEFAULT 0 NOT NULL,
    usage_month date DEFAULT (date_trunc('month'::text, now()))::date NOT NULL,
    rows_read_month bigint DEFAULT 0 NOT NULL,
    rows_written_month bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT site_sql_usage_rows_read_month_check CHECK ((rows_read_month >= 0)),
    CONSTRAINT site_sql_usage_rows_written_month_check CHECK ((rows_written_month >= 0)),
    CONSTRAINT site_sql_usage_storage_bytes_check CHECK ((storage_bytes >= 0)),
    CONSTRAINT site_sql_usage_storage_peak_bytes_check CHECK ((storage_peak_bytes >= 0))
);

ALTER TABLE ONLY site_sql_usage FORCE ROW LEVEL SECURITY;

CREATE TABLE site_viewer_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    site_id uuid NOT NULL,
    token_hash text NOT NULL,
    subject_id text NOT NULL,
    viewer_kind text NOT NULL,
    email text,
    display_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    view_as text,
    CONSTRAINT site_viewer_sessions_display_name_check CHECK (((display_name IS NULL) OR (char_length(display_name) <= 300))),
    CONSTRAINT site_viewer_sessions_email_check CHECK (((email IS NULL) OR (char_length(email) <= 320))),
    CONSTRAINT site_viewer_sessions_subject_id_check CHECK (((char_length(subject_id) >= 1) AND (char_length(subject_id) <= 300))),
    CONSTRAINT site_viewer_sessions_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT site_viewer_sessions_viewer_kind_check CHECK ((viewer_kind = ANY (ARRAY['member'::text, 'invited'::text, 'user'::text])))
);

ALTER TABLE ONLY site_viewer_sessions FORCE ROW LEVEL SECURITY;

CREATE TABLE skill_config_conversion_receipts (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    conversion_version text DEFAULT '0426-v1'::text NOT NULL,
    actor text DEFAULT 'service:skill-migration:0433'::text NOT NULL,
    original_configuration jsonb NOT NULL,
    original_hash text NOT NULL,
    replacement_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT skill_config_conversion_receipts_actor_check CHECK ((actor = 'service:skill-migration:0433'::text)),
    CONSTRAINT skill_config_conversion_receipts_check CHECK ((original_hash = encode(sha256(convert_to((original_configuration)::text, 'UTF8'::name)), 'hex'::text))),
    CONSTRAINT skill_config_conversion_receipts_conversion_version_check CHECK ((conversion_version = '0426-v1'::text)),
    CONSTRAINT skill_config_conversion_receipts_replacement_hash_check CHECK ((replacement_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT skill_config_conversion_receipts_source_kind_check CHECK ((source_kind = ANY (ARRAY['session'::text, 'workspace-pack'::text])))
);

ALTER TABLE ONLY skill_config_conversion_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE skill_source_bindings (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    plugin_id uuid NOT NULL,
    facet_key text NOT NULL,
    preference_id uuid NOT NULL,
    skill_facet_id uuid NOT NULL
);

ALTER TABLE ONLY skill_source_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE skill_write_receipts (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    fingerprint text NOT NULL,
    actor jsonb NOT NULL,
    receipt jsonb NOT NULL,
    activation_event_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY skill_write_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_api_rate_limits (
    scope_hash text NOT NULL,
    next_allowed_at timestamp with time zone NOT NULL,
    CONSTRAINT slack_api_rate_limits_scope_hash_check CHECK ((scope_hash ~ '^[0-9a-f]{64}$'::text))
);

CREATE TABLE slack_bot_delete_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    principal_type text NOT NULL,
    principal_id text NOT NULL,
    tool_name text NOT NULL,
    channel_id text NOT NULL,
    message_timestamp text NOT NULL,
    request_digest text NOT NULL,
    status text NOT NULL,
    claim_holder_id uuid,
    claim_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_failure_code text,
    slack_channel_id text,
    slack_message_timestamp text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_bot_delete_operations_completion_check CHECK ((((status <> 'completed'::text) AND (slack_channel_id IS NULL) AND (slack_message_timestamp IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (claim_holder_id IS NULL) AND (claim_expires_at IS NULL) AND (slack_channel_id IS NOT NULL) AND (slack_message_timestamp IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT slack_bot_delete_operations_identity_check CHECK (((tool_name = 'slack_bot_delete_message'::text) AND ((length(channel_id) >= 1) AND (length(channel_id) <= 64)) AND ((length(message_timestamp) >= 1) AND (length(message_timestamp) <= 64)) AND (request_digest ~ '^[0-9a-f]{64}$'::text) AND (attempt_count > 0) AND ((claim_holder_id IS NULL) = (claim_expires_at IS NULL)))),
    CONSTRAINT slack_bot_delete_operations_principal_check CHECK (((principal_type = ANY (ARRAY['subject'::text, 'service'::text])) AND ((length(principal_id) >= 1) AND (length(principal_id) <= 512)))),
    CONSTRAINT slack_bot_delete_operations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'provider_started'::text, 'outcome_unknown'::text, 'completed'::text])))
);

ALTER TABLE ONLY slack_bot_delete_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_bot_post_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    client_message_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id text NOT NULL,
    request_digest text NOT NULL,
    status text NOT NULL,
    claim_holder_id uuid,
    claim_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_failure_code text,
    slack_channel_id text,
    slack_message_timestamp text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    claim_mode text,
    CONSTRAINT slack_bot_post_operations_completion_check CHECK ((((status <> 'completed'::text) AND (slack_channel_id IS NULL) AND (slack_message_timestamp IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (claim_holder_id IS NULL) AND (claim_expires_at IS NULL) AND (claim_mode IS NULL) AND (slack_channel_id IS NOT NULL) AND (slack_message_timestamp IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT slack_bot_post_operations_identity_check CHECK (((client_message_id = operation_id) AND ((length(target_id) >= 1) AND (length(target_id) <= 64)) AND (request_digest ~ '^[0-9a-f]{64}$'::text) AND (attempt_count > 0) AND (((claim_holder_id IS NULL) AND (claim_expires_at IS NULL) AND (claim_mode IS NULL)) OR ((claim_holder_id IS NOT NULL) AND (claim_expires_at IS NOT NULL) AND (((claim_mode = 'send'::text) AND (status = ANY (ARRAY['pending'::text, 'provider_started'::text]))) OR ((claim_mode = 'reconcile'::text) AND (status = 'outcome_unknown'::text))))))),
    CONSTRAINT slack_bot_post_operations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'provider_started'::text, 'outcome_unknown'::text, 'completed'::text]))),
    CONSTRAINT slack_bot_post_operations_target_kind_check CHECK ((target_kind = ANY (ARRAY['channel'::text, 'user'::text])))
);

ALTER TABLE ONLY slack_bot_post_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_bot_update_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    slack_channel_id text NOT NULL,
    slack_message_timestamp text NOT NULL,
    request_digest text NOT NULL,
    status text NOT NULL,
    claim_holder_id uuid,
    claim_expires_at timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_failure_code text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_bot_update_operations_bounds_check CHECK ((((octet_length(slack_channel_id) >= 1) AND (octet_length(slack_channel_id) <= 64)) AND ((octet_length(slack_message_timestamp) >= 1) AND (octet_length(slack_message_timestamp) <= 64)) AND (request_digest ~ '^[0-9a-f]{64}$'::text) AND (status = ANY (ARRAY['provider_started'::text, 'completed'::text])) AND (attempt_count > 0) AND ((claim_holder_id IS NULL) = (claim_expires_at IS NULL)) AND (((status = 'provider_started'::text) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (claim_holder_id IS NULL) AND (claim_expires_at IS NULL) AND (completed_at IS NOT NULL)))))
);

ALTER TABLE ONLY slack_bot_update_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_bot_user_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    subject_id text NOT NULL,
    linked_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_task_hint_interaction_id uuid,
    CONSTRAINT slack_bot_user_links_identity_check CHECK ((((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_user_id) >= 1) AND (octet_length(slack_user_id) <= 64)) AND ((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024)) AND ((octet_length(linked_by_subject_id) >= 1) AND (octet_length(linked_by_subject_id) <= 1024))))
);

ALTER TABLE ONLY slack_bot_user_links FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_channel_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_channel_id text NOT NULL,
    target_account_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    decided_by_subject_id text NOT NULL,
    decided_by_slack_user_id text NOT NULL,
    source text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_channel_routes_bounds_check CHECK ((((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_channel_id) >= 1) AND (octet_length(slack_channel_id) <= 64)) AND ((octet_length(decided_by_subject_id) >= 1) AND (octet_length(decided_by_subject_id) <= 1024)) AND ((octet_length(decided_by_slack_user_id) >= 1) AND (octet_length(decided_by_slack_user_id) <= 64)) AND (source = ANY (ARRAY['picker'::text, 'admin'::text])) AND (version > 0))),
    CONSTRAINT slack_channel_routes_same_account_check CHECK ((target_account_id = account_id))
);

ALTER TABLE ONLY slack_channel_routes FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_channel_routes IS 'Per-channel Slack workspace routing within one organization; home tenancy owns the row, target tenancy owns the session.';

CREATE TABLE slack_installation_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_team_name text NOT NULL,
    bot_id text NOT NULL,
    bot_user_id text NOT NULL,
    bot_display_name text NOT NULL,
    state text NOT NULL,
    quarantine_reason text,
    version integer DEFAULT 1 NOT NULL,
    created_by_subject_id text,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_installation_bindings_identity_check CHECK ((((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_team_name) >= 1) AND (octet_length(slack_team_name) <= 256)) AND ((octet_length(bot_id) >= 1) AND (octet_length(bot_id) <= 64)) AND ((octet_length(bot_user_id) >= 1) AND (octet_length(bot_user_id) <= 64)) AND (bot_display_name = ANY (ARRAY['Opengeni'::text, 'Opengeni Staging'::text, 'OpenGeni'::text, 'OpenGeni Staging'::text])))),
    CONSTRAINT slack_installation_bindings_quarantine_check CHECK ((((state = 'active'::text) AND (quarantine_reason IS NULL)) OR ((state = 'quarantined'::text) AND (length(btrim(quarantine_reason)) > 0)))),
    CONSTRAINT slack_installation_bindings_state_check CHECK ((state = ANY (ARRAY['active'::text, 'quarantined'::text]))),
    CONSTRAINT slack_installation_bindings_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY slack_installation_bindings FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_installation_bindings IS 'Secret-free Slack team to OpenGeni account/workspace routing authority; conflicts are quarantined, never guessed.';

CREATE TABLE slack_interaction_action_handles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    interaction_id uuid NOT NULL,
    session_id uuid NOT NULL,
    session_event_sequence integer NOT NULL,
    action_kind text NOT NULL,
    action_key text NOT NULL,
    target_id text,
    target_value text,
    authorized_subject_id text NOT NULL,
    authorized_slack_user_id text NOT NULL,
    message_operation_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    expires_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_interaction_action_handles_bounds_check CHECK (((session_event_sequence >= 0) AND ((octet_length(action_kind) >= 1) AND (octet_length(action_kind) <= 64)) AND ((octet_length(action_key) >= 1) AND (octet_length(action_key) <= 512)) AND ((target_id IS NULL) OR ((octet_length(target_id) >= 1) AND (octet_length(target_id) <= 512))) AND ((target_value IS NULL) OR ((octet_length(target_value) >= 1) AND (octet_length(target_value) <= 1024))) AND ((octet_length(authorized_subject_id) >= 1) AND (octet_length(authorized_subject_id) <= 512)) AND ((octet_length(authorized_slack_user_id) >= 1) AND (octet_length(authorized_slack_user_id) <= 64)) AND (action_kind = ANY (ARRAY['approval_approve'::text, 'approval_reject'::text, 'human_input_select'::text, 'human_input_skip'::text, 'session_status'::text, 'session_pause'::text, 'session_resume'::text, 'shared_result_publish'::text])) AND (status = ANY (ARRAY['pending'::text, 'completed'::text, 'stale'::text])) AND ((result IS NULL) OR ((octet_length(result) >= 1) AND (octet_length(result) <= 64))) AND (((status = 'pending'::text) AND (result IS NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['completed'::text, 'stale'::text])) AND (result IS NOT NULL) AND (completed_at IS NOT NULL)))))
);

ALTER TABLE ONLY slack_interaction_action_handles FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_interaction_progress_deliveries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    interaction_id uuid NOT NULL,
    session_event_sequence integer NOT NULL,
    slot integer NOT NULL,
    operation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_interaction_progress_deliveries_bounds_check CHECK (((session_event_sequence > 0) AND ((slot >= 1) AND (slot <= 3))))
);

ALTER TABLE ONLY slack_interaction_progress_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_route_prompt_options (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    prompt_id uuid NOT NULL,
    candidate_account_id uuid NOT NULL,
    candidate_workspace_id uuid NOT NULL,
    candidate_label text NOT NULL,
    "position" integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_route_prompt_options_bounds_check CHECK ((((octet_length(candidate_label) >= 1) AND (octet_length(candidate_label) <= 128)) AND ("position" >= 0))),
    CONSTRAINT slack_route_prompt_options_same_account_check CHECK ((candidate_account_id = account_id))
);

ALTER TABLE ONLY slack_route_prompt_options FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_route_prompt_options IS 'Offered picker workspaces; the row id is the Slack button value and is a prompt-time snapshot, never authority.';

CREATE TABLE slack_route_prompts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    inbox_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    slack_channel_id text NOT NULL,
    slack_message_ts text NOT NULL,
    provider_event_id text NOT NULL,
    trigger_kind text NOT NULL,
    request_text text NOT NULL,
    has_files boolean DEFAULT false NOT NULL,
    slack_thread_ts text,
    message_operation_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    answered_target_account_id uuid,
    answered_target_workspace_id uuid,
    answered_by_subject_id text,
    answered_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_route_prompts_answer_check CHECK ((((status = 'answered'::text) = (answered_target_workspace_id IS NOT NULL)) AND ((answered_target_account_id IS NULL) = (answered_target_workspace_id IS NULL)) AND ((answered_target_account_id IS NULL) OR (answered_target_account_id = account_id)) AND ((answered_target_workspace_id IS NULL) = (answered_at IS NULL)))),
    CONSTRAINT slack_route_prompts_bounds_check CHECK ((((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_user_id) >= 1) AND (octet_length(slack_user_id) <= 64)) AND ((octet_length(slack_channel_id) >= 1) AND (octet_length(slack_channel_id) <= 64)) AND ((octet_length(slack_message_ts) >= 1) AND (octet_length(slack_message_ts) <= 64)) AND ((octet_length(provider_event_id) >= 1) AND (octet_length(provider_event_id) <= 256)) AND ((octet_length(request_text) >= 1) AND (octet_length(request_text) <= 12000)) AND ((slack_thread_ts IS NULL) OR ((octet_length(slack_thread_ts) >= 1) AND (octet_length(slack_thread_ts) <= 64))) AND ((answered_by_subject_id IS NULL) OR ((octet_length(answered_by_subject_id) >= 1) AND (octet_length(answered_by_subject_id) <= 1024))))),
    CONSTRAINT slack_route_prompts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'answered'::text, 'expired'::text, 'cancelled'::text]))),
    CONSTRAINT slack_route_prompts_trigger_check CHECK ((trigger_kind = ANY (ARRAY['app_mention'::text, 'dm'::text, 'reaction'::text, 'slash_command'::text, 'message_shortcut'::text, 'thread_reply'::text, 'block_action'::text])))
);

ALTER TABLE ONLY slack_route_prompts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_route_prompts IS 'Pending first-use Slack workspace picker plus its bounded original request; the answer arrives as its own block_action event.';

CREATE TABLE slack_shared_task_origins (
    interaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    session_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    source_channel_id text NOT NULL,
    source_thread_ts text NOT NULL,
    initiating_slack_user_id text NOT NULL,
    policy_revision_id uuid NOT NULL,
    policy_hash text NOT NULL,
    policy_activation_version bigint NOT NULL,
    publication_mode text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_account_id uuid,
    policy_workspace_id uuid,
    CONSTRAINT slack_shared_task_origins_bounds_chk CHECK ((((length(slack_team_id) >= 1) AND (length(slack_team_id) <= 128)) AND ((length(source_channel_id) >= 1) AND (length(source_channel_id) <= 128)) AND ((length(source_thread_ts) >= 1) AND (length(source_thread_ts) <= 64)) AND ((length(initiating_slack_user_id) >= 1) AND (length(initiating_slack_user_id) <= 128)) AND (policy_hash ~ '^[0-9a-f]{64}$'::text) AND (policy_activation_version > 0) AND (publication_mode = ANY (ARRAY['never'::text, 'approval_required'::text, 'allow'::text])))),
    CONSTRAINT slack_shared_task_origins_policy_home_chk CHECK (((policy_account_id IS NULL) = (policy_workspace_id IS NULL)))
);

ALTER TABLE ONLY slack_shared_task_origins FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN slack_shared_task_origins.policy_workspace_id IS 'Home tenancy of the frozen Slack task policy revision; null on rows written before Slack workspace routing.';

CREATE TABLE slack_task_policy_activation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    activation_version bigint NOT NULL,
    old_revision_id uuid,
    old_revision bigint,
    old_policy_hash text,
    new_revision_id uuid NOT NULL,
    new_revision bigint NOT NULL,
    new_policy_hash text NOT NULL,
    actor_subject_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_task_policy_events_audit_chk CHECK ((((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)) AND ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 4096)))),
    CONSTRAINT slack_task_policy_events_new_revision_chk CHECK (((new_revision > 0) AND (new_policy_hash ~ '^[0-9a-f]{64}$'::text) AND (activation_version > 0))),
    CONSTRAINT slack_task_policy_events_old_revision_chk CHECK ((((old_revision_id IS NULL) AND (old_revision IS NULL) AND (old_policy_hash IS NULL)) OR ((old_revision_id IS NOT NULL) AND (old_revision > 0) AND (old_policy_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT slack_task_policy_events_receipt_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY slack_task_policy_activation_events FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_task_policy_heads (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    revision bigint NOT NULL,
    policy_hash text NOT NULL,
    activation_version bigint NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_task_policy_heads_version_chk CHECK (((revision > 0) AND (activation_version > 0) AND (policy_hash ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY slack_task_policy_heads FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE slack_task_policy_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE slack_task_policy_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision bigint DEFAULT nextval('slack_task_policy_revision_seq'::regclass) NOT NULL,
    policy jsonb NOT NULL,
    policy_hash text NOT NULL,
    supersedes_revision_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_task_policy_revisions_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT slack_task_policy_revisions_policy_chk CHECK ((slack_task_policy_valid(policy) AND (policy_hash = slack_task_policy_hash(policy)))),
    CONSTRAINT slack_task_policy_revisions_receipt_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT slack_task_policy_revisions_revision_chk CHECK ((revision > 0))
);

ALTER TABLE ONLY slack_task_policy_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE slack_user_dm_routes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    target_account_id uuid NOT NULL,
    target_workspace_id uuid NOT NULL,
    decided_by_subject_id text NOT NULL,
    decided_by_slack_user_id text NOT NULL,
    source text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_user_dm_routes_bounds_check CHECK ((((octet_length(slack_team_id) >= 1) AND (octet_length(slack_team_id) <= 64)) AND ((octet_length(slack_user_id) >= 1) AND (octet_length(slack_user_id) <= 64)) AND ((octet_length(decided_by_subject_id) >= 1) AND (octet_length(decided_by_subject_id) <= 1024)) AND ((octet_length(decided_by_slack_user_id) >= 1) AND (octet_length(decided_by_slack_user_id) <= 64)) AND (source = ANY (ARRAY['picker'::text, 'admin'::text])) AND (version > 0))),
    CONSTRAINT slack_user_dm_routes_same_account_check CHECK ((target_account_id = account_id))
);

ALTER TABLE ONLY slack_user_dm_routes FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_user_dm_routes IS 'Per-Slack-human direct-message workspace routing; absent a row a DM derives that human own personal workspace.';

CREATE TABLE slack_user_link_access_request_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    request_id uuid NOT NULL,
    actor_subject_id text NOT NULL,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    expected_version integer NOT NULL,
    result_version integer NOT NULL,
    result_status text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_user_link_access_request_operations_identity_check CHECK ((((length(actor_subject_id) >= 1) AND (length(actor_subject_id) <= 512)) AND ((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200)) AND (idempotency_key = btrim(idempotency_key)) AND (length(request_digest) = 64) AND (request_digest ~ '^[0-9a-f]{64}$'::text) AND (expected_version > 0) AND (result_version = (expected_version + 1)) AND (operation = ANY (ARRAY['request'::text, 'cancel'::text, 'approve'::text, 'deny'::text])) AND (result_status = ANY (ARRAY['pending'::text, 'completed'::text, 'denied'::text, 'cancelled'::text])) AND (jsonb_typeof(result) = 'object'::text) AND (result ?& ARRAY['id'::text, 'workspaceId'::text, 'workspaceDisplayName'::text, 'subjectLabel'::text, 'status'::text, 'version'::text, 'expiresAt'::text, 'requestedAt'::text, 'decidedAt'::text, 'completedAt'::text, 'createdAt'::text, 'updatedAt'::text]) AND ((result - ARRAY['id'::text, 'workspaceId'::text, 'workspaceDisplayName'::text, 'subjectLabel'::text, 'status'::text, 'version'::text, 'expiresAt'::text, 'requestedAt'::text, 'decidedAt'::text, 'completedAt'::text, 'createdAt'::text, 'updatedAt'::text]) = '{}'::jsonb) AND (jsonb_typeof((result -> 'id'::text)) = 'string'::text) AND (jsonb_typeof((result -> 'workspaceId'::text)) = 'string'::text) AND (jsonb_typeof((result -> 'workspaceDisplayName'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((result -> 'subjectLabel'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((result -> 'status'::text)) = 'string'::text) AND (jsonb_typeof((result -> 'version'::text)) = 'number'::text) AND (jsonb_typeof((result -> 'expiresAt'::text)) = 'string'::text) AND (jsonb_typeof((result -> 'requestedAt'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((result -> 'decidedAt'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((result -> 'completedAt'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (jsonb_typeof((result -> 'createdAt'::text)) = 'string'::text) AND (jsonb_typeof((result -> 'updatedAt'::text)) = 'string'::text) AND ((result ->> 'id'::text) = (request_id)::text) AND ((result ->> 'workspaceId'::text) = (workspace_id)::text) AND ((result ->> 'status'::text) = result_status) AND ((result -> 'version'::text) = to_jsonb(result_version))))
);

ALTER TABLE ONLY slack_user_link_access_request_operations FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_user_link_access_request_operations IS 'Append-only CAS and idempotency receipts for Slack identity-link access decisions.';

CREATE TABLE slack_user_link_access_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    token_digest text NOT NULL,
    connection_id uuid NOT NULL,
    slack_team_id text NOT NULL,
    slack_user_id text NOT NULL,
    subject_id text NOT NULL,
    subject_label text,
    status text DEFAULT 'prepared'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    requested_at timestamp with time zone,
    decided_at timestamp with time zone,
    decision_by_subject_id text,
    approved_role text,
    approved_permissions jsonb,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slack_user_link_access_requests_identity_check CHECK (((length(token_digest) = 64) AND (token_digest ~ '^[0-9a-f]{64}$'::text) AND ((length(slack_team_id) >= 1) AND (length(slack_team_id) <= 64)) AND ((length(slack_user_id) >= 1) AND (length(slack_user_id) <= 64)) AND ((length(subject_id) >= 1) AND (length(subject_id) <= 512)) AND ((subject_label IS NULL) OR ((length(subject_label) >= 1) AND (length(subject_label) <= 512))) AND (version > 0))),
    CONSTRAINT slack_user_link_access_requests_lifecycle_check CHECK ((((status = 'prepared'::text) AND (requested_at IS NULL) AND (decided_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'pending'::text) AND (requested_at IS NOT NULL) AND (decided_at IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (completed_at IS NOT NULL)) OR ((status = ANY (ARRAY['denied'::text, 'cancelled'::text, 'expired'::text])) AND (decided_at IS NOT NULL) AND (completed_at IS NULL)))),
    CONSTRAINT slack_user_link_access_requests_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'pending'::text, 'completed'::text, 'denied'::text, 'cancelled'::text, 'expired'::text])))
);

ALTER TABLE ONLY slack_user_link_access_requests FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE slack_user_link_access_requests IS 'Token-free, subject-bound lifecycle for signed Slack identity-link workspace access.';

CREATE TABLE social_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    provider text NOT NULL,
    account_handle text NOT NULL,
    account_name text,
    external_account_id text,
    status text DEFAULT 'connected'::text NOT NULL,
    scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
    credential_ref text,
    token_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_encrypted text,
    subject_id text,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT social_connections_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY social_connections FORCE ROW LEVEL SECURITY;

CREATE TABLE social_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider text NOT NULL,
    external_post_id text,
    url text,
    author_handle text,
    text text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY social_posts FORCE ROW LEVEL SECURITY;

CREATE TABLE stripe_webhook_events (
    id text NOT NULL,
    type text NOT NULL,
    livemode text DEFAULT 'false'::text NOT NULL,
    payload jsonb NOT NULL,
    processed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE subscription_apps_designations (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_subject_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_apps_designations_check CHECK (((version > 0) AND ((length(btrim(updated_by_subject_id)) >= 1) AND (length(btrim(updated_by_subject_id)) <= 1024))))
);

ALTER TABLE ONLY subscription_apps_designations FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_capacity_waiters (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    provider text NOT NULL,
    wait_reason text NOT NULL,
    policy_hash text,
    reset_kind text,
    refresh_attempt integer DEFAULT 0 NOT NULL,
    resumed_update_id uuid,
    earliest_reset_at timestamp with time zone,
    generation bigint DEFAULT 1 NOT NULL,
    wake_revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    waiter_id uuid DEFAULT gen_random_uuid() NOT NULL,
    observed_wake_revision bigint DEFAULT 0 NOT NULL,
    next_check_at timestamp with time zone,
    blocked_turn_generation bigint,
    goal_id uuid,
    goal_version bigint,
    last_wake_reason text,
    candidate_providers text[],
    CONSTRAINT subscription_capacity_waiters_candidates_bounded CHECK (((candidate_providers IS NULL) OR ((cardinality(candidate_providers) <= 32) AND (COALESCE(array_ndims(candidate_providers), 1) = 1) AND (array_position(candidate_providers, NULL::text) IS NULL)))),
    CONSTRAINT subscription_capacity_waiters_check CHECK (((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND ((length(btrim(wait_reason)) >= 1) AND (length(btrim(wait_reason)) <= 128)))),
    CONSTRAINT subscription_capacity_waiters_check1 CHECK (((refresh_attempt >= 0) AND (generation > 0) AND (wake_revision > 0)))
);

ALTER TABLE ONLY subscription_capacity_waiters FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_capacity_wake_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    waiter_id uuid NOT NULL,
    generation bigint NOT NULL,
    wake_revision bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_generation bigint DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    last_error text,
    CONSTRAINT subscription_capacity_wake_outbox_check CHECK (((generation > 0) AND (wake_revision > 0) AND (attempt_count >= 0) AND (claim_generation >= 0)))
);

ALTER TABLE ONLY subscription_capacity_wake_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_connection_aliases (
    account_id uuid NOT NULL,
    provider text NOT NULL,
    alias_connection_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_connection_aliases_check CHECK ((alias_connection_id <> connection_id)),
    CONSTRAINT subscription_connection_aliases_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])))
);

ALTER TABLE ONLY subscription_connection_aliases FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_connection_assignment_policies (
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    inference_pool text NOT NULL,
    allocator_enabled boolean DEFAULT true NOT NULL,
    allowed_model_ids text[],
    excluded_models text[] DEFAULT '{}'::text[] NOT NULL,
    managed_by_workspace_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_connection_assignment_policie_inference_pool_check CHECK ((inference_pool = ANY (ARRAY['workspace'::text, 'organization'::text])))
);

ALTER TABLE ONLY subscription_connection_assignment_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_connection_people (
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL
);

ALTER TABLE ONLY subscription_connection_people FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_connection_quota (
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    quota jsonb DEFAULT '{"windows": [], "modelCooldowns": {}}'::jsonb NOT NULL,
    selection_count bigint DEFAULT 0 NOT NULL,
    last_selected_at timestamp with time zone,
    observed_refresh_generation bigint,
    revision bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    model_catalog_slugs text[],
    model_catalog_refresh_generation bigint,
    model_catalog_observed_at timestamp with time zone,
    model_catalog_expires_at timestamp with time zone,
    CONSTRAINT subscription_connection_quota_check CHECK (((jsonb_typeof(quota) = 'object'::text) AND (jsonb_typeof((quota -> 'windows'::text)) = 'array'::text) AND (jsonb_typeof((quota -> 'modelCooldowns'::text)) = 'object'::text) AND (selection_count >= 0) AND (revision > 0))),
    CONSTRAINT subscription_connection_quota_observed_refresh_generation_check CHECK (((observed_refresh_generation IS NULL) OR (observed_refresh_generation > 0))),
    CONSTRAINT subscription_model_catalog_observation_chk CHECK ((((model_catalog_slugs IS NULL) AND (model_catalog_refresh_generation IS NULL) AND (model_catalog_observed_at IS NULL) AND (model_catalog_expires_at IS NULL)) OR ((model_catalog_slugs IS NOT NULL) AND (model_catalog_refresh_generation IS NOT NULL) AND (model_catalog_refresh_generation > 0) AND (model_catalog_observed_at IS NOT NULL) AND (model_catalog_expires_at IS NOT NULL) AND (model_catalog_expires_at > model_catalog_observed_at))))
);

ALTER TABLE ONLY subscription_connection_quota FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_connection_workspaces (
    account_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    workspace_id uuid NOT NULL
);

ALTER TABLE ONLY subscription_connection_workspaces FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_leases (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider text NOT NULL,
    holder_id text NOT NULL,
    generation bigint NOT NULL,
    leased_until timestamp with time zone NOT NULL,
    CONSTRAINT subscription_leases_check CHECK (((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND ((length(btrim(holder_id)) >= 1) AND (length(btrim(holder_id)) <= 256)) AND (generation > 0)))
);

ALTER TABLE ONLY subscription_leases FORCE ROW LEVEL SECURITY;

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
    leased_until timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id text,
    transport_attempt integer,
    request_reserved_at timestamp with time zone,
    request_outcome text,
    request_observed_at timestamp with time zone,
    CONSTRAINT subscription_operation_leases_check CHECK ((((length(btrim(holder_id)) >= 1) AND (length(btrim(holder_id)) <= 256)) AND (generation > 0))),
    CONSTRAINT subscription_operation_leases_check1 CHECK (((turn_id IS NULL) OR (session_id IS NOT NULL))),
    CONSTRAINT subscription_operation_leases_kind_chk CHECK (((operation_kind = ANY (ARRAY['image'::text, 'video'::text, 'realtime'::text, 'transcription'::text, 'model'::text, 'credential_request'::text, 'apps'::text, 'completion'::text, 'session_title'::text])) AND ((operation_kind <> ALL (ARRAY['apps'::text, 'completion'::text])) OR (provider = 'codex'::text)) AND ((operation_kind <> 'session_title'::text) OR (turn_id IS NOT NULL)))),
    CONSTRAINT subscription_operation_leases_provider_check CHECK ((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text]))),
    CONSTRAINT subscription_operation_leases_reference_chk CHECK ((((turn_id IS NULL) OR (session_id IS NOT NULL)) AND ((session_id IS NOT NULL) OR ((turn_id IS NULL) AND (operation_kind = ANY (ARRAY['transcription'::text, 'credential_request'::text, 'apps'::text, 'completion'::text])))) AND ((operation_kind <> 'model'::text) OR (turn_id IS NOT NULL)))),
    CONSTRAINT subscription_operation_request_shape_chk CHECK ((((request_id IS NULL) AND (transport_attempt IS NULL) AND (request_reserved_at IS NULL) AND (request_outcome IS NULL) AND (request_observed_at IS NULL)) OR ((request_id IS NOT NULL) AND (transport_attempt IS NOT NULL) AND (request_outcome IS NOT NULL) AND ((length(request_id) >= 1) AND (length(request_id) <= 512)) AND (transport_attempt > 0) AND (request_reserved_at IS NOT NULL) AND (request_outcome = ANY (ARRAY['reserved'::text, 'response_received'::text, 'refused'::text, 'unknown'::text])))))
);

ALTER TABLE ONLY subscription_operation_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_person_preferences (
    account_id uuid NOT NULL,
    organization_membership_id uuid NOT NULL,
    personal_fallback_opt_in boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_person_preferences_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY subscription_person_preferences FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_provider_cutovers (
    account_id uuid NOT NULL,
    provider text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_subject_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_provider_cutovers_check CHECK (((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND (version > 0)))
);

ALTER TABLE ONLY subscription_provider_cutovers FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_session_bindings (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    provider text NOT NULL,
    connection_id uuid,
    model_id text NOT NULL,
    choice text DEFAULT 'automatic'::text NOT NULL,
    only_this_model boolean DEFAULT false NOT NULL,
    last_model_call_at timestamp with time zone,
    last_switch_reason text,
    version bigint DEFAULT 1 NOT NULL,
    CONSTRAINT subscription_session_bindings_check CHECK (((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND (choice = ANY (ARRAY['automatic'::text, 'explicit'::text])) AND (version > 0))),
    CONSTRAINT subscription_session_bindings_choice_check CHECK ((choice = ANY (ARRAY['automatic'::text, 'explicit'::text]))),
    CONSTRAINT subscription_session_bindings_last_switch_reason_check CHECK (((last_switch_reason IS NULL) OR (last_switch_reason = ANY (ARRAY['initial'::text, 'reselected_cold'::text, 'failover_same_provider'::text, 'failover_cross_provider'::text, 'return_to_preferred'::text, 'explicit_choice'::text, 'revoked'::text])))),
    CONSTRAINT subscription_session_bindings_model_id_check CHECK (((length(btrim(model_id)) >= 1) AND (length(btrim(model_id)) <= 512)))
);

ALTER TABLE ONLY subscription_session_bindings FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
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
    locked_settings text[] DEFAULT '{}'::text[] NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    updated_by_subject_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    codex_primary_provider text DEFAULT 'codex'::text NOT NULL,
    claude_primary_provider text DEFAULT 'claude'::text NOT NULL,
    xai_primary_provider text DEFAULT 'xai'::text NOT NULL,
    CONSTRAINT subscription_settings_check CHECK ((((rotation IS NULL) OR (jsonb_typeof(rotation) = 'object'::text)) AND ((providers IS NULL) OR (jsonb_typeof(providers) = 'object'::text)))),
    CONSTRAINT subscription_settings_check1 CHECK (((workspace_id IS NULL) OR (cardinality(locked_settings) = 0))),
    CONSTRAINT subscription_settings_check2 CHECK (((workspace_id IS NOT NULL) OR ((rotation IS NOT NULL) AND (providers IS NOT NULL) AND (cross_provider_failover IS NOT NULL) AND (fallback_order IS NOT NULL) AND (personal_connections_allowed IS NOT NULL) AND (personal_fallback_allowed IS NOT NULL)))),
    CONSTRAINT subscription_settings_claude_primary_provider_chk CHECK ((claude_primary_provider = 'claude'::text)),
    CONSTRAINT subscription_settings_codex_primary_provider_chk CHECK ((codex_primary_provider = 'codex'::text)),
    CONSTRAINT subscription_settings_fallback_order_check CHECK (((fallback_order IS NULL) OR (jsonb_typeof(fallback_order) = 'object'::text))),
    CONSTRAINT subscription_settings_fallback_order_shape_chk CHECK (((fallback_order IS NULL) OR ((NOT jsonb_path_exists(fallback_order, 'strict $.*?(@.type() != "array")'::jsonpath, '{}'::jsonb, true)) AND (NOT jsonb_path_exists(fallback_order, 'strict $.*[*]?(@.type() != "string")'::jsonpath, '{}'::jsonb, true))))),
    CONSTRAINT subscription_settings_locked_keys_chk CHECK ((locked_settings <@ ARRAY['rotation'::text, 'providers'::text, 'crossProviderFailover'::text, 'fallbackOrder'::text, 'personalConnectionsAllowed'::text, 'personalFallbackAllowed'::text])),
    CONSTRAINT subscription_settings_version_check CHECK ((version > 0)),
    CONSTRAINT subscription_settings_xai_primary_provider_chk CHECK ((xai_primary_provider = 'xai'::text))
);

ALTER TABLE ONLY subscription_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE subscription_turn_failures (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    connection_id uuid NOT NULL,
    provider text NOT NULL,
    failure_kind text NOT NULL,
    recovery_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscription_turn_failures_check CHECK (((provider = ANY (ARRAY['codex'::text, 'claude'::text, 'xai'::text])) AND ((length(btrim(failure_kind)) >= 1) AND (length(btrim(failure_kind)) <= 128)))),
    CONSTRAINT subscription_turn_failures_recovery_evidence_check CHECK ((jsonb_typeof(recovery_evidence) = 'object'::text))
);

ALTER TABLE ONLY subscription_turn_failures FORCE ROW LEVEL SECURITY;

CREATE TABLE task_note_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    note_id uuid NOT NULL,
    event_type text NOT NULL,
    note_version integer NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    text_hash text NOT NULL,
    reason text,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    actor_session_id uuid NOT NULL,
    actor_turn_id uuid NOT NULL,
    actor_attempt_id uuid NOT NULL,
    actor_execution_generation integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_note_events_actor_check CHECK (((actor_kind = ANY (ARRAY['human'::text, 'service'::text])) AND ((length(actor_subject_id) >= 1) AND (length(actor_subject_id) <= 1024)) AND (octet_length(actor_subject_id) <= 4096) AND ((initiating_human_subject_id IS NULL) OR (((length(initiating_human_subject_id) >= 1) AND (length(initiating_human_subject_id) <= 1024)) AND (octet_length(initiating_human_subject_id) <= 4096))) AND (actor_execution_generation > 0))),
    CONSTRAINT task_note_events_hash_check CHECK (((input_hash ~ '^[0-9a-f]{64}$'::text) AND (text_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT task_note_events_reason_check CHECK (((reason IS NULL) OR ((octet_length(reason) >= 1) AND (octet_length(reason) <= 2048)))),
    CONSTRAINT task_note_events_type_check CHECK ((((event_type = 'created'::text) AND (note_version = 1) AND (reason IS NULL)) OR ((event_type = 'archived'::text) AND (note_version = 2))))
);

ALTER TABLE ONLY task_note_events FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE task_note_events IS 'Immutable exact-attempt create/archive receipts for task notes; values never confer authority.';

CREATE TABLE task_note_knowledge_promotion_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    note_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    note_version integer NOT NULL,
    note_text_hash text NOT NULL,
    evidence_operation_id text NOT NULL,
    claim_operation_id text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text NOT NULL,
    learning_policy_snapshot_id uuid NOT NULL,
    CONSTRAINT task_note_knowledge_promotion_capabilities_note_version_check CHECK ((note_version = 1))
);

ALTER TABLE ONLY task_note_knowledge_promotion_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE task_note_replacement_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    input_hash text NOT NULL,
    replaced_note_id uuid NOT NULL,
    replaced_note_version integer NOT NULL,
    replacement_note_id uuid NOT NULL,
    replacement_note_version integer NOT NULL,
    archive_operation_id uuid NOT NULL,
    create_operation_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_subject_id text NOT NULL,
    initiating_human_subject_id text,
    actor_session_id uuid NOT NULL,
    actor_turn_id uuid NOT NULL,
    actor_attempt_id uuid NOT NULL,
    actor_execution_generation integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_note_replacement_receipts_replaced_note_version_check CHECK ((replaced_note_version = 2)),
    CONSTRAINT task_note_replacement_receipts_replacement_note_version_check CHECK ((replacement_note_version = 1)),
    CONSTRAINT task_note_replacement_receipts_shape_chk CHECK (((replaced_note_id <> replacement_note_id) AND (archive_operation_id <> create_operation_id) AND (operation_id <> archive_operation_id) AND (operation_id <> create_operation_id) AND (input_hash ~ '^[0-9a-f]{64}$'::text) AND (actor_kind = ANY (ARRAY['human'::text, 'service'::text])) AND ((length(actor_subject_id) >= 1) AND (length(actor_subject_id) <= 1024)) AND (octet_length(actor_subject_id) <= 4096) AND ((initiating_human_subject_id IS NULL) OR (((length(initiating_human_subject_id) >= 1) AND (length(initiating_human_subject_id) <= 1024)) AND (octet_length(initiating_human_subject_id) <= 4096))) AND (actor_execution_generation > 0)))
);

ALTER TABLE ONLY task_note_replacement_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE task_note_write_capabilities (
    backend_pid integer NOT NULL,
    transaction_id xid8 NOT NULL,
    capability_id uuid NOT NULL
);

ALTER TABLE ONLY task_note_write_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE task_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    root_session_id uuid NOT NULL,
    kind text NOT NULL,
    text text NOT NULL,
    text_hash text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    create_operation_id uuid NOT NULL,
    create_input_hash text NOT NULL,
    created_by_actor_kind text NOT NULL,
    created_by_actor_subject_id text NOT NULL,
    created_by_initiating_human_subject_id text,
    created_by_session_id uuid NOT NULL,
    created_by_turn_id uuid NOT NULL,
    created_by_attempt_id uuid NOT NULL,
    created_by_execution_generation integer NOT NULL,
    archive_operation_id uuid,
    archive_input_hash text,
    archived_by_actor_kind text,
    archived_by_actor_subject_id text,
    archived_by_initiating_human_subject_id text,
    archived_by_session_id uuid,
    archived_by_turn_id uuid,
    archived_by_attempt_id uuid,
    archived_by_execution_generation integer,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT task_notes_archive_shape_check CHECK ((((status = 'active'::text) AND (version = 1) AND (archive_operation_id IS NULL) AND (archive_input_hash IS NULL) AND (archived_by_actor_kind IS NULL) AND (archived_by_actor_subject_id IS NULL) AND (archived_by_initiating_human_subject_id IS NULL) AND (archived_by_session_id IS NULL) AND (archived_by_turn_id IS NULL) AND (archived_by_attempt_id IS NULL) AND (archived_by_execution_generation IS NULL) AND (archived_at IS NULL)) OR ((status = 'archived'::text) AND (version = 2) AND (archive_operation_id IS NOT NULL) AND (archive_input_hash ~ '^[0-9a-f]{64}$'::text) AND (archived_by_actor_kind = ANY (ARRAY['human'::text, 'service'::text])) AND ((length(archived_by_actor_subject_id) >= 1) AND (length(archived_by_actor_subject_id) <= 1024)) AND (octet_length(archived_by_actor_subject_id) <= 4096) AND ((archived_by_initiating_human_subject_id IS NULL) OR (((length(archived_by_initiating_human_subject_id) >= 1) AND (length(archived_by_initiating_human_subject_id) <= 1024)) AND (octet_length(archived_by_initiating_human_subject_id) <= 4096))) AND (archived_by_session_id IS NOT NULL) AND (archived_by_turn_id IS NOT NULL) AND (archived_by_attempt_id IS NOT NULL) AND (archived_by_execution_generation > 0) AND (archived_at IS NOT NULL) AND (archived_at >= created_at)))),
    CONSTRAINT task_notes_create_actor_check CHECK (((created_by_actor_kind = ANY (ARRAY['human'::text, 'service'::text])) AND ((length(created_by_actor_subject_id) >= 1) AND (length(created_by_actor_subject_id) <= 1024)) AND (octet_length(created_by_actor_subject_id) <= 4096) AND ((created_by_initiating_human_subject_id IS NULL) OR (((length(created_by_initiating_human_subject_id) >= 1) AND (length(created_by_initiating_human_subject_id) <= 1024)) AND (octet_length(created_by_initiating_human_subject_id) <= 4096))) AND (created_by_execution_generation > 0))),
    CONSTRAINT task_notes_create_hash_check CHECK ((create_input_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT task_notes_expiry_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '90 days'::interval)))),
    CONSTRAINT task_notes_kind_check CHECK ((kind = ANY (ARRAY['finding'::text, 'decision'::text, 'blocker'::text, 'ownership'::text, 'artifact'::text, 'handoff'::text]))),
    CONSTRAINT task_notes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT task_notes_text_check CHECK ((((octet_length(text) >= 1) AND (octet_length(text) <= 4096)) AND (text = btrim(text)))),
    CONSTRAINT task_notes_text_hash_check CHECK ((text_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT task_notes_version_check CHECK (((version >= 1) AND (version <= 2)))
);

ALTER TABLE ONLY task_notes FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE task_notes IS 'Bounded, expiring, non-authoritative root-session coordination notes. Never auto-composed into prompts.';

CREATE TABLE teams_bot_inbox (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    event_id text NOT NULL,
    route_id text NOT NULL,
    actor_id uuid NOT NULL,
    subject_id text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    CONSTRAINT teams_bot_inbox_payload_check CHECK ((octet_length((payload)::text) <= 65536)),
    CONSTRAINT teams_bot_inbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'accepted'::text, 'failed'::text])))
);

ALTER TABLE ONLY teams_bot_inbox FORCE ROW LEVEL SECURITY;

CREATE TABLE teams_bot_installations (
    tenant_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY teams_bot_installations FORCE ROW LEVEL SECURITY;

CREATE TABLE teams_bot_links (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    subject_id text NOT NULL,
    CONSTRAINT teams_bot_links_subject_id_check CHECK (((length(subject_id) >= 1) AND (length(subject_id) <= 512)))
);

ALTER TABLE ONLY teams_bot_links FORCE ROW LEVEL SECURITY;

CREATE TABLE teams_bot_outbox (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    operation_id text NOT NULL,
    route_id text NOT NULL,
    source_sequence bigint NOT NULL,
    part_index integer NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    provider_message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retry_at timestamp with time zone DEFAULT now() NOT NULL,
    error_code text,
    CONSTRAINT teams_bot_outbox_part_index_check CHECK ((part_index >= 0)),
    CONSTRAINT teams_bot_outbox_payload_check CHECK ((octet_length((payload)::text) <= 65536)),
    CONSTRAINT teams_bot_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'sending'::text, 'delivered'::text, 'unknown'::text, 'failed'::text])))
);

ALTER TABLE ONLY teams_bot_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE teams_bot_proofs (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    nonce uuid NOT NULL,
    consumed_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY teams_bot_proofs FORCE ROW LEVEL SECURITY;

CREATE TABLE teams_bot_routes (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    route_id text NOT NULL,
    generation uuid NOT NULL,
    actor_id uuid NOT NULL,
    subject_id text NOT NULL,
    personal boolean NOT NULL,
    channel_id text,
    conversation_id text NOT NULL,
    thread_id text,
    service_url text NOT NULL,
    bot_id text NOT NULL,
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_bound boolean DEFAULT false NOT NULL,
    delivered_sequence bigint DEFAULT 0 NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_claimed_at timestamp with time zone,
    relevant_event_sequence bigint DEFAULT 0 NOT NULL,
    CONSTRAINT teams_bot_routes_check CHECK (((length(route_id) <= 128) AND (length(conversation_id) <= 512) AND (length(bot_id) <= 512) AND (length(service_url) <= 2048))),
    CONSTRAINT teams_bot_routes_relevant_event_sequence_check CHECK ((relevant_event_sequence >= 0))
);

ALTER TABLE ONLY teams_bot_routes FORCE ROW LEVEL SECURITY;

CREATE TABLE temporal_schedule_cleanup_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    temporal_schedule_id text NOT NULL,
    claim_id uuid,
    claim_until timestamp with time zone,
    attempt_count integer DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_task_id uuid,
    connector_cleanup_subject_id text,
    connector_cleanup_snapshot jsonb,
    connector_cleanup_completed_at timestamp with time zone,
    CONSTRAINT temporal_schedule_cleanup_outbox_valid_chk CHECK ((((length(temporal_schedule_id) >= 1) AND (length(temporal_schedule_id) <= 512)) AND (attempt_count >= 0) AND (((claim_id IS NULL) AND (claim_until IS NULL)) OR ((claim_id IS NOT NULL) AND (claim_until IS NOT NULL))) AND (((scheduled_task_id IS NULL) AND (connector_cleanup_subject_id IS NULL) AND (connector_cleanup_snapshot IS NULL)) OR ((scheduled_task_id IS NOT NULL) AND (connector_cleanup_subject_id IS NOT NULL) AND (connector_cleanup_snapshot IS NOT NULL))) AND ((connector_cleanup_snapshot IS NOT NULL) OR (connector_cleanup_completed_at IS NULL)) AND ((connector_cleanup_subject_id IS NULL) OR ((octet_length(connector_cleanup_subject_id) >= 1) AND (octet_length(connector_cleanup_subject_id) <= 4096))) AND ((connector_cleanup_snapshot IS NULL) OR ((jsonb_typeof(connector_cleanup_snapshot) = 'object'::text) AND (connector_cleanup_snapshot ?& ARRAY['version'::text, 'taskId'::text, 'accountId'::text, 'workspaceId'::text, 'connectorKind'::text, 'connectionId'::text, 'connectionVersion'::text, 'sourceId'::text, 'sourceLifecycleGeneration'::text, 'sourceConfigGeneration'::text, 'externalSourceId'::text, 'subjectId'::text]) AND ((connector_cleanup_snapshot - ARRAY['version'::text, 'taskId'::text, 'accountId'::text, 'workspaceId'::text, 'connectorKind'::text, 'connectionId'::text, 'connectionVersion'::text, 'sourceId'::text, 'sourceLifecycleGeneration'::text, 'sourceConfigGeneration'::text, 'externalSourceId'::text, 'subjectId'::text]) = '{}'::jsonb) AND (jsonb_typeof((connector_cleanup_snapshot -> 'version'::text)) = 'number'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'taskId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'accountId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'workspaceId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'connectorKind'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'connectionId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'connectionVersion'::text)) = 'number'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'sourceId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'sourceLifecycleGeneration'::text)) = 'number'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'sourceConfigGeneration'::text)) = 'number'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'externalSourceId'::text)) = 'string'::text) AND (jsonb_typeof((connector_cleanup_snapshot -> 'subjectId'::text)) = 'string'::text) AND ((connector_cleanup_snapshot ->> 'version'::text) = '1'::text) AND ((connector_cleanup_snapshot ->> 'connectorKind'::text) = ANY (ARRAY['google_drive'::text, 'atlassian'::text])) AND ((connector_cleanup_snapshot ->> 'subjectId'::text) = connector_cleanup_subject_id) AND ((connector_cleanup_snapshot ->> 'taskId'::text) = (scheduled_task_id)::text) AND ((connector_cleanup_snapshot ->> 'accountId'::text) = (account_id)::text) AND ((connector_cleanup_snapshot ->> 'workspaceId'::text) = (workspace_id)::text) AND ((octet_length((connector_cleanup_snapshot ->> 'externalSourceId'::text)) >= 1) AND (octet_length((connector_cleanup_snapshot ->> 'externalSourceId'::text)) <= 2048)) AND ((octet_length((connector_cleanup_snapshot ->> 'subjectId'::text)) >= 1) AND (octet_length((connector_cleanup_snapshot ->> 'subjectId'::text)) <= 4096)) AND ((connector_cleanup_snapshot ->> 'taskId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((connector_cleanup_snapshot ->> 'accountId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((connector_cleanup_snapshot ->> 'workspaceId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((connector_cleanup_snapshot ->> 'connectionId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((connector_cleanup_snapshot ->> 'sourceId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((connector_cleanup_snapshot ->> 'connectionVersion'::text) ~ '^[1-9][0-9]*$'::text) AND ((connector_cleanup_snapshot ->> 'sourceLifecycleGeneration'::text) ~ '^[1-9][0-9]*$'::text) AND ((connector_cleanup_snapshot ->> 'sourceConfigGeneration'::text) ~ '^[1-9][0-9]*$'::text) AND (((connector_cleanup_snapshot ->> 'connectionVersion'::text))::numeric <= ('9007199254740991'::bigint)::numeric) AND (((connector_cleanup_snapshot ->> 'sourceLifecycleGeneration'::text))::numeric <= ('9007199254740991'::bigint)::numeric) AND (((connector_cleanup_snapshot ->> 'sourceConfigGeneration'::text))::numeric <= ('9007199254740991'::bigint)::numeric))) AND ((last_error IS NULL) OR (length(last_error) <= 2000))))
);

ALTER TABLE ONLY temporal_schedule_cleanup_outbox FORCE ROW LEVEL SECURITY;

CREATE TABLE tenancy_backfill_receipts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    resource_family text NOT NULL,
    run_key text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    classified_count bigint DEFAULT 0 NOT NULL,
    skipped_count bigint DEFAULT 0 NOT NULL,
    unresolved_count bigint DEFAULT 0 NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenancy_backfill_receipt_completion_chk CHECK ((((status = 'open'::text) AND (completed_at IS NULL)) OR ((status <> 'open'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT tenancy_backfill_receipt_counts_chk CHECK (((classified_count >= 0) AND (skipped_count >= 0) AND (unresolved_count >= 0))),
    CONSTRAINT tenancy_backfill_receipt_family_chk CHECK ((resource_family = ANY (ARRAY['organization_memberships'::text, 'personal_workspaces'::text, 'sessions'::text, 'variable_sets'::text, 'rigs'::text, 'machines'::text, 'connections'::text, 'documents'::text, 'codex_credentials'::text]))),
    CONSTRAINT tenancy_backfill_receipt_run_key_chk CHECK (((length(run_key) >= 1) AND (length(run_key) <= 200))),
    CONSTRAINT tenancy_backfill_receipt_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'completed'::text, 'failed'::text])))
);

ALTER TABLE ONLY tenancy_backfill_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE tenancy_backfill_unresolved_rows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    receipt_id uuid NOT NULL,
    account_id uuid NOT NULL,
    resource_family text NOT NULL,
    resource_id uuid NOT NULL,
    reason_code text NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenancy_backfill_unresolved_family_chk CHECK ((resource_family = ANY (ARRAY['organization_memberships'::text, 'personal_workspaces'::text, 'sessions'::text, 'variable_sets'::text, 'rigs'::text, 'machines'::text, 'connections'::text, 'documents'::text, 'codex_credentials'::text]))),
    CONSTRAINT tenancy_backfill_unresolved_reason_chk CHECK ((reason_code = ANY (ARRAY['no_deterministic_evidence'::text, 'ambiguous_candidate_authority'::text, 'missing_organization_membership'::text, 'conflicting_authority_rows'::text, 'external_lane_owns_row'::text, 'legacy_shape_unrecognized'::text, 'missing_login_identity'::text, 'organization_identity_mismatch'::text, 'missing_owner_workspace_membership'::text, 'membership_terminal_status'::text, 'deterministic_repair_pending'::text])))
);

ALTER TABLE ONLY tenancy_backfill_unresolved_rows FORCE ROW LEVEL SECURITY;

CREATE TABLE tool_gateway_approval_capabilities (
    token_hash text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    operation_id uuid NOT NULL,
    catalog_digest text,
    server_id text NOT NULL,
    tool_name text NOT NULL,
    arguments_digest text NOT NULL,
    authority_digest text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    binding_version integer DEFAULT 1 NOT NULL,
    target_binding_digest text,
    CONSTRAINT tool_gateway_approval_capabilities_arguments_digest_chk CHECK ((arguments_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tool_gateway_approval_capabilities_authority_digest_chk CHECK ((authority_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tool_gateway_approval_capabilities_binding_chk CHECK ((((binding_version = 1) AND (catalog_digest IS NOT NULL) AND (target_binding_digest IS NULL)) OR ((binding_version = 2) AND (catalog_digest IS NULL) AND (target_binding_digest IS NOT NULL) AND (target_binding_digest ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT tool_gateway_approval_capabilities_catalog_digest_chk CHECK ((catalog_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT tool_gateway_approval_capabilities_expiry_chk CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:10:00'::interval)))),
    CONSTRAINT tool_gateway_approval_capabilities_identity_chk CHECK ((((length(server_id) >= 1) AND (length(server_id) <= 256)) AND ((length(tool_name) >= 1) AND (length(tool_name) <= 512)))),
    CONSTRAINT tool_gateway_approval_capabilities_subject_chk CHECK (((length(btrim(subject_id)) >= 1) AND (length(btrim(subject_id)) <= 1024))),
    CONSTRAINT tool_gateway_approval_capabilities_token_hash_chk CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY tool_gateway_approval_capabilities FORCE ROW LEVEL SECURITY;

CREATE TABLE transcription_recording_chunks (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    recording_id uuid NOT NULL,
    chunk_number integer NOT NULL,
    state text DEFAULT 'uploading'::text NOT NULL,
    byte_length integer NOT NULL,
    sha256 text NOT NULL,
    start_milliseconds integer NOT NULL,
    duration_milliseconds integer NOT NULL,
    object_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT transcription_recording_chunks_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'complete'::text]))),
    CONSTRAINT transcription_recording_chunks_values_check CHECK (((chunk_number >= 0) AND (byte_length > 0) AND (start_milliseconds >= 0) AND (duration_milliseconds >= 0) AND (sha256 ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(object_key) >= 1) AND (octet_length(object_key) <= 1024)) AND (((state = 'uploading'::text) AND (completed_at IS NULL)) OR ((state = 'complete'::text) AND (completed_at IS NOT NULL)))))
);

ALTER TABLE ONLY transcription_recording_chunks FORCE ROW LEVEL SECURITY;

CREATE TABLE transcription_recording_objects (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    recording_id uuid NOT NULL,
    object_key text NOT NULL,
    kind text NOT NULL,
    cleanup_after timestamp with time zone NOT NULL,
    cleanup_claim_id uuid,
    cleanup_claimed_at timestamp with time zone,
    cleaned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT transcription_recording_objects_kind_check CHECK ((kind = ANY (ARRAY['chunk'::text, 'segment'::text]))),
    CONSTRAINT transcription_recording_objects_values_check CHECK ((((octet_length(object_key) >= 1) AND (octet_length(object_key) <= 1024)) AND (((cleanup_claim_id IS NULL) AND (cleanup_claimed_at IS NULL)) OR ((cleanup_claim_id IS NOT NULL) AND (cleanup_claimed_at IS NOT NULL))) AND ((cleaned_at IS NULL) OR ((cleanup_claim_id IS NULL) AND (cleanup_claimed_at IS NULL)))))
);

ALTER TABLE ONLY transcription_recording_objects FORCE ROW LEVEL SECURITY;

CREATE TABLE transcription_recording_segments (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    recording_id uuid NOT NULL,
    segment_number integer NOT NULL,
    generation integer NOT NULL,
    state text DEFAULT 'preparing'::text NOT NULL,
    byte_length integer NOT NULL,
    sha256 text NOT NULL,
    start_milliseconds integer NOT NULL,
    duration_milliseconds integer NOT NULL,
    object_key text NOT NULL,
    attempt_id uuid,
    attempt_started_at timestamp with time zone,
    transcript_text text,
    languages jsonb DEFAULT '[]'::jsonb NOT NULL,
    provider_id text,
    error_code text,
    retryable boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    attempt_deadline_at timestamp with time zone,
    transcript_text_codec_version integer,
    CONSTRAINT transcription_recording_segments_attempt_deadline_check CHECK ((((attempt_id IS NULL) AND (attempt_started_at IS NULL) AND (attempt_deadline_at IS NULL)) OR ((attempt_id IS NOT NULL) AND (attempt_started_at IS NOT NULL) AND (attempt_deadline_at IS NOT NULL)))),
    CONSTRAINT transcription_recording_segments_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['permission_denied'::text, 'not_supported'::text, 'network'::text, 'provider'::text, 'policy_blocked'::text, 'timeout'::text, 'cancelled'::text, 'unavailable'::text, 'too_large'::text, 'invalid_audio'::text, 'unknown'::text, 'insufficient_credits'::text, 'allowance_exhausted'::text, 'monthly_model_cost_limit'::text])))),
    CONSTRAINT transcription_recording_segments_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'pending'::text, 'transcribing'::text, 'complete'::text, 'failed'::text]))),
    CONSTRAINT transcription_recording_segments_values_check CHECK (((segment_number >= 0) AND (generation > 0) AND (byte_length > 0) AND (start_milliseconds >= 0) AND (duration_milliseconds > 0) AND (sha256 ~ '^[0-9a-f]{64}$'::text) AND ((octet_length(object_key) >= 1) AND (octet_length(object_key) <= 1024)) AND ((transcript_text IS NULL) OR (octet_length(transcript_text) <= 1000000)) AND (jsonb_typeof(languages) = 'array'::text) AND (((attempt_id IS NULL) AND (attempt_started_at IS NULL)) OR ((attempt_id IS NOT NULL) AND (attempt_started_at IS NOT NULL)))))
);

ALTER TABLE ONLY transcription_recording_segments FORCE ROW LEVEL SECURITY;

CREATE TABLE transcription_recordings (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    mime_type text NOT NULL,
    state text DEFAULT 'uploading'::text NOT NULL,
    next_chunk_number integer DEFAULT 0 NOT NULL,
    chunk_count integer DEFAULT 0 NOT NULL,
    total_bytes integer DEFAULT 0 NOT NULL,
    total_duration_milliseconds integer DEFAULT 0 NOT NULL,
    segment_count integer DEFAULT 0 NOT NULL,
    completed_segment_count integer DEFAULT 0 NOT NULL,
    transcript_text text,
    languages jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_code text,
    retryable boolean DEFAULT false NOT NULL,
    provider_id text,
    processing_generation integer DEFAULT 0 NOT NULL,
    processing_owner uuid,
    processing_started_at timestamp with time zone,
    objects_cleaned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    transcript_text_codec_version integer,
    CONSTRAINT transcription_recordings_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['permission_denied'::text, 'not_supported'::text, 'network'::text, 'provider'::text, 'policy_blocked'::text, 'timeout'::text, 'cancelled'::text, 'unavailable'::text, 'too_large'::text, 'invalid_audio'::text, 'unknown'::text, 'insufficient_credits'::text, 'allowance_exhausted'::text, 'monthly_model_cost_limit'::text])))),
    CONSTRAINT transcription_recordings_processing_check CHECK ((((processing_owner IS NULL) AND (processing_started_at IS NULL)) OR ((processing_owner IS NOT NULL) AND (processing_started_at IS NOT NULL)))),
    CONSTRAINT transcription_recordings_state_check CHECK ((state = ANY (ARRAY['uploading'::text, 'segmenting'::text, 'ready'::text, 'transcribing'::text, 'complete'::text, 'failed'::text, 'discarded'::text]))),
    CONSTRAINT transcription_recordings_values_check CHECK (((next_chunk_number >= 0) AND (chunk_count >= 0) AND (total_bytes >= 0) AND (total_duration_milliseconds >= 0) AND (segment_count >= 0) AND (completed_segment_count >= 0) AND (completed_segment_count <= segment_count) AND ((octet_length(subject_id) >= 1) AND (octet_length(subject_id) <= 1024)) AND ((octet_length(mime_type) >= 1) AND (octet_length(mime_type) <= 128)) AND ((provider_id IS NULL) OR ((octet_length(provider_id) >= 1) AND (octet_length(provider_id) <= 128))) AND ((transcript_text IS NULL) OR (octet_length(transcript_text) <= 4000000)) AND (jsonb_typeof(languages) = 'array'::text)))
);

ALTER TABLE ONLY transcription_recordings FORCE ROW LEVEL SECURITY;

CREATE TABLE turn_connection_authority_snapshots (
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    server_id text NOT NULL,
    connection_id uuid NOT NULL,
    connection_generation bigint NOT NULL,
    origin_workspace_id uuid NOT NULL,
    provider_domain text NOT NULL,
    connection_kind text NOT NULL,
    authority_scope text NOT NULL,
    authority_source text NOT NULL,
    owner_subject_id text,
    owner_organization_membership_id uuid,
    membership_authorization_revision bigint,
    authority_id uuid,
    authority_generation bigint,
    grant_id uuid,
    grant_generation bigint,
    grant_mode text,
    grant_context text,
    grant_session_id uuid,
    grant_authority_epoch integer,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    canonical_snapshot jsonb NOT NULL,
    snapshot_digest bytea NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT turn_connection_authority_generation_check CHECK (((connection_generation > 0) AND (session_authority_epoch > 0) AND ((membership_authorization_revision IS NULL) OR (membership_authorization_revision > 0)) AND ((authority_generation IS NULL) OR (authority_generation > 0)) AND ((grant_generation IS NULL) OR (grant_generation > 0)))),
    CONSTRAINT turn_connection_authority_grant_check CHECK ((((authority_scope = 'user'::text) AND (authority_source = 'user_delegation'::text) AND (owner_subject_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL) AND (membership_authorization_revision > 0) AND (authority_id IS NOT NULL) AND (authority_generation > 0) AND (grant_id IS NOT NULL) AND (grant_generation > 0) AND (grant_mode = ANY (ARRAY['once'::text, 'session'::text, 'always'::text])) AND (grant_context = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (((grant_mode = 'always'::text) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((grant_mode = ANY (ARRAY['once'::text, 'session'::text])) AND (grant_session_id = session_id) AND (grant_authority_epoch > 0)))) OR ((authority_scope = 'workspace'::text) AND (authority_source = ANY (ARRAY['explicit_workspace'::text, 'legacy_workspace_omission'::text])) AND (owner_subject_id IS NULL) AND (owner_organization_membership_id IS NULL) AND (membership_authorization_revision IS NULL) AND (authority_id IS NULL) AND (authority_generation IS NULL) AND (grant_id IS NULL) AND (grant_generation IS NULL) AND (grant_mode IS NULL) AND (grant_context IS NULL) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((authority_scope = 'legacy_user'::text) AND (authority_source = 'legacy_user_compatibility'::text) AND (owner_subject_id IS NOT NULL) AND (owner_organization_membership_id IS NULL) AND (membership_authorization_revision IS NULL) AND (authority_id IS NULL) AND (authority_generation IS NULL) AND (grant_id IS NULL) AND (grant_generation IS NULL) AND (grant_mode IS NULL) AND (grant_context IS NULL) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)) OR ((authority_scope = 'user'::text) AND (authority_source = 'sender'::text) AND (owner_subject_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL) AND (membership_authorization_revision IS NOT NULL) AND (membership_authorization_revision > 0) AND (authority_id IS NOT NULL) AND (authority_generation IS NOT NULL) AND (authority_generation > 0) AND (grant_id IS NULL) AND (grant_generation IS NULL) AND (grant_mode IS NULL) AND (grant_context IS NULL) AND (grant_session_id IS NULL) AND (grant_authority_epoch IS NULL)))),
    CONSTRAINT turn_connection_authority_server_check CHECK (((octet_length(server_id) >= 1) AND (octet_length(server_id) <= 256)))
);

ALTER TABLE ONLY turn_connection_authority_snapshots FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE turn_connection_authority_snapshots IS 'Canonical credential-free connection authority frozen for one accepted logical turn; runtime access is only through exact-attempt SECURITY DEFINER resolution.';

CREATE TABLE turn_personal_resource_attachment_receipts (
    turn_id uuid NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    initiating_human_subject_id text NOT NULL,
    owner_organization_membership_id uuid NOT NULL,
    membership_authorization_revision bigint NOT NULL,
    session_visibility text NOT NULL,
    session_authority_epoch integer NOT NULL,
    grant_mode text NOT NULL,
    shared_output_warning_version integer NOT NULL,
    shared_output_acknowledged boolean NOT NULL,
    request_digest bytea NOT NULL,
    resource_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT turn_personal_resource_attachment_receipts_identity_chk CHECK ((((octet_length(initiating_human_subject_id) >= 1) AND (octet_length(initiating_human_subject_id) <= 512)) AND (membership_authorization_revision > 0) AND (session_authority_epoch > 0) AND (grant_mode = ANY (ARRAY['once'::text, 'session'::text, 'always'::text])) AND (session_visibility = ANY (ARRAY['user_private'::text, 'workspace_shared'::text])) AND (shared_output_warning_version = 1) AND ((resource_count >= 1) AND (resource_count <= 52)) AND ((session_visibility <> 'workspace_shared'::text) OR (shared_output_acknowledged IS TRUE))))
);

ALTER TABLE ONLY turn_personal_resource_attachment_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE turn_personal_resource_once_receipts (
    grant_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    account_id uuid NOT NULL,
    authority_id uuid NOT NULL,
    authority_generation bigint NOT NULL,
    grant_generation bigint NOT NULL,
    consumed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT turn_personal_resource_once_receipts_generation_chk CHECK (((authority_generation > 0) AND (grant_generation > 0)))
);

ALTER TABLE ONLY turn_personal_resource_once_receipts FORCE ROW LEVEL SECURITY;

CREATE TABLE vault_field_versions (
    field_id uuid NOT NULL,
    version integer NOT NULL,
    account_id uuid NOT NULL,
    value_encrypted text NOT NULL,
    created_by_kind text NOT NULL,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_field_versions_created_by_kind_check CHECK ((created_by_kind = ANY (ARRAY['human'::text, 'agent'::text, 'api_key'::text, 'migration'::text, 'provider'::text, 'system'::text]))),
    CONSTRAINT vault_field_versions_version_check CHECK ((version > 0))
);

ALTER TABLE ONLY vault_field_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE vault_item_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    item_id uuid NOT NULL,
    name text NOT NULL,
    name_key text GENERATED ALWAYS AS (vault_name_key(name)) STORED,
    kind text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    current_version integer,
    provider_field_ref text,
    file_name text,
    file_size integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_item_fields_current_version_check CHECK (((current_version IS NULL) OR (current_version > 0))),
    CONSTRAINT vault_item_fields_file_size_check CHECK (((file_size IS NULL) OR (file_size >= 0))),
    CONSTRAINT vault_item_fields_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'concealed'::text, 'totp'::text, 'file'::text]))),
    CONSTRAINT vault_item_fields_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 120))),
    CONSTRAINT vault_item_fields_name_not_otp CHECK ((name_key <> 'otp'::text))
);

ALTER TABLE ONLY vault_item_fields FORCE ROW LEVEL SECURITY;

CREATE TABLE vault_item_name_aliases (
    vault_id uuid NOT NULL,
    name_key text NOT NULL,
    item_id uuid NOT NULL,
    account_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY vault_item_name_aliases FORCE ROW LEVEL SECURITY;

CREATE TABLE vault_name_aliases (
    account_id uuid NOT NULL,
    scope_key text NOT NULL,
    name_key text NOT NULL,
    vault_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY vault_name_aliases FORCE ROW LEVEL SECURITY;

CREATE TABLE vault_passkey_leases (
    item_id uuid NOT NULL,
    account_id uuid NOT NULL,
    holder text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

ALTER TABLE ONLY vault_passkey_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE video_generation_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid,
    turn_id uuid,
    attempt_id uuid,
    tool_call_id text NOT NULL,
    admission_key text NOT NULL,
    request_digest text NOT NULL,
    prompt_digest text NOT NULL,
    request_encrypted text,
    model_id text NOT NULL,
    source_mode text NOT NULL,
    capability_revision text NOT NULL,
    connection_id uuid,
    credential_version integer NOT NULL,
    credential_encrypted text,
    provider_idempotency_key text NOT NULL,
    provider_job_id text,
    provider_request_encrypted text,
    provider_request_expires_at timestamp with time zone,
    expected_artifact_id uuid NOT NULL,
    expected_file_id uuid NOT NULL,
    reserved_bytes bigint NOT NULL,
    quota_state text DEFAULT 'reserved'::text NOT NULL,
    status text DEFAULT 'preparing'::text NOT NULL,
    admission_output_state text DEFAULT 'pending'::text NOT NULL,
    terminal_update_state text DEFAULT 'ineligible'::text NOT NULL,
    terminal_update_id uuid,
    reconcile_revision bigint DEFAULT 0 NOT NULL,
    reconcile_lease_owner text,
    reconcile_lease_expires_at timestamp with time zone,
    next_reconcile_at timestamp with time zone,
    provider_request_sent_at timestamp with time zone,
    provider_started_at timestamp with time zone,
    recovery_deadline_at timestamp with time zone NOT NULL,
    terminal_at timestamp with time zone,
    private_data_erase_after timestamp with time zone,
    bounded_public_reason text,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    funding_source text DEFAULT 'workspace_gateway'::text NOT NULL,
    priced_cost_micros bigint DEFAULT 0 NOT NULL,
    credit_state text DEFAULT 'not_applicable'::text NOT NULL,
    private_file_owner_subject_id text DEFAULT NULLIF(current_setting('opengeni.private_file_owner'::text, true), ''::text),
    CONSTRAINT video_generation_operations_funding_state_chk CHECK ((((funding_source = 'workspace_gateway'::text) AND (connection_id IS NOT NULL) AND (priced_cost_micros = 0) AND (credit_state = 'not_applicable'::text)) OR ((funding_source = 'opengeni_credits'::text) AND (connection_id IS NULL) AND (((priced_cost_micros = 0) AND (credit_state = 'not_applicable'::text)) OR ((priced_cost_micros > 0) AND (((status = ANY (ARRAY['provider_failed'::text, 'cancelled_before_submit'::text, 'outcome_unknown'::text, 'retention_failed'::text])) AND (credit_state = 'refunded'::text)) OR ((status <> ALL (ARRAY['provider_failed'::text, 'cancelled_before_submit'::text, 'outcome_unknown'::text, 'retention_failed'::text])) AND (credit_state = 'debited'::text)))))) OR ((funding_source = 'supergrok_subscription'::text) AND (connection_id IS NULL) AND (priced_cost_micros = 0) AND (credit_state = 'not_applicable'::text)))),
    CONSTRAINT video_generation_operations_funding_values_chk CHECK (((funding_source = ANY (ARRAY['opengeni_credits'::text, 'workspace_gateway'::text, 'supergrok_subscription'::text])) AND ((priced_cost_micros >= 0) AND (priced_cost_micros <= 1000000000)) AND (credit_state = ANY (ARRAY['not_applicable'::text, 'debited'::text, 'refunded'::text])))),
    CONSTRAINT video_generation_operations_hashes_chk CHECK (((admission_key ~ '^[0-9a-f]{64}$'::text) AND (request_digest ~ '^[0-9a-f]{64}$'::text) AND (prompt_digest ~ '^[0-9a-f]{64}$'::text) AND (capability_revision ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT video_generation_operations_shape_chk CHECK ((((octet_length(tool_call_id) >= 1) AND (octet_length(tool_call_id) <= 512)) AND ((octet_length(model_id) >= 1) AND (octet_length(model_id) <= 256)) AND ((octet_length(provider_idempotency_key) >= 1) AND (octet_length(provider_idempotency_key) <= 128)) AND (source_mode = ANY (ARRAY['text'::text, 'first_frame'::text, 'first_and_last_frames'::text, 'image_reference'::text, 'video_reference'::text])) AND (reserved_bytes > 0) AND (reserved_bytes <= 536870912) AND ((bounded_public_reason IS NULL) OR (octet_length(bounded_public_reason) <= 4000)) AND ((last_error IS NULL) OR (octet_length(last_error) <= 16384)))),
    CONSTRAINT video_generation_operations_state_chk CHECK (((status = ANY (ARRAY['preparing'::text, 'prepared'::text, 'accepted'::text, 'submission_uncertain'::text, 'provider_started'::text, 'retaining'::text, 'completed'::text, 'provider_failed'::text, 'cancelled_before_submit'::text, 'outcome_unknown'::text, 'retention_failed'::text])) AND (admission_output_state = ANY (ARRAY['pending'::text, 'recorded'::text])) AND (terminal_update_state = ANY (ARRAY['ineligible'::text, 'pending'::text, 'leased'::text, 'delivered'::text, 'suppressed'::text])) AND (quota_state = ANY (ARRAY['reserved'::text, 'ready'::text, 'released'::text])) AND ((terminal_at IS NOT NULL) = (status = ANY (ARRAY['completed'::text, 'provider_failed'::text, 'cancelled_before_submit'::text, 'outcome_unknown'::text, 'retention_failed'::text]))) AND ((status <> 'submission_uncertain'::text) OR ((provider_request_encrypted IS NOT NULL) AND (provider_request_expires_at IS NOT NULL))) AND ((provider_request_encrypted IS NULL) OR (status = 'submission_uncertain'::text)) AND ((status <> ALL (ARRAY['provider_started'::text, 'retaining'::text, 'completed'::text, 'retention_failed'::text])) OR (provider_job_id IS NOT NULL)) AND ((provider_job_id IS NULL) OR (status = ANY (ARRAY['provider_started'::text, 'retaining'::text, 'completed'::text, 'provider_failed'::text, 'retention_failed'::text])))))
);

ALTER TABLE ONLY video_generation_operations FORCE ROW LEVEL SECURITY;

CREATE TABLE video_generation_references (
    operation_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    ordinal integer NOT NULL,
    role text NOT NULL,
    content_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    staging_object_key text,
    grant_expires_at timestamp with time zone,
    cleanup_after timestamp with time zone,
    cleaned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT video_generation_references_bounds_chk CHECK ((((ordinal >= 0) AND (ordinal <= 1)) AND (role = ANY (ARRAY['first_frame'::text, 'last_frame'::text, 'image_reference'::text, 'video_reference'::text])) AND ((octet_length(content_type) >= 3) AND (octet_length(content_type) <= 128)) AND (size_bytes > 0) AND (size_bytes <= 209715200))),
    CONSTRAINT video_generation_references_hash_chk CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))
);

ALTER TABLE ONLY video_generation_references FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_artifact_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    type text NOT NULL,
    from_version_id uuid,
    to_version_id uuid NOT NULL,
    operation_key text NOT NULL,
    source_session_id uuid,
    source_turn_id uuid,
    source_attempt_id uuid,
    source_execution_generation integer,
    actor_subject_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    request_digest text,
    request_input jsonb,
    CONSTRAINT workspace_artifact_events_audit_chk CHECK ((((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)) AND ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 4096)))),
    CONSTRAINT workspace_artifact_events_operation_chk CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 512))),
    CONSTRAINT workspace_artifact_events_provenance_chk CHECK ((((source_session_id IS NULL) AND (source_turn_id IS NULL) AND (source_attempt_id IS NULL) AND (source_execution_generation IS NULL)) OR ((source_session_id IS NOT NULL) AND (source_turn_id IS NOT NULL) AND (source_attempt_id IS NOT NULL) AND (source_execution_generation > 0)))),
    CONSTRAINT workspace_artifact_events_request_digest_chk CHECK (((request_digest IS NULL) OR (request_digest ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_artifact_events_type_chk CHECK ((type = ANY (ARRAY['published'::text, 'rolled_back'::text, 'archived'::text, 'restored'::text])))
);

ALTER TABLE ONLY workspace_artifact_events FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_artifact_uploads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    owner_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    CONSTRAINT workspace_artifact_uploads_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'expired'::text])))
);

ALTER TABLE ONLY workspace_artifact_uploads FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_artifact_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    revision integer NOT NULL,
    content_key text NOT NULL,
    content_type text DEFAULT 'text/html'::text NOT NULL,
    content_sha256 text,
    size_bytes bigint NOT NULL,
    operation_key text NOT NULL,
    source_session_id uuid,
    source_turn_id uuid,
    source_attempt_id uuid,
    source_execution_generation integer,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    source_key text,
    source_sha256 text,
    source_size_bytes bigint,
    requested_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT workspace_artifact_versions_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT workspace_artifact_versions_content_chk CHECK (((content_type = 'text/html'::text) AND (size_bytes > 0) AND ((length(content_key) >= 1) AND (length(content_key) <= 1024)) AND (((source_key IS NULL) AND (source_size_bytes IS NULL)) OR ((source_key IS NOT NULL) AND (source_size_bytes > 0) AND ((length(source_key) >= 1) AND (length(source_key) <= 1024)))) AND (jsonb_typeof(requested_tools) = 'array'::text) AND (jsonb_array_length(requested_tools) <= 128))),
    CONSTRAINT workspace_artifact_versions_operation_chk CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 512))),
    CONSTRAINT workspace_artifact_versions_provenance_chk CHECK ((((source_session_id IS NULL) AND (source_turn_id IS NULL) AND (source_attempt_id IS NULL) AND (source_execution_generation IS NULL)) OR ((source_session_id IS NOT NULL) AND (source_turn_id IS NOT NULL) AND (source_attempt_id IS NOT NULL) AND (source_execution_generation > 0)))),
    CONSTRAINT workspace_artifact_versions_revision_chk CHECK ((revision > 0))
);

ALTER TABLE ONLY workspace_artifact_versions FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    description text,
    status text DEFAULT 'active'::text NOT NULL,
    current_version_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    visibility text DEFAULT 'workspace_shared'::text NOT NULL,
    owner_subject_id text,
    CONSTRAINT workspace_artifacts_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT workspace_artifacts_description_chk CHECK (((description IS NULL) OR (length(description) <= 2000))),
    CONSTRAINT workspace_artifacts_slug_chk CHECK ((((length(slug) >= 1) AND (length(slug) <= 96)) AND (slug ~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'::text))),
    CONSTRAINT workspace_artifacts_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
    CONSTRAINT workspace_artifacts_title_chk CHECK (((length(btrim(title)) >= 1) AND (length(btrim(title)) <= 120))),
    CONSTRAINT workspace_artifacts_visibility_check CHECK (((visibility = ANY (ARRAY['workspace_shared'::text, 'user_private'::text])) AND ((visibility = 'workspace_shared'::text) OR (owner_subject_id IS NOT NULL))))
);

ALTER TABLE ONLY workspace_artifacts FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid,
    revision bigint NOT NULL,
    lease_epoch integer NOT NULL,
    state text DEFAULT 'available'::text NOT NULL,
    manifest_key text,
    tree_index_key text,
    blob_keys jsonb DEFAULT '[]'::jsonb NOT NULL,
    size_bytes bigint,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_captures_state_chk CHECK ((state = ANY (ARRAY['available'::text, 'failed'::text])))
);

ALTER TABLE ONLY workspace_captures FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_codex_subscription_preferences (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    mode text DEFAULT 'automatic'::text NOT NULL,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_codex_subscription_preferences_mode_chk CHECK ((mode = ANY (ARRAY['automatic'::text, 'workspace'::text, 'organization'::text, 'disabled'::text])))
);

ALTER TABLE ONLY workspace_codex_subscription_preferences FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE workspace_codex_subscription_preferences IS 'One effective Codex source per workspace, including Personal. Absent means automatic.';

CREATE TABLE workspace_control_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision bigint NOT NULL,
    scope text NOT NULL,
    root_session_id uuid,
    action text NOT NULL,
    automatic boolean DEFAULT false NOT NULL,
    reason text,
    actor text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    reason_original_bytes integer,
    actor_original_bytes integer,
    CONSTRAINT workspace_control_events_action_check CHECK ((action = ANY (ARRAY['pause'::text, 'resume'::text, 'timer_set'::text, 'timer_cancelled'::text]))),
    CONSTRAINT workspace_control_events_actor_bytes_check CHECK ((octet_length(actor) <= 1024)),
    CONSTRAINT workspace_control_events_actor_original_bytes_check CHECK (((actor_original_bytes IS NULL) OR (actor_original_bytes >= octet_length(actor)))),
    CONSTRAINT workspace_control_events_original_bytes_check CHECK ((((reason IS NULL) AND (reason_original_bytes IS NULL)) OR ((reason IS NOT NULL) AND ((reason_original_bytes IS NULL) OR (reason_original_bytes >= octet_length(reason)))))),
    CONSTRAINT workspace_control_events_reason_bytes_check CHECK (((reason IS NULL) OR (octet_length(reason) <= 8192))),
    CONSTRAINT workspace_control_events_revision_check CHECK ((revision > 0)),
    CONSTRAINT workspace_control_events_shape_check CHECK ((((scope = 'workspace'::text) AND (root_session_id IS NULL)) OR ((scope = 'session'::text) AND (root_session_id IS NOT NULL))))
);

ALTER TABLE ONLY workspace_control_events FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_credential_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    url text NOT NULL,
    secret_encrypted text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    timeout_ms integer DEFAULT 10000 NOT NULL,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_credential_providers_subject_chk CHECK (((created_by_subject_id IS NULL) OR ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)))),
    CONSTRAINT workspace_credential_providers_timeout_chk CHECK (((timeout_ms >= 1000) AND (timeout_ms <= 30000))),
    CONSTRAINT workspace_credential_providers_url_chk CHECK ((((char_length(url) >= 8) AND (char_length(url) <= 2048)) AND ((url ~~ 'https://%'::text) OR (url ~~ 'http://%'::text))))
);

ALTER TABLE ONLY workspace_credential_providers FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_gateway_custom_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
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
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT workspace_gateway_custom_models_actor_chk CHECK (((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024))),
    CONSTRAINT workspace_gateway_custom_models_create_hash_chk CHECK ((create_request_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT workspace_gateway_custom_models_delete_receipt_chk CHECK ((((delete_operation_id IS NULL) AND (delete_request_hash IS NULL)) OR ((delete_operation_id IS NOT NULL) AND (delete_request_hash ~ '^[a-f0-9]{64}$'::text) AND (retired_at IS NOT NULL)))),
    CONSTRAINT workspace_gateway_custom_models_label_chk CHECK (((label IS NULL) OR (((octet_length(label) >= 1) AND (octet_length(label) <= 128)) AND (label !~ '[\r\n|]'::text)))),
    CONSTRAINT workspace_gateway_custom_models_provider_kind_chk CHECK ((provider_kind = ANY (ARRAY['vercel_gateway'::text, 'openrouter'::text, 'anthropic'::text, 'claude_subscription'::text, 'opper'::text]))),
    CONSTRAINT workspace_gateway_custom_models_upstream_chk CHECK ((((octet_length(upstream_model_id) >= 1) AND (octet_length(upstream_model_id) <= 238)) AND (upstream_model_id ~ '^[!-~]+$'::text) AND (upstream_model_id !~ '[|]'::text))),
    CONSTRAINT workspace_gateway_custom_models_version_chk CHECK ((version > 0))
);

ALTER TABLE ONLY workspace_gateway_custom_models FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE workspace_gateway_custom_models IS 'Workspace-owned Vercel AI Gateway and OpenRouter upstream slugs. Retired rows remain execution evidence; capabilities and billing are never stored here.';

CREATE TABLE workspace_inference_controls (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    workspace_state text DEFAULT 'active'::text NOT NULL,
    workspace_pause_revision bigint,
    reason text,
    changed_by text,
    changed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    timer_id uuid,
    timer_action text,
    timer_due_at timestamp with time zone,
    timer_pause_for_seconds integer,
    timer_pause_revision bigint,
    CONSTRAINT workspace_inference_controls_pause_revision_check CHECK ((((workspace_state = 'active'::text) AND (workspace_pause_revision IS NULL)) OR ((workspace_state = 'paused'::text) AND (workspace_pause_revision IS NOT NULL)))),
    CONSTRAINT workspace_inference_controls_revision_check CHECK (((revision >= 0) AND ((workspace_pause_revision IS NULL) OR (workspace_pause_revision <= revision)))),
    CONSTRAINT workspace_inference_controls_state_check CHECK ((workspace_state = ANY (ARRAY['active'::text, 'paused'::text]))),
    CONSTRAINT workspace_pause_timer_shape CHECK ((((timer_id IS NULL) AND (timer_action IS NULL) AND (timer_due_at IS NULL) AND (timer_pause_for_seconds IS NULL) AND (timer_pause_revision IS NULL)) OR ((timer_id IS NOT NULL) AND (timer_action IS NOT NULL) AND (timer_due_at IS NOT NULL) AND (((timer_action = 'pause'::text) AND (timer_pause_revision IS NULL)) OR ((timer_action = 'resume'::text) AND (timer_pause_revision IS NOT NULL) AND (timer_pause_for_seconds IS NULL))) AND ((timer_pause_for_seconds IS NULL) OR ((timer_pause_for_seconds >= 60) AND (timer_pause_for_seconds <= 2592000))))))
);

ALTER TABLE ONLY workspace_inference_controls FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_instruction_policy_heads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    role_key text,
    revision_id uuid NOT NULL,
    revision bigint NOT NULL,
    content_hash text NOT NULL,
    activation_version bigint NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_instruction_policy_heads_revision_chk CHECK (((revision > 0) AND (activation_version > 0) AND (content_hash ~ '^[0-9a-f]{64}$'::text))),
    CONSTRAINT workspace_instruction_policy_heads_role_key_chk CHECK (((role_key IS NULL) OR ((role_key = lower(btrim(role_key))) AND ((length(role_key) >= 1) AND (length(role_key) <= 64)) AND (role_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (role_key !~ '--'::text)))),
    CONSTRAINT workspace_instruction_policy_heads_target_chk CHECK ((((kind = 'charter'::text) AND (scope = 'global'::text) AND (role_key IS NULL)) OR ((kind = 'policy'::text) AND (scope = 'global'::text) AND (role_key IS NULL)) OR ((kind = 'policy'::text) AND (scope = 'role'::text) AND (role_key IS NOT NULL))))
);

ALTER TABLE ONLY workspace_instruction_policy_heads FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_instruction_policy_onboarding_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    kind text NOT NULL,
    scope text NOT NULL,
    role_key text,
    source_id text NOT NULL,
    source_version text NOT NULL,
    confidence_bps integer NOT NULL,
    baseline_revision_id uuid,
    baseline_revision bigint,
    baseline_content_hash text,
    baseline_activation_version bigint NOT NULL,
    baseline_activated_at timestamp with time zone,
    draft_revision_id uuid NOT NULL,
    draft_revision bigint NOT NULL,
    draft_content_hash text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_baseline_chk CHECK ((((baseline_revision_id IS NULL) AND (baseline_revision IS NULL) AND (baseline_content_hash IS NULL) AND (baseline_activation_version >= 0) AND (baseline_activated_at IS NULL)) OR ((baseline_revision_id IS NOT NULL) AND (baseline_revision > 0) AND (baseline_content_hash ~ '^[0-9a-f]{64}$'::text) AND (baseline_activation_version > 0) AND (baseline_activated_at IS NOT NULL)))),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_draft_chk CHECK (((draft_revision > 0) AND (draft_content_hash ~ '^[0-9a-f]{64}$'::text) AND (status = 'proposed'::text))),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_operation_rec CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_role_key_chk CHECK (((role_key IS NULL) OR ((role_key = lower(btrim(role_key))) AND ((length(role_key) >= 1) AND (length(role_key) <= 64)) AND (role_key ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$'::text) AND (role_key !~ '--'::text)))),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_source_chk CHECK ((((length(btrim(source_id)) >= 1) AND (length(btrim(source_id)) <= 512)) AND ((length(btrim(source_version)) >= 1) AND (length(btrim(source_version)) <= 256)) AND ((confidence_bps >= 0) AND (confidence_bps <= 10000)))),
    CONSTRAINT workspace_instruction_policy_onboarding_proposals_target_chk CHECK ((((kind = 'charter'::text) AND (scope = 'global'::text) AND (role_key IS NULL)) OR ((kind = 'policy'::text) AND (scope = 'global'::text) AND (role_key IS NULL)) OR ((kind = 'policy'::text) AND (scope = 'role'::text) AND (role_key IS NOT NULL))))
);

ALTER TABLE ONLY workspace_instruction_policy_onboarding_proposals FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_interaction_revisions (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_interaction_revisions_revision_check CHECK ((revision >= 0))
);

ALTER TABLE ONLY workspace_interaction_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_learning_policy_activation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    type text NOT NULL,
    activation_version bigint NOT NULL,
    old_revision_id uuid,
    old_revision bigint,
    old_policy_hash text,
    new_revision_id uuid NOT NULL,
    new_revision bigint NOT NULL,
    new_policy_hash text NOT NULL,
    actor_subject_id text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_learning_policy_events_audit_chk CHECK ((((length(btrim(actor_subject_id)) >= 1) AND (length(btrim(actor_subject_id)) <= 1024)) AND ((length(btrim(reason)) >= 1) AND (length(btrim(reason)) <= 4096)))),
    CONSTRAINT workspace_learning_policy_events_new_revision_chk CHECK (((new_revision > 0) AND (new_policy_hash ~ '^[0-9a-f]{64}$'::text) AND (activation_version > 0))),
    CONSTRAINT workspace_learning_policy_events_old_revision_chk CHECK ((((old_revision_id IS NULL) AND (old_revision IS NULL) AND (old_policy_hash IS NULL)) OR ((old_revision_id IS NOT NULL) AND (old_revision > 0) AND (old_policy_hash ~ '^[0-9a-f]{64}$'::text)))),
    CONSTRAINT workspace_learning_policy_events_operation_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_learning_policy_events_type_chk CHECK ((type = ANY (ARRAY['activate'::text, 'rollback'::text])))
);

ALTER TABLE ONLY workspace_learning_policy_activation_events FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_learning_policy_heads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    revision bigint NOT NULL,
    policy_hash text NOT NULL,
    activation_version bigint NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_learning_policy_heads_version_chk CHECK (((revision > 0) AND (activation_version > 0) AND (policy_hash ~ '^[0-9a-f]{64}$'::text)))
);

ALTER TABLE ONLY workspace_learning_policy_heads FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE workspace_learning_policy_revision_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE workspace_learning_policy_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id uuid NOT NULL,
    request_fingerprint text NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    revision bigint DEFAULT nextval('workspace_learning_policy_revision_seq'::regclass) NOT NULL,
    workspace_mode text NOT NULL,
    source_overrides jsonb DEFAULT '[]'::jsonb NOT NULL,
    policy_hash text NOT NULL,
    supersedes_revision_id uuid,
    created_by_subject_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_learning_policy_revisions_actor_chk CHECK (((length(btrim(created_by_subject_id)) >= 1) AND (length(btrim(created_by_subject_id)) <= 1024))),
    CONSTRAINT workspace_learning_policy_revisions_hash_chk CHECK (((policy_hash ~ '^[0-9a-f]{64}$'::text) AND (policy_hash = workspace_learning_policy_hash(workspace_mode, source_overrides)))),
    CONSTRAINT workspace_learning_policy_revisions_mode_chk CHECK ((workspace_mode = ANY (ARRAY['off'::text, 'suggest'::text, 'automatic'::text]))),
    CONSTRAINT workspace_learning_policy_revisions_operation_chk CHECK ((request_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workspace_learning_policy_revisions_overrides_chk CHECK (workspace_learning_policy_source_overrides_valid(source_overrides)),
    CONSTRAINT workspace_learning_policy_revisions_revision_chk CHECK ((revision > 0))
);

ALTER TABLE ONLY workspace_learning_policy_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_learning_policy_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    execution_generation integer NOT NULL,
    revision_id uuid,
    revision bigint,
    policy_hash text,
    activation_version bigint NOT NULL,
    activated_at timestamp with time zone,
    workspace_mode text NOT NULL,
    source_overrides jsonb NOT NULL,
    snapshot_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_learning_policy_snapshots_generation_chk CHECK ((execution_generation > 0)),
    CONSTRAINT workspace_learning_policy_snapshots_hash_chk CHECK (((snapshot_hash ~ '^[0-9a-f]{64}$'::text) AND (snapshot_hash = workspace_learning_policy_snapshot_hash(revision_id, revision, policy_hash, activation_version, activated_at, workspace_mode, source_overrides)))),
    CONSTRAINT workspace_learning_policy_snapshots_identity_chk CHECK ((((revision_id IS NULL) AND (revision IS NULL) AND (policy_hash IS NULL) AND (activation_version = 0) AND (activated_at IS NULL) AND (workspace_mode = ANY (ARRAY['off'::text, 'suggest'::text])) AND (source_overrides = '[]'::jsonb)) OR ((revision_id IS NOT NULL) AND (revision > 0) AND (policy_hash ~ '^[0-9a-f]{64}$'::text) AND (activation_version > 0) AND (activated_at IS NOT NULL)))),
    CONSTRAINT workspace_learning_policy_snapshots_mode_chk CHECK ((workspace_mode = ANY (ARRAY['off'::text, 'suggest'::text, 'automatic'::text]))),
    CONSTRAINT workspace_learning_policy_snapshots_overrides_chk CHECK (workspace_learning_policy_source_overrides_valid(source_overrides))
);

ALTER TABLE ONLY workspace_learning_policy_snapshots FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    subject_id text NOT NULL,
    subject_label text,
    role text DEFAULT 'member'::text NOT NULL,
    permissions jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE workspace_model_policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    allowed_providers text[],
    allowed_models text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY workspace_model_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_screenshot_quotas (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    ready_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_screenshot_quotas_nonnegative_chk CHECK (((reserved_bytes >= 0) AND (ready_bytes >= 0)))
);

ALTER TABLE ONLY workspace_screenshot_quotas FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_session_activity_revisions (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT workspace_session_activity_revisions_revision_check CHECK ((revision >= 0))
);

ALTER TABLE ONLY workspace_session_activity_revisions FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_variable_set_variables (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    variable_set_id uuid NOT NULL,
    name text NOT NULL,
    value_encrypted text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY workspace_variable_set_variables FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_variable_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    authority_id uuid,
    owner_organization_membership_id uuid,
    origin_workspace_id uuid,
    generation bigint DEFAULT 1 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT workspace_variable_sets_authority_scope_check CHECK ((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text, 'user'::text]))),
    CONSTRAINT workspace_variable_sets_authority_shape_check CHECK ((((authority_scope = ANY (ARRAY['organization'::text, 'workspace'::text])) AND (authority_id IS NULL) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (authority_id IS NOT NULL) AND (owner_organization_membership_id IS NOT NULL)))),
    CONSTRAINT workspace_variable_sets_generation_check CHECK ((generation > 0)),
    CONSTRAINT workspace_variable_sets_revocation_check CHECK ((((status = 'active'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL)))),
    CONSTRAINT workspace_variable_sets_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text])))
);

ALTER TABLE ONLY workspace_variable_sets FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN workspace_variable_sets.authority_scope IS 'Explicit owner scope: organization, workspace, or organization+user. Omitted legacy creation remains workspace-owned.';

COMMENT ON COLUMN workspace_variable_sets.generation IS 'Monotonic resource generation revalidated immediately before plaintext read or runtime materialization.';

CREATE TABLE workspace_video_generation_policies (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    enabled_model_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    default_model_id text,
    updated_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    funding_source text DEFAULT 'workspace_gateway'::text NOT NULL,
    CONSTRAINT workspace_video_generation_policies_funding_source_chk CHECK ((funding_source = ANY (ARRAY['opengeni_credits'::text, 'workspace_gateway'::text, 'supergrok_subscription'::text]))),
    CONSTRAINT workspace_video_generation_policies_models_chk CHECK (((jsonb_typeof(enabled_model_ids) = 'array'::text) AND (jsonb_array_length(enabled_model_ids) <= 16) AND ((default_model_id IS NULL) OR (enabled_model_ids ? default_model_id)))),
    CONSTRAINT workspace_video_generation_policies_revision_chk CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint)))
);

ALTER TABLE ONLY workspace_video_generation_policies FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_video_generation_quotas (
    workspace_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reserved_bytes bigint DEFAULT 0 NOT NULL,
    ready_bytes bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_video_generation_quotas_nonnegative_chk CHECK (((reserved_bytes >= 0) AND (ready_bytes >= 0)))
);

ALTER TABLE ONLY workspace_video_generation_quotas FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_webhook_deliveries (
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
    CONSTRAINT workspace_webhook_deliveries_attempts_chk CHECK ((attempts >= 0)),
    CONSTRAINT workspace_webhook_deliveries_claim_chk CHECK (((claim_id IS NULL) = (claim_until IS NULL))),
    CONSTRAINT workspace_webhook_deliveries_error_chk CHECK (((last_error IS NULL) OR (char_length(last_error) <= 2000))),
    CONSTRAINT workspace_webhook_deliveries_payload_chk CHECK ((octet_length((payload)::text) <= 16384)),
    CONSTRAINT workspace_webhook_deliveries_terminal_chk CHECK (((delivered_at IS NULL) OR (failed_at IS NULL)))
);

ALTER TABLE ONLY workspace_webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE TABLE workspace_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    url text NOT NULL,
    secret_encrypted text NOT NULL,
    event_types text[] NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    description text,
    created_by_subject_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_webhooks_description_chk CHECK (((description IS NULL) OR (char_length(description) <= 500))),
    CONSTRAINT workspace_webhooks_event_types_chk CHECK ((((cardinality(event_types) >= 1) AND (cardinality(event_types) <= 32)) AND (event_types <@ ARRAY['turn.completed'::text, 'turn.failed'::text, 'turn.cancelled'::text, 'session.status.changed'::text, 'session.requiresAction'::text, 'session.humanInput.requested'::text, 'session.notification.posted'::text, 'session.notification.withdrawn'::text, 'usage.threshold_reached'::text, 'usage.exhausted'::text, 'usage.period_reset'::text, 'recording.started'::text, 'recording.finished'::text, 'recording.transcript.ready'::text, 'recording.transcript.failed'::text, 'recording.transcript.current_changed'::text, 'recording.speakers.updated'::text, 'recording.notes.updated'::text, 'recording.deleted'::text]))),
    CONSTRAINT workspace_webhooks_subject_chk CHECK (((created_by_subject_id IS NULL) OR ((octet_length(created_by_subject_id) >= 1) AND (octet_length(created_by_subject_id) <= 1024)))),
    CONSTRAINT workspace_webhooks_url_chk CHECK ((((char_length(url) >= 8) AND (char_length(url) <= 2048)) AND ((url ~~ 'https://%'::text) OR (url ~~ 'http://%'::text))))
);

ALTER TABLE ONLY workspace_webhooks FORCE ROW LEVEL SECURITY;

CREATE TABLE workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    name text NOT NULL,
    slug text,
    external_source text,
    external_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    agent_instructions text,
    settings jsonb DEFAULT '{"memoryEnabled": true}'::jsonb NOT NULL,
    default_rig_id uuid,
    sandbox_viewer_force_drain_reason text,
    sandbox_viewer_force_drain_requested_at timestamp with time zone,
    CONSTRAINT workspaces_sandbox_viewer_force_drain_check CHECK ((((sandbox_viewer_force_drain_reason IS NULL) AND (sandbox_viewer_force_drain_requested_at IS NULL)) OR ((sandbox_viewer_force_drain_reason = ANY (ARRAY['balance'::text, 'warm_cap'::text])) AND (sandbox_viewer_force_drain_requested_at IS NOT NULL))))
);

CREATE TABLE xai_capacity_waiters (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    goal_id uuid,
    goal_version integer,
    blocked_turn_id uuid NOT NULL,
    blocked_turn_generation integer NOT NULL,
    workflow_id text NOT NULL,
    authority_scope text NOT NULL,
    owner_organization_membership_id uuid,
    status text DEFAULT 'waiting'::text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    earliest_reset_at timestamp with time zone,
    next_check_at timestamp with time zone NOT NULL,
    wake_revision integer DEFAULT 1 NOT NULL,
    observed_wake_revision integer DEFAULT 0 NOT NULL,
    last_wake_reason text DEFAULT 'capacity_wait_armed'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT xai_capacity_waiters_counters_chk CHECK (((blocked_turn_generation >= 0) AND (generation > 0) AND (wake_revision > 0) AND (observed_wake_revision >= 0) AND (observed_wake_revision <= wake_revision))),
    CONSTRAINT xai_capacity_waiters_goal_fence_chk CHECK ((((goal_id IS NULL) AND (goal_version IS NULL)) OR ((goal_id IS NOT NULL) AND (goal_version > 0)))),
    CONSTRAINT xai_capacity_waiters_scope_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL)))),
    CONSTRAINT xai_capacity_waiters_status_chk CHECK ((status = ANY (ARRAY['waiting'::text, 'resumed'::text, 'superseded'::text]))),
    CONSTRAINT xai_capacity_waiters_workflow_chk CHECK ((((length(btrim(workflow_id)) >= 1) AND (length(btrim(workflow_id)) <= 1024)) AND ((length(btrim(last_wake_reason)) >= 1) AND (length(btrim(last_wake_reason)) <= 256))))
);

ALTER TABLE ONLY xai_capacity_waiters FORCE ROW LEVEL SECURITY;

CREATE TABLE xai_credential_leases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    authority_scope text NOT NULL,
    owner_organization_membership_id uuid,
    credential_id uuid NOT NULL,
    turn_id uuid NOT NULL,
    holder_id text NOT NULL,
    generation integer DEFAULT 1 NOT NULL,
    leased_until timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT xai_credential_leases_generation_chk CHECK ((generation > 0)),
    CONSTRAINT xai_credential_leases_holder_chk CHECK (((length(btrim(holder_id)) >= 1) AND (length(btrim(holder_id)) <= 1024))),
    CONSTRAINT xai_credential_leases_scope_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL))))
);

ALTER TABLE ONLY xai_credential_leases FORCE ROW LEVEL SECURITY;

CREATE TABLE xai_rotation_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    owner_organization_membership_id uuid,
    active_credential_id uuid,
    rotation_enabled boolean DEFAULT true NOT NULL,
    fairness_cursor bigint DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT xai_rotation_scope_workspace_shape CHECK (((authority_scope = 'organization'::text) = (workspace_id IS NULL))),
    CONSTRAINT xai_rotation_settings_counters_chk CHECK (((fairness_cursor >= 0) AND (version > 0))),
    CONSTRAINT xai_rotation_settings_scope_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL))))
);

ALTER TABLE ONLY xai_rotation_settings FORCE ROW LEVEL SECURITY;

CREATE TABLE xai_session_account_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    session_id uuid NOT NULL,
    authority_scope text DEFAULT 'workspace'::text NOT NULL,
    owner_organization_membership_id uuid,
    pinned_credential_id uuid,
    pin_source text,
    last_credential_id uuid,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT xai_session_account_pins_pin_chk CHECK ((((pinned_credential_id IS NULL) AND (pin_source IS NULL)) OR ((pinned_credential_id IS NOT NULL) AND (pin_source = ANY (ARRAY['manual'::text, 'policy'::text]))))),
    CONSTRAINT xai_session_account_pins_scope_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL)))),
    CONSTRAINT xai_session_account_pins_version_chk CHECK ((version > 0))
);

ALTER TABLE ONLY xai_session_account_pins FORCE ROW LEVEL SECURITY;

CREATE TABLE xai_subscription_credentials (
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
    CONSTRAINT xai_credential_scope_workspace_shape CHECK (((authority_scope = 'organization'::text) = (workspace_id IS NULL))),
    CONSTRAINT xai_subscription_credentials_access_policy_shape CHECK (((access_policy_version > 0) AND (COALESCE(cardinality(allowed_model_ids), 0) <= 500) AND (COALESCE(cardinality(allowed_workspace_ids), 0) <= 500) AND (array_position(allowed_model_ids, NULL::text) IS NULL) AND (array_position(allowed_workspace_ids, NULL::uuid) IS NULL))),
    CONSTRAINT xai_subscription_credentials_authority_scope_chk CHECK ((authority_scope = ANY (ARRAY['workspace'::text, 'user'::text, 'organization'::text]))),
    CONSTRAINT xai_subscription_credentials_authority_shape_chk CHECK ((((authority_scope = ANY (ARRAY['workspace'::text, 'organization'::text])) AND (owner_organization_membership_id IS NULL) AND (organization_user_resource_authority_id IS NULL) AND (organization_user_resource_kind IS NULL) AND (organization_user_resource_authority_generation IS NULL)) OR ((authority_scope = 'user'::text) AND (owner_organization_membership_id IS NOT NULL) AND (organization_user_resource_authority_id IS NOT NULL) AND (organization_user_resource_kind = 'xai_subscription'::text) AND (organization_user_resource_authority_generation > 0)))),
    CONSTRAINT xai_subscription_credentials_quota_chk CHECK (((quota_used_percent IS NULL) OR ((quota_used_percent >= 0) AND (quota_used_percent <= 100)))),
    CONSTRAINT xai_subscription_credentials_selection_chk CHECK ((selection_count >= 0)),
    CONSTRAINT xai_subscription_credentials_status_chk CHECK ((status = ANY (ARRAY['active'::text, 'needs_relogin'::text, 'error'::text, 'disabled'::text]))),
    CONSTRAINT xai_subscription_credentials_subject_chk CHECK (((connected_by_subject_id IS NULL) OR ((length(btrim(connected_by_subject_id)) >= 1) AND (length(btrim(connected_by_subject_id)) <= 1024)))),
    CONSTRAINT xai_subscription_credentials_versions_chk CHECK (((version > 0) AND (allocator_version > 0)))
);

ALTER TABLE ONLY xai_subscription_credentials FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN xai_subscription_credentials.credential_encrypted IS 'Authenticated-encrypted xAI credential JSON; never returned by metadata list/read APIs.';

COMMENT ON COLUMN xai_subscription_credentials.connected_by_subject_id IS 'Connection audit attribution only; never ownership or executable authority.';

ALTER TABLE ONLY auth_runs ALTER COLUMN health_sequence SET DEFAULT nextval('auth_runs_health_sequence_seq'::regclass);

INSERT INTO opengeni_private.managed_auth_new_signups_switch_revisions (revision, signups_enabled, previous_signups_enabled, operator, reason, database_role, changed_at) OVERRIDING SYSTEM VALUE VALUES (1, true, NULL, 'migration:0596', 'Initial state: new sign-ups are open; the deployment flag remains the master switch.', CURRENT_USER, now());

INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('auth.sign_up', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('auth.email_verified', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('auth.sign_in', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('organization.setup', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('model.connected', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('credits.purchased', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('credits.granted', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('connection.created', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('connection.revoked', now(), NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('scheduled_task.created', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('skill.installed', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('slack.user_linked', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('machine.enrolled', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('member.joined', NULL, NULL, 0, 0, 0, 0, NULL, now());
INSERT INTO opengeni_private.product_lifecycle_backfill_progress (source, live_capture_from, materialized_at, materialized, cursor_seq, scanned, enqueued, completed_at, updated_at) VALUES ('user.active', now(), NULL, 0, 0, 0, 0, NULL, now());

INSERT INTO opengeni_private.sandbox_recovery_rollout (singleton, consent_enabled, release_evidence) VALUES (true, false, NULL);

INSERT INTO opengeni_private.session_tenancy_fence_target_registry (singleton, target_schema) VALUES (true, '{{schema}}');

INSERT INTO opengeni_private.subscription_codex_cutover_report (account_id, metric, legacy_count, core_count, recorded_at) VALUES (NULL, 'codex_cutover_rows', 0, 0, now());

INSERT INTO opengeni_private.subscription_core_plan_change_providers (provider) VALUES ('codex');

INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, primary_setting_column, created_at, connection_kind) VALUES ('codex', true, 'codex_primary_connection_id', now(), 'subscription');
INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, primary_setting_column, created_at, connection_kind) VALUES ('xai', false, 'xai_primary_connection_id', now(), 'subscription');
INSERT INTO opengeni_private.subscription_core_providers (provider, extra_credits, primary_setting_column, created_at, connection_kind) VALUES ('claude', false, 'claude_primary_connection_id', now(), 'subscription');

INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('codex', 'codex_cutover_rows', NULL, 0, 0, now());
INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('codex', 'readiness:owners_with_multiple_current_personal_generations', NULL, 0, 0, now());
INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('xai', 'xai_cutover_rows', NULL, 0, 0, now());
INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('xai', 'readiness:owners_with_multiple_current_personal_generations', NULL, 0, 0, now());
INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('claude', 'claude_cutover_rows', NULL, 0, 0, now());
INSERT INTO opengeni_private.subscription_cutover_report (provider, metric, account_id, legacy_count, core_count, recorded_at) VALUES ('claude', 'readiness:owners_with_multiple_current_personal_generations', NULL, 0, 0, now());

INSERT INTO opengeni_private.subscription_plan_catalog_revisions (revision, catalog, operator, reason, database_role, changed_at) OVERRIDING SYSTEM VALUE VALUES (1, '[{"key": "free", "label": "Free", "seatLimit": 5, "freeCredit": true, "stripePriceId": null, "monthlyPriceMicros": 0, "monthlyCreditMicros": 10000000}, {"key": "pro", "label": "Pro", "seatLimit": 10, "freeCredit": false, "stripePriceId": null, "monthlyPriceMicros": 20000000, "monthlyCreditMicros": 200000000}, {"key": "max", "label": "Max", "seatLimit": null, "freeCredit": false, "stripePriceId": null, "monthlyPriceMicros": 200000000, "monthlyCreditMicros": 2000000000}, {"key": "enterprise", "label": "Enterprise", "seatLimit": null, "freeCredit": false, "stripePriceId": null, "monthlyPriceMicros": null, "monthlyCreditMicros": 0}]', 'migration', 'Seed subscription plans without activating organizations', CURRENT_USER, now());

INSERT INTO opengeni_private.subscription_provider_cutover_receipts (provider, migration, committed_at, seed_rotation) VALUES ('codex', '0689_subscription_core_codex_cutover.sql', '-infinity', '{"mode": "spread"}');
INSERT INTO opengeni_private.subscription_provider_cutover_receipts (provider, migration, committed_at, seed_rotation) VALUES ('xai', '0747_subscription_core_xai_cutover.sql', now(), '{"mode": "spread"}');
INSERT INTO opengeni_private.subscription_provider_cutover_receipts (provider, migration, committed_at, seed_rotation) VALUES ('claude', '0748_subscription_core_claude_cutover.sql', now(), '{"mode": "spread"}');

INSERT INTO opengeni_private.verified_signup_trial_switch_revisions (revision, grants_enabled, previous_grants_enabled, operator, reason, database_role, changed_at) OVERRIDING SYSTEM VALUE VALUES (1, true, NULL, 'migration:0521', 'Initial state: the runtime switch allows grants; the deployment flag remains the master switch.', CURRENT_USER, now());

INSERT INTO audit_events (id, account_id, workspace_id, subject_id, action, target_type, target_id, metadata, occurred_at, metadata_codec_version) VALUES (gen_random_uuid(), NULL, NULL, 'system:migration:0739', 'vault.migrated', 'migration', NULL, '{"items": 0, "vaults": 0, "versions": 0, "migration": "0739_vaults.sql", "renamedItems": 0, "renamedVaults": 0, "skippedRevokedSets": 0}', now(), NULL);
INSERT INTO audit_events (id, account_id, workspace_id, subject_id, action, target_type, target_id, metadata, occurred_at, metadata_codec_version) VALUES (gen_random_uuid(), NULL, NULL, 'system:migration:0739', 'variable_set.values_retired', 'migration', NULL, '{"migration": "0739_vaults.sql", "removedValues": 0, "scrubbedLeases": 0, "scrubbedEnvelopes": 0}', now(), NULL);

INSERT INTO host_export_config (id, session_events_enabled, usage_events_enabled, updated_at, lifecycle_facts_enabled) VALUES (1, false, false, now(), false);

INSERT INTO host_export_cursor_state (export_kind, next_cursor, pruned_through, updated_at) VALUES ('session_event', 1, 0, now());
INSERT INTO host_export_cursor_state (export_kind, next_cursor, pruned_through, updated_at) VALUES ('usage_event', 1, 0, now());
INSERT INTO host_export_cursor_state (export_kind, next_cursor, pruned_through, updated_at) VALUES ('lifecycle_fact', 1, 0, now());

INSERT INTO nested_agent_depth_configuration (singleton, max_nested_agent_depth, policy_source, updated_at) VALUES (true, 3, 'default', now());

SELECT pg_catalog.setval('opengeni_private.credit_promotion_policy_revisions_revision_seq', 1, false);

SELECT pg_catalog.setval('opengeni_private.managed_auth_new_signups_switch_revisions_revision_seq', 1, true);
