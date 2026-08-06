import { sql } from "drizzle-orm";
import type { Database, RlsStrategy } from "./database";
import {
  classifyRoleRelationships,
  roleRelationshipsCatalogQuery,
  type RoleRelationshipCatalogRow,
} from "./role-relationships";

/**
 * Exact `opengeni_private` routines callable by the ordinary runtime role.
 *
 * This is the single audited routine contract shared by provisioning and
 * startup posture checks. Entries are either RLS policy helpers, direct
 * runtime call sites, or explicit `opengeni_app` grants in migrations. Trigger
 * handlers and governance-operator-only routines are intentionally absent:
 * trigger execution does not require direct runtime EXECUTE, and operator
 * authorization is a separate capability.
 */
export const RUNTIME_PRIVATE_FUNCTION_SIGNATURES = [
  "account_rls_visible(uuid)",
  "claim_due_transcription_recording_object_cleanup(bigint, bigint, integer)",
  "claim_expired_file_upload_cleanup(bigint, bigint, integer)",
  "claim_sandbox_checkpoint_artifacts(uuid, integer, bigint)",
  "claim_session_system_update_outbox(integer)",
  "claim_session_workflow_wakes(integer)",
  "claim_slack_interaction_delivery(uuid, integer)",
  "claim_slack_interaction_inbox(uuid, integer)",
  "claim_terminal_retained_processes(uuid, integer, bigint)",
  "count_active_retained_processes_by_owner_state()",
  "count_expired_draining_sandbox_leases()",
  "count_queued_turns()",
  "count_sandbox_leases_by_liveness()",
  "credit_balance_by_account()",
  "current_account_id()",
  "current_api_key_hash()",
  "current_memory_actor_id()",
  "current_memory_actor_kind()",
  "current_memory_role_key()",
  "current_memory_session_id()",
  "current_subject_id()",
  "current_workspace_id()",
  "enforce_sandbox_recovery_protocol_v2()",
  "list_continuable_sessions(uuid, uuid)",
  "list_legacy_modal_checkpoint_slots(integer)",
  "list_live_modal_sandbox_leases()",
  "list_meterable_warm_leases()",
  "list_sandbox_viewer_force_drain_workspaces()",
  "memory_scope_authorized(text, text, text, uuid)",
  "memory_scope_visible(text, text, text, uuid, timestamp with time zone, timestamp with time zone)",
  "optional_workspace_rls_visible(uuid, uuid)",
  "preference_registry_scope_visible(uuid, text, uuid, text)",
  "project_session_event_payload(jsonb)",
  "prune_deleted_sandbox_checkpoint_artifacts(bigint, integer)",
  "purge_expired_transcription_recordings(bigint, integer)",
  "reap_expired_session_list_snapshots(integer)",
  "reap_sandbox_leases(bigint, bigint)",
  "reap_sandbox_leases(bigint, bigint, bigint)",
  "request_due_sandbox_rotations(bigint, integer)",
  "resolve_device_enrollment_request(text)",
  "resolve_document_index_authority(uuid, uuid, uuid)",
  "resolve_pending_device_enrollment_by_user_code(text)",
  "resolve_slack_installation(text)",
  "sandbox_checkpoint_artifact_inventory()",
  "sandbox_rotation_backlog()",
  "scoped_knowledge_actor_authorized(text, text, text)",
  "scoped_knowledge_actor_valid(text, text, text)",
  "scoped_knowledge_scope_key(text, uuid, text)",
  "scoped_knowledge_scope_valid(text, uuid, text)",
  "scoped_knowledge_scope_visible(uuid, text, uuid, text)",
  "settle_sandbox_checkpoint_artifact(uuid, uuid, boolean, text, bigint)",
  "workspace_rls_visible(uuid, uuid)",
] as const;

/**
 * The complete standalone tenant-table contract. Adding or removing a
 * FORCE-RLS table is an architectural change: update this list in the same
 * commit as the migration so startup cannot silently accept an unreviewed gap.
 */
export const FORCE_RLS_TABLES = [
  "agent_run_states",
  "api_keys",
  "audit_events",
  "billing_customers",
  "capability_catalog_items",
  "capability_installations",
  "codex_apps_settings",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "codex_reset_redemption_attempts",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "composer_drafts",
  "connection_disconnect_operations",
  "connections",
  "connector_action_policies",
  "connector_action_requests",
  "credit_ledger_entries",
  "device_enrollment_requests",
  "document_bases",
  "document_chunks",
  "documents",
  "enrollments",
  "file_uploads",
  "files",
  "github_installation_repositories",
  "github_installations",
  "host_export_config",
  "host_export_consumers",
  "host_export_cursor_state",
  "host_export_dead_letters",
  "host_export_outbox",
  "import_batches",
  "integration_oauth_state_nonces",
  "knowledge_change_proposals",
  "knowledge_claim_evidence",
  "knowledge_claim_relations",
  "knowledge_claim_reviews",
  "knowledge_claims",
  "knowledge_document_versions",
  "knowledge_entities",
  "knowledge_entity_aliases",
  "knowledge_facts",
  "knowledge_lifecycle_events",
  "knowledge_memories",
  "knowledge_memory_lifecycle_events",
  "knowledge_memory_relationships",
  "knowledge_operation_receipts",
  "knowledge_providers",
  "knowledge_source_acl_versions",
  "knowledge_source_objects",
  "knowledge_sources",
  "knowledge_sync_runs",
  "machine_metrics_latest",
  "machine_metrics_series",
  "machine_removal_operations",
  "model_call_facts",
  "new_session_drafts",
  "organization_authorization_invalidations",
  "organization_governance_commands",
  "organization_recovery_approvals",
  "organization_recovery_audit",
  "organization_recovery_custodians",
  "organization_recovery_operations",
  "pack_installations",
  "preference_registry_events",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "preference_registry_snapshots",
  "retained_screenshot_artifacts",
  "rig_changes",
  "rig_versions",
  "rigs",
  "sandbox_checkpoint_artifacts",
  "sandbox_lease_holders",
  "sandbox_leases",
  "sandbox_pty_sessions",
  "sandbox_retained_processes",
  "sandbox_session_envelopes",
  "sandbox_workspace_mutation_admissions",
  "sandboxes",
  "scheduled_task_runs",
  "scheduled_tasks",
  "session_attempt_interruptions",
  "session_command_receipts",
  "session_events",
  "session_goals",
  "session_history_items",
  "session_human_input_requests",
  "session_list_snapshots",
  "session_mcp_servers",
  "session_pending_tool_calls",
  "session_pins",
  "session_realtime_connections",
  "session_realtime_context_projections",
  "session_realtime_entries",
  "session_realtime_modes",
  "session_recordings",
  "session_spawn_denials",
  "session_stream_acknowledgments",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turn_attempts",
  "session_turns",
  "session_workflow_wake_outbox",
  "sessions",
  "slack_bot_delete_operations",
  "slack_bot_post_operations",
  "slack_bot_user_links",
  "slack_interaction_inbox",
  "slack_interaction_progress_deliveries",
  "slack_interactions",
  "social_connections",
  "social_posts",
  "transcription_recording_chunks",
  "transcription_recording_objects",
  "transcription_recording_segments",
  "transcription_recordings",
  "usage_events",
  "workspace_artifact_events",
  "workspace_artifact_versions",
  "workspace_artifacts",
  "workspace_captures",
  "workspace_control_events",
  "workspace_inference_controls",
  "workspace_instruction_policy_activation_events",
  "workspace_instruction_policy_heads",
  "workspace_instruction_policy_onboarding_proposals",
  "workspace_instruction_policy_revisions",
  "workspace_instruction_policy_snapshots",
  "workspace_model_policies",
  "workspace_packs",
  "workspace_screenshot_quotas",
  "workspace_session_activity_revisions",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
] as const;

/**
 * Deployment-global and authentication tables used by ordinary API/worker
 * traffic. They intentionally do not carry workspace RLS: their access model
 * is implemented by the authentication/access layer or by exact global keys.
 */
export const NON_RLS_RUNTIME_TABLES = [
  "auth_identities",
  "auth_rate_limits",
  "auth_sessions",
  "auth_users",
  "auth_verifications",
  "integration_oauth_clients",
  "managed_accounts",
  "nested_agent_depth_configuration",
  "stripe_webhook_events",
  "workspace_memberships",
  "workspaces",
] as const;

/**
 * Exact full-CRUD class for the standalone runtime role. This is deliberately
 * explicit instead of being derived from FORCE_RLS_TABLES: adding a protected
 * table must not silently grant it broader DML than its migration intended.
 */
export const RUNTIME_FULL_DML_TABLES = [
  "agent_run_states",
  "api_keys",
  "audit_events",
  "auth_identities",
  "auth_rate_limits",
  "auth_sessions",
  "auth_users",
  "auth_verifications",
  "billing_customers",
  "capability_catalog_items",
  "capability_installations",
  "codex_apps_settings",
  "codex_capacity_waiters",
  "codex_credential_leases",
  "codex_reset_redemption_attempts",
  "codex_rotation_settings",
  "codex_subscription_credentials",
  "composer_drafts",
  "connection_disconnect_operations",
  "connections",
  "connector_action_policies",
  "connector_action_requests",
  "credit_ledger_entries",
  "device_enrollment_requests",
  "document_bases",
  "document_chunks",
  "documents",
  "enrollments",
  "file_uploads",
  "files",
  "github_installation_repositories",
  "github_installations",
  "import_batches",
  "integration_oauth_clients",
  "integration_oauth_state_nonces",
  "knowledge_memories",
  "machine_metrics_latest",
  "machine_metrics_series",
  "machine_removal_operations",
  "managed_accounts",
  "model_call_facts",
  "new_session_drafts",
  "pack_installations",
  "retained_screenshot_artifacts",
  "rig_changes",
  "rig_versions",
  "rigs",
  "sandbox_checkpoint_artifacts",
  "sandbox_lease_holders",
  "sandbox_leases",
  "sandbox_pty_sessions",
  "sandbox_retained_processes",
  "sandbox_session_envelopes",
  "sandbox_workspace_mutation_admissions",
  "sandboxes",
  "scheduled_task_runs",
  "scheduled_tasks",
  "session_attempt_interruptions",
  "session_command_receipts",
  "session_events",
  "session_goals",
  "session_history_items",
  "session_human_input_requests",
  "session_list_snapshots",
  "session_mcp_servers",
  "session_pending_tool_calls",
  "session_pins",
  "session_realtime_connections",
  "session_realtime_context_projections",
  "session_realtime_entries",
  "session_realtime_modes",
  "session_recordings",
  "session_stream_acknowledgments",
  "session_system_update_outbox",
  "session_system_updates",
  "session_turn_attempts",
  "session_turns",
  "session_workflow_wake_outbox",
  "sessions",
  "slack_bot_delete_operations",
  "slack_bot_post_operations",
  "slack_bot_user_links",
  "slack_interaction_inbox",
  "slack_interaction_progress_deliveries",
  "slack_interactions",
  "social_connections",
  "social_posts",
  "stripe_webhook_events",
  "transcription_recording_chunks",
  "transcription_recording_objects",
  "transcription_recording_segments",
  "transcription_recordings",
  "usage_events",
  "workspace_artifacts",
  "workspace_captures",
  "workspace_control_events",
  "workspace_inference_controls",
  "workspace_instruction_policy_heads",
  "workspace_memberships",
  "workspace_model_policies",
  "workspace_packs",
  "workspace_screenshot_quotas",
  "workspace_session_activity_revisions",
  "workspace_variable_set_variables",
  "workspace_variable_sets",
  "workspaces",
] as const;

/** Configuration and lifecycle-owned audit rows are read-only at runtime. */
export const RUNTIME_READ_ONLY_TABLES = [
  "knowledge_lifecycle_events",
  "knowledge_memory_lifecycle_events",
  "knowledge_memory_relationships",
  "nested_agent_depth_configuration",
  "preference_registry_events",
  "preference_registry_snapshots",
  "workspace_instruction_policy_snapshots",
] as const;

/** Append-only evidence/revision tables are insertable and queryable, never mutable. */
export const RUNTIME_READ_INSERT_TABLES = [
  "knowledge_change_proposals",
  "knowledge_claim_evidence",
  "knowledge_claim_relations",
  "knowledge_claim_reviews",
  "knowledge_claims",
  "knowledge_document_versions",
  "knowledge_entities",
  "knowledge_entity_aliases",
  "knowledge_facts",
  "knowledge_operation_receipts",
  "knowledge_providers",
  "knowledge_source_acl_versions",
  "knowledge_source_objects",
  "knowledge_sources",
  "knowledge_sync_runs",
  "preference_registry_preferences",
  "preference_registry_revisions",
  "session_spawn_denials",
  "workspace_artifact_events",
  "workspace_artifact_versions",
  "workspace_instruction_policy_activation_events",
  "workspace_instruction_policy_onboarding_proposals",
  "workspace_instruction_policy_revisions",
] as const;

/**
 * These FORCE-RLS tables are owned by security-definer host-export routines.
 * The ordinary application role must have no direct table privileges on them.
 */
export const PROTECTED_NO_DIRECT_DML_TABLES = [
  "host_export_config",
  "host_export_consumers",
  "host_export_cursor_state",
  "host_export_dead_letters",
  "host_export_outbox",
  "organization_authorization_invalidations",
  "organization_governance_commands",
  "organization_recovery_approvals",
  "organization_recovery_audit",
  "organization_recovery_custodians",
  "organization_recovery_operations",
] as const;

export type RuntimeTableDmlPrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
export type RuntimeTablePrivilegeContract = Readonly<
  Record<string, readonly RuntimeTableDmlPrivilege[]>
>;

const FULL_DML_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/** Exact per-table DML contract. Absence means no direct table privileges. */
export const RUNTIME_TABLE_PRIVILEGES: RuntimeTablePrivilegeContract = Object.freeze({
  ...Object.fromEntries(RUNTIME_FULL_DML_TABLES.map((table) => [table, FULL_DML_PRIVILEGES])),
  ...Object.fromEntries(RUNTIME_READ_ONLY_TABLES.map((table) => [table, ["SELECT"] as const])),
  ...Object.fromEntries(
    RUNTIME_READ_INSERT_TABLES.map((table) => [table, ["SELECT", "INSERT"] as const]),
  ),
});

function mergeTablePrivilegeContracts(
  ...contracts: RuntimeTablePrivilegeContract[]
): RuntimeTablePrivilegeContract {
  const tableNames = new Set<string>();
  for (const contract of contracts) {
    for (const tableName of Object.keys(contract)) tableNames.add(tableName);
  }
  return Object.freeze(
    Object.fromEntries(
      [...tableNames]
        .sort((a, b) => a.localeCompare(b))
        .map((tableName) => [
          tableName,
          (["SELECT", "INSERT", "UPDATE", "DELETE"] as const).filter((privilege) =>
            contracts.some((contract) => contract[tableName]?.includes(privilege)),
          ),
        ]),
    ),
  ) as RuntimeTablePrivilegeContract;
}

/**
 * Exact table contract for the enabled v2 serving role. New API/worker
 * binaries use this one principal for ordinary application traffic and the
 * organization-governance recovery plane, so the posture and provisioning
 * checks must describe the same complete surface.
 */
export const ENABLED_V2_PROTECTED_TABLES = FORCE_RLS_TABLES;
export const ENABLED_V2_TABLE_PRIVILEGES = mergeTablePrivilegeContracts(
  RUNTIME_TABLE_PRIVILEGES,
  Object.freeze({
    organization_authorization_invalidations: ["SELECT", "INSERT"] as const,
    organization_governance_commands: ["SELECT", "INSERT", "UPDATE"] as const,
    organization_recovery_approvals: FULL_DML_PRIVILEGES,
    organization_recovery_audit: ["SELECT", "INSERT"] as const,
    organization_recovery_custodians: FULL_DML_PRIVILEGES,
    organization_recovery_operations: FULL_DML_PRIVILEGES,
  }),
);
export const ENABLED_V2_PROTECTED_NO_DIRECT_DML_TABLES = Object.freeze(
  PROTECTED_NO_DIRECT_DML_TABLES.filter((tableName) => !(tableName in ENABLED_V2_TABLE_PRIVILEGES)),
);

/** All tables with any direct runtime DML; retained as the aggregate public contract. */
export const RUNTIME_DML_TABLES = Object.freeze(
  Object.keys(RUNTIME_TABLE_PRIVILEGES).sort((a, b) => a.localeCompare(b)),
);

export type RuntimeDatabasePostureOptions = {
  rlsStrategy: RlsStrategy;
  expectedRole?: string;
  targetSchema?: string;
  protectedTables?: readonly string[];
  tablePrivileges?: RuntimeTablePrivilegeContract;
  protectedNoDirectDmlTables?: readonly string[];
  /** Override only for focused synthetic tests or an explicitly smaller host contract. */
  privateRoutineSignatures?: readonly string[];
};

export type RuntimeDatabaseIdentity = {
  currentUser: string;
  sessionUser: string;
  databaseOwner: string;
  canConnectDatabase: boolean;
  canCreateInDatabase: boolean;
  rowSecurity: string;
  canLogin: boolean;
  superuser: boolean;
  inherit: boolean;
  createRole: boolean;
  createDatabase: boolean;
  replication: boolean;
  bypassRls: boolean;
};

export type RuntimeSchemaPosture = {
  name: string;
  owner: string;
  usage: boolean;
  create: boolean;
};

export type RuntimeTablePosture = {
  name: string;
  owner: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  rlsActive: boolean;
  policyCount: number;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  truncate: boolean;
  references: boolean;
  trigger: boolean;
};

export type RuntimeRoutinePosture = {
  name: string;
  owner: string;
  execute: boolean;
};

export type RuntimeDatabasePosture = {
  identity: RuntimeDatabaseIdentity;
  /** Privilege-bearing role relationships; exact PG16+ management-only grants are excluded. */
  memberships: string[];
  schemas: RuntimeSchemaPosture[];
  ownedSchemas: string[];
  ownedRelations: string[];
  tables: RuntimeTablePosture[];
  privateRoutines: RuntimeRoutinePosture[];
};

export class RuntimeDatabasePostureError extends Error {
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`Runtime database posture check failed: ${violations.join("; ")}`);
    this.name = "RuntimeDatabasePostureError";
    this.violations = violations;
  }
}

type IdentityRow = {
  current_user: string;
  session_user: string;
  database_owner: string;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  row_security: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return result as T[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows)) {
    return rows as T[];
  }
  throw new Error("Runtime database posture query returned an unsupported result shape");
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return sorted([...left].filter((value) => !right.has(value)));
}

/** Inspect only PostgreSQL catalogs and privilege functions; no tenant rows. */
export async function inspectRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const targetSchema = options.targetSchema?.trim() || "public";

  return await db.transaction(
    async (tx) => {
      const identityRows = resultRows<IdentityRow>(
        await tx.execute(sql`
          select
            current_user::text as current_user,
            session_user::text as session_user,
            pg_get_userbyid(d.datdba)::text as database_owner,
            has_database_privilege(current_user, d.oid, 'CONNECT') as can_connect_database,
            has_database_privilege(current_user, d.oid, 'CREATE') as can_create_in_database,
            current_setting('row_security')::text as row_security,
            r.rolcanlogin,
            r.rolsuper,
            r.rolinherit,
            r.rolcreaterole,
            r.rolcreatedb,
            r.rolreplication,
            r.rolbypassrls
          from pg_roles r
          join pg_database d on d.datname = current_database()
          where r.rolname = current_user
        `),
      );
      const identity = identityRows[0];
      if (!identity) {
        throw new Error("Runtime database posture could not resolve the current PostgreSQL role");
      }

      const mappedIdentity: RuntimeDatabaseIdentity = {
        currentUser: identity.current_user,
        sessionUser: identity.session_user,
        databaseOwner: identity.database_owner,
        canConnectDatabase: identity.can_connect_database,
        canCreateInDatabase: identity.can_create_in_database,
        rowSecurity: identity.row_security,
        canLogin: identity.rolcanlogin,
        superuser: identity.rolsuper,
        inherit: identity.rolinherit,
        createRole: identity.rolcreaterole,
        createDatabase: identity.rolcreatedb,
        replication: identity.rolreplication,
        bypassRls: identity.rolbypassrls,
      };

      // Scoped/embedded topology deliberately leaves ownership and isolation to
      // the host. Prove the connection identity is coherent, but do not impose
      // the standalone opengeni_app object/grant contract on the host's role.
      if (options.rlsStrategy === "scoped") {
        return {
          identity: mappedIdentity,
          memberships: [],
          schemas: [],
          ownedSchemas: [],
          ownedRelations: [],
          tables: [],
          privateRoutines: [],
        };
      }

      const relationshipRows = resultRows<RoleRelationshipCatalogRow>(
        await tx.execute(sql.raw(roleRelationshipsCatalogQuery("current_user"))),
      );
      const memberships = classifyRoleRelationships(relationshipRows).unsafeRelationships;

      const schemas = resultRows<{
        name: string;
        owner: string;
        usage: boolean;
        create: boolean;
      }>(
        await tx.execute(sql`
          select
            n.nspname::text as name,
            pg_get_userbyid(n.nspowner)::text as owner,
            has_schema_privilege(current_user, n.oid, 'USAGE') as usage,
            has_schema_privilege(current_user, n.oid, 'CREATE') as create
          from pg_namespace n
          where n.nspname in (${targetSchema}, 'opengeni_private')
          order by n.nspname
        `),
      );

      const ownedSchemas = resultRows<{ name: string }>(
        await tx.execute(sql`
          select n.nspname::text as name
          from pg_namespace n
          join pg_roles r on r.oid = n.nspowner
          where r.rolname = current_user
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname
        `),
      ).map((row) => row.name);

      const ownedRelations = resultRows<{ name: string }>(
        await tx.execute(sql`
          select (n.nspname || '.' || c.relname)::text as name
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          join pg_roles r on r.oid = c.relowner
          where r.rolname = current_user
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
            and n.nspname <> 'information_schema'
            and n.nspname !~ '^pg_'
          order by n.nspname, c.relname
        `),
      ).map((row) => row.name);

      const tables = resultRows<{
        name: string;
        owner: string;
        rls_enabled: boolean;
        rls_forced: boolean;
        rls_active: boolean;
        policy_count: number;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
        can_references: boolean;
        can_trigger: boolean;
      }>(
        await tx.execute(sql`
          select
            c.relname::text as name,
            pg_get_userbyid(c.relowner)::text as owner,
            c.relrowsecurity as rls_enabled,
            c.relforcerowsecurity as rls_forced,
            row_security_active(c.oid) as rls_active,
            (select count(*)::int from pg_policy policy where policy.polrelid = c.oid) as policy_count,
            has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
            has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
            has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
            has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate,
            has_table_privilege(current_user, c.oid, 'REFERENCES') as can_references,
            has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${targetSchema}
            and c.relkind in ('r', 'p')
          order by c.relname
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        rlsEnabled: row.rls_enabled,
        rlsForced: row.rls_forced,
        rlsActive: row.rls_active,
        policyCount: row.policy_count,
        select: row.can_select,
        insert: row.can_insert,
        update: row.can_update,
        delete: row.can_delete,
        truncate: row.can_truncate,
        references: row.can_references,
        trigger: row.can_trigger,
      }));

      const privateRoutines = resultRows<{
        name: string;
        owner: string;
        can_execute: boolean;
      }>(
        await tx.execute(sql`
          select
            (
              p.proname || '(' || coalesce(
                (
                  select string_agg(format_type(argument.argtype, null), ', ' order by argument.ordinality)
                  from unnest(p.proargtypes) with ordinality as argument(argtype, ordinality)
                ),
                ''
              ) || ')'
            )::text as name,
            pg_get_userbyid(p.proowner)::text as owner,
            has_function_privilege(current_user, p.oid, 'EXECUTE') as can_execute
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'opengeni_private'
            and p.prokind in ('f', 'p')
          order by p.proname, pg_get_function_identity_arguments(p.oid)
        `),
      ).map((row) => ({
        name: row.name,
        owner: row.owner,
        execute: row.can_execute,
      }));

      return {
        identity: mappedIdentity,
        memberships,
        schemas,
        ownedSchemas,
        ownedRelations,
        tables,
        privateRoutines,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** Pure deterministic evaluator used by startup/readiness and unit tests. */
export function evaluateRuntimeDatabasePosture(
  posture: RuntimeDatabasePosture,
  options: RuntimeDatabasePostureOptions,
): string[] {
  const violations: string[] = [];
  const identity = posture.identity;

  if (!identity.currentUser || !identity.sessionUser) {
    violations.push("database identity is empty");
  }
  if (identity.currentUser !== identity.sessionUser) {
    violations.push(
      `current_user ${identity.currentUser} does not match session_user ${identity.sessionUser}`,
    );
  }
  if (!identity.canConnectDatabase) {
    violations.push("runtime role lacks CONNECT on the current database");
  }

  if (options.rlsStrategy === "scoped") {
    return violations;
  }

  const expectedRole = options.expectedRole?.trim() || "opengeni_app";
  const targetSchema = options.targetSchema?.trim() || "public";
  const protectedTables = new Set(options.protectedTables ?? FORCE_RLS_TABLES);
  const tablePrivileges = options.tablePrivileges ?? RUNTIME_TABLE_PRIVILEGES;
  const directRuntimeTables = new Set(Object.keys(tablePrivileges));
  const protectedNoDirectDmlTables = new Set(
    options.protectedNoDirectDmlTables ??
      (options.protectedTables ? [] : PROTECTED_NO_DIRECT_DML_TABLES),
  );

  if (identity.currentUser !== expectedRole || identity.sessionUser !== expectedRole) {
    violations.push(
      `runtime identity must be ${expectedRole} (current_user=${identity.currentUser}, session_user=${identity.sessionUser})`,
    );
  }
  if (!identity.canLogin) violations.push("runtime role is not LOGIN");
  if (identity.superuser) violations.push("runtime role is SUPERUSER");
  if (identity.bypassRls) violations.push("runtime role has BYPASSRLS");
  if (identity.createRole) violations.push("runtime role has CREATEROLE");
  if (identity.createDatabase) violations.push("runtime role has CREATEDB");
  if (identity.replication) violations.push("runtime role has REPLICATION");
  if (identity.inherit) violations.push("runtime role must be NOINHERIT");
  if (identity.databaseOwner === expectedRole) violations.push("runtime role owns the database");
  if (identity.canCreateInDatabase) {
    violations.push("runtime role has CREATE on the current database");
  }
  if (identity.rowSecurity.toLowerCase() !== "on") {
    violations.push(`row_security is ${identity.rowSecurity}, expected on`);
  }
  if (posture.memberships.length > 0) {
    violations.push(`runtime role has memberships: ${sorted(posture.memberships).join(", ")}`);
  }
  if (posture.ownedSchemas.length > 0) {
    violations.push(`runtime role owns schemas: ${sorted(posture.ownedSchemas).join(", ")}`);
  }
  if (posture.ownedRelations.length > 0) {
    violations.push(`runtime role owns relations: ${sorted(posture.ownedRelations).join(", ")}`);
  }

  for (const schemaName of new Set([targetSchema, "opengeni_private"])) {
    const schema = posture.schemas.find((candidate) => candidate.name === schemaName);
    if (!schema) {
      violations.push(`required schema ${schemaName} is missing`);
      continue;
    }
    if (schema.owner === expectedRole) {
      violations.push(`runtime role owns schema ${schemaName}`);
    }
    if (!schema.usage) violations.push(`runtime role lacks USAGE on schema ${schemaName}`);
    if (schema.create) violations.push(`runtime role has CREATE on schema ${schemaName}`);
  }

  const tableByName = new Map(posture.tables.map((table) => [table.name, table]));
  const actualRlsTables = new Set(
    posture.tables.filter((table) => table.rlsEnabled).map((table) => table.name),
  );
  const classifiedProtectedTables = new Set([
    ...directRuntimeTables,
    ...protectedNoDirectDmlTables,
  ]);
  const unclassifiedProtectedTables = difference(protectedTables, classifiedProtectedTables);
  if (unclassifiedProtectedTables.length > 0) {
    violations.push(
      `protected tables lack an explicit privilege class: ${unclassifiedProtectedTables.join(", ")}`,
    );
  }
  const protectedNoDirectDmlOverlap = difference(
    protectedNoDirectDmlTables,
    new Set([...protectedNoDirectDmlTables].filter((table) => !directRuntimeTables.has(table))),
  );
  if (protectedNoDirectDmlOverlap.length > 0) {
    violations.push(
      `protected no-direct-DML tables also declare runtime privileges: ${protectedNoDirectDmlOverlap.join(", ")}`,
    );
  }
  const nonProtectedNoDirectDmlTables = difference(protectedNoDirectDmlTables, protectedTables);
  if (nonProtectedNoDirectDmlTables.length > 0) {
    violations.push(
      `no-direct-DML tables are absent from the protected contract: ${nonProtectedNoDirectDmlTables.join(", ")}`,
    );
  }
  const catalogTables = new Set(tableByName.keys());
  const missingRuntimeTables = difference(directRuntimeTables, catalogTables);
  if (missingRuntimeTables.length > 0) {
    violations.push(`runtime privilege tables are missing: ${missingRuntimeTables.join(", ")}`);
  }
  const missingTables = difference(protectedTables, catalogTables);
  if (missingTables.length > 0) {
    violations.push(`protected tables are missing: ${missingTables.join(", ")}`);
  }
  const undeclaredRlsTables = difference(actualRlsTables, protectedTables);
  if (undeclaredRlsTables.length > 0) {
    violations.push(
      `RLS tables are absent from the declared contract: ${undeclaredRlsTables.join(", ")}`,
    );
  }

  for (const table of posture.tables) {
    const privileges = [
      ["SELECT", table.select],
      ["INSERT", table.insert],
      ["UPDATE", table.update],
      ["DELETE", table.delete],
      ["TRUNCATE", table.truncate],
      ["REFERENCES", table.references],
      ["TRIGGER", table.trigger],
    ] as const;
    const expectedPrivileges = new Set<string>(tablePrivileges[table.name] ?? []);
    if (table.owner === expectedRole) {
      violations.push(`runtime role owns table ${table.name}`);
    }
    const missingPrivileges = privileges
      .filter(([privilege, granted]) => expectedPrivileges.has(privilege) && !granted)
      .map(([privilege]) => privilege);
    if (missingPrivileges.length > 0) {
      violations.push(
        `table ${table.name} lacks required runtime privileges: ${missingPrivileges.join(", ")}`,
      );
    }
    const excessPrivileges = privileges
      .filter(([privilege, granted]) => !expectedPrivileges.has(privilege) && granted)
      .map(([privilege]) => privilege);
    if (excessPrivileges.length > 0) {
      violations.push(
        `table ${table.name} grants excess runtime privileges: ${excessPrivileges.join(", ")}`,
      );
    }
  }

  for (const tableName of protectedTables) {
    const table = tableByName.get(tableName);
    if (!table) continue;
    if (!table.rlsEnabled) violations.push(`table ${tableName} does not ENABLE RLS`);
    if (!table.rlsForced) violations.push(`table ${tableName} does not FORCE RLS`);
    if (!table.rlsActive) violations.push(`table ${tableName} has inactive RLS for runtime role`);
    if (table.policyCount < 1) violations.push(`table ${tableName} has no RLS policy`);
  }

  if (posture.privateRoutines.length === 0) {
    violations.push("opengeni_private has no helper routines");
  }
  const expectedPrivateRoutines = new Set(
    options.privateRoutineSignatures ?? RUNTIME_PRIVATE_FUNCTION_SIGNATURES,
  );
  const actualPrivateRoutines = new Map(
    posture.privateRoutines.map((routine) => [routine.name, routine]),
  );
  for (const expectedRoutine of expectedPrivateRoutines) {
    if (!actualPrivateRoutines.has(expectedRoutine)) {
      violations.push(`expected private routine is missing: ${expectedRoutine}`);
    }
  }
  for (const routine of posture.privateRoutines) {
    if (routine.owner === expectedRole) {
      violations.push(`runtime role owns private routine ${routine.name}`);
    }
    if (expectedPrivateRoutines.has(routine.name) && !routine.execute) {
      violations.push(`runtime role lacks EXECUTE on private routine ${routine.name}`);
    }
    if (!expectedPrivateRoutines.has(routine.name) && routine.execute) {
      violations.push(`runtime role has unexpected EXECUTE on private routine ${routine.name}`);
    }
  }

  return violations;
}

export async function assertRuntimeDatabasePosture(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): Promise<RuntimeDatabasePosture> {
  const posture = await inspectRuntimeDatabasePosture(db, options);
  const violations = evaluateRuntimeDatabasePosture(posture, options);
  if (violations.length > 0) {
    throw new RuntimeDatabasePostureError(violations);
  }
  return posture;
}

export function runtimeDatabaseReadyCheck(
  db: Database,
  options: RuntimeDatabasePostureOptions,
): () => Promise<void> {
  return async () => {
    await assertRuntimeDatabasePosture(db, options);
  };
}
