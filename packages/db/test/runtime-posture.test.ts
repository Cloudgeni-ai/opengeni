import { describe, expect, test } from "bun:test";
import {
  evaluateRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  NON_RLS_RUNTIME_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_INSERT_UPDATE_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_READ_UPDATE_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
  RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES,
  RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES,
  RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES,
  type RuntimeDatabasePosture,
  type RuntimeDatabasePostureOptions,
  type RuntimeTablePosture,
} from "../src/runtime-posture";

const options: RuntimeDatabasePostureOptions = {
  rlsStrategy: "force",
  expectedRole: "opengeni_app",
  targetSchema: "public",
  protectedTables: ["tenant_rows"],
  tablePrivileges: {
    tenant_rows: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  },
  protectedNoDirectDmlTables: [],
};

function knowledgeAuthorityTables(): RuntimeTablePosture[] {
  return ["knowledge_sources", "knowledge_source_objects"].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function googleDriveAuthorityTables(): RuntimeTablePosture[] {
  return [
    "connections",
    "files",
    "google_drive_object_acl_evidence",
    "google_drive_object_acl_principals",
    "knowledge_document_versions",
    "knowledge_providers",
    "knowledge_source_sync_index_obligations",
    "knowledge_source_sync_states",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function canonicalHumanIdentityAuthorityTables(): RuntimeTablePosture[] {
  return [
    "canonical_human_identities",
    "canonical_human_identity_operations",
    "canonical_human_identity_subjects",
    "canonical_human_login_bindings",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

const managedAuthSessionSetAuthorityTableNames = [
  "managed_auth_actor_mutation_leases",
  "managed_auth_browser_installations",
  "managed_auth_login_return_intents",
  "managed_auth_login_slots",
  "managed_auth_login_transaction_rate_limits",
  "managed_auth_login_transactions",
  "managed_auth_session_set_operations",
  "managed_auth_session_sets",
] as const;

const organizationRecoveryAuthorityTableNames = [
  "organization_recovery_approvals",
  "organization_recovery_command_receipts",
  "organization_recovery_custodian_acceptances",
  "organization_recovery_custodians",
  "organization_recovery_events",
  "organization_recovery_notification_attempts",
  "organization_recovery_notification_outbox",
  "organization_recovery_operations",
  "organization_recovery_policies",
  "organization_recovery_policy_heads",
] as const;

function managedAuthSessionSetAuthorityTables(): RuntimeTablePosture[] {
  return managedAuthSessionSetAuthorityTableNames.map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function organizationRecoveryAuthorityTables(): RuntimeTablePosture[] {
  return organizationRecoveryAuthorityTableNames.map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function companyBrainPreferenceAuthorityTables(): RuntimeTablePosture[] {
  return [
    "company_brain_preference_proposal_receipts",
    "knowledge_change_proposals",
    "knowledge_claim_evidence",
    "knowledge_claim_reviews",
    "knowledge_claims",
    "preference_registry_events",
    "preference_registry_preferences",
    "preference_registry_revisions",
    "session_attempt_interruptions",
    "session_turn_attempts",
    "session_turns",
    "sessions",
    "workspaces",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function companyProfileAgentAdminAuthorityTables(): RuntimeTablePosture[] {
  return [
    "company_profile_activation_events",
    "company_profile_agent_automatic_activation_receipts",
    "company_profile_agent_confirmation_receipts",
    "company_profile_agent_proposal_receipts",
    "company_profile_heads",
    "company_profile_revisions",
    "managed_accounts",
    "organization_company_profile_agent_policies",
    "organization_company_profile_agent_policy_events",
    "session_human_input_requests",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function organizationMembershipLifecycleAuthorityTables(): RuntimeTablePosture[] {
  return [
    "additional_organization_creation_receipts",
    "organization_invitation_binding_events",
    "organization_membership_invitations",
    "organization_membership_lifecycle_events",
    "organization_membership_operation_receipts",
    "organization_memberships",
    "organization_profile_events",
    "organization_shared_workspace_administration_capabilities",
    "organization_user_setup_deliveries",
    "organization_user_setup_delivery_attempts",
    "organization_workspace_lifecycle_events",
    "organization_workspace_operation_receipts",
    "organization_user_resource_authorities",
    "organization_user_resource_grants",
    "organization_user_retention_deletion_events",
    "organization_user_retention_deletions",
    "organization_user_retention_object_deletion_receipts",
    "organization_user_retention_object_obligations",
    "organization_user_retention_policies",
    "organization_user_setup_intents",
    "self_service_organization_setup_receipts",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function organizationPrivateSessionAuthorityTables(): RuntimeTablePosture[] {
  return [
    "managed_accounts",
    "organization_private_session_setting_events",
    "organization_private_session_settings",
    "session_tenancy_activations",
  ].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function xaiAuthorityTables(): RuntimeTablePosture[] {
  return ["workspace_memberships", "xai_subscription_credentials"].map((name) => ({
    name,
    owner: "opengeni_migrator",
    rlsEnabled: false,
    rlsForced: false,
    rlsActive: false,
    policyCount: 0,
    artifactOutboxDispatcherPolicy: false,
    artifactMaterializerPolicy: false,
    select: false,
    insert: false,
    update: false,
    delete: false,
    truncate: false,
    references: false,
    trigger: false,
  }));
}

function safePosture(): RuntimeDatabasePosture {
  return {
    identity: {
      currentUser: "opengeni_app",
      sessionUser: "opengeni_app",
      databaseOwner: "opengeni_migrator",
      canConnectDatabase: true,
      canCreateInDatabase: false,
      rowSecurity: "on",
      canLogin: true,
      superuser: false,
      inherit: false,
      createRole: false,
      createDatabase: false,
      replication: false,
      bypassRls: false,
    },
    memberships: [],
    schemas: [
      {
        name: "public",
        owner: "opengeni_migrator",
        usage: true,
        create: false,
      },
      {
        name: "opengeni_private",
        owner: "opengeni_migrator",
        usage: true,
        create: false,
      },
    ],
    ownedSchemas: [],
    ownedRelations: [],
    sessionTenancyProductActivationPresent: false,
    sessionVariableSetAttachmentsCutoverPresent: true,
    tables: [
      {
        name: "tenant_rows",
        owner: "opengeni_migrator",
        rlsEnabled: true,
        rlsForced: true,
        rlsActive: true,
        policyCount: 1,
        artifactOutboxDispatcherPolicy: false,
        artifactMaterializerPolicy: false,
        select: true,
        insert: true,
        update: true,
        delete: true,
        truncate: false,
        references: false,
        trigger: false,
      },
      ...knowledgeAuthorityTables(),
      ...googleDriveAuthorityTables(),
      ...canonicalHumanIdentityAuthorityTables(),
      ...managedAuthSessionSetAuthorityTables(),
      ...organizationRecoveryAuthorityTables(),
      ...companyBrainPreferenceAuthorityTables(),
      ...companyProfileAgentAdminAuthorityTables(),
      ...organizationMembershipLifecycleAuthorityTables(),
      ...organizationPrivateSessionAuthorityTables(),
      ...xaiAuthorityTables(),
    ],
    privateTables: [
      {
        name: "personal_resource_delegation_capabilities",
        owner: "opengeni_migrator",
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
      {
        name: "scheduled_personal_resource_capabilities",
        owner: "opengeni_migrator",
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
      {
        name: "personal_document_authority_capabilities",
        owner: "opengeni_migrator",
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
      {
        name: "document_migration_capabilities",
        owner: "opengeni_migrator",
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
      {
        name: "connection_tenancy_backfill_capabilities",
        owner: "opengeni_migrator",
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
    ],
    targetRoutines: [
      ...RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.map((name) => ({
        name,
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: (
          RUNTIME_TARGET_SCHEMA_PUBLIC_POLICY_PREDICATE_ROUTINES as readonly string[]
        ).includes(name),
        securityDefiner: !(RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES as readonly string[]).includes(
          name,
        ),
      })),
      ...RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES.map((name) => ({
        name,
        owner: "opengeni_migrator",
        execute: false,
        publicExecute: false,
        securityDefiner: true,
      })),
    ],
    privateRoutines: [
      {
        name: "workspace_rls_visible(uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: false,
      },
      {
        name: "personal_resource_delegation_capability_active(text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "scheduled_personal_resource_capability_active(text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "personal_document_authority_capability_active(text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "document_migration_capability_active(text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "connection_tenancy_backfill_capability_active(uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
    ],
  };
}

describe("runtime database posture evaluator", () => {
  test("requires the 0352 session Variable Set runtime receipt", () => {
    const posture = safePosture();
    posture.sessionVariableSetAttachmentsCutoverPresent = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "database is missing the 0352 session Variable Set attachment runtime receipt",
    );
  });

  test("freezes the unique, sorted current-ledger table privilege classes", () => {
    const hasOpe121SlackPublicationLedger = FORCE_RLS_TABLES.includes("memory_slack_publications");
    if (hasOpe121SlackPublicationLedger) {
      const hasCurrentMainActivityLedger = new Set<string>(FORCE_RLS_TABLES).has(
        "slack_user_link_access_request_operations",
      );
      const readUpdateTables = Object.entries(RUNTIME_TABLE_PRIVILEGES)
        .filter(
          ([, privileges]) =>
            privileges.length === 2 && privileges[0] === "SELECT" && privileges[1] === "UPDATE",
        )
        .map(([table]) => table)
        .sort();
      const personalResourceProtectedTableCount = [
        "connection_use_once_consumption_receipts",
        "personal_resource_once_consumption_receipts",
        "personal_github_repository_selection_heads",
        "personal_github_repository_selection_operations",
        "personal_github_repository_selections",
        "scheduled_task_personal_resource_authorities",
        "scheduled_task_personal_resource_snapshots",
        "scheduled_task_run_personal_resource_admissions",
        "scheduled_task_run_personal_resource_once_receipts",
        "scheduled_task_run_personal_resource_snapshots",
        "scheduled_task_connection_authority_snapshots",
        "scheduled_task_run_connection_authority_snapshots",
        "scheduled_task_reusable_connection_materializations",
        "scheduled_task_revision_authorities",
        "session_attempt_personal_resource_admissions",
        "session_attempt_personal_resource_snapshots",
        "session_attempt_connected_machine_authorizations",
        "turn_personal_resource_attachment_receipts",
        "turn_personal_resource_once_receipts",
        "turn_personal_resource_snapshots",
      ].filter(
        (table) =>
          new Set<string>(FORCE_RLS_TABLES).has(table) &&
          new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
      ).length;
      const managedAuthSessionSetProtectedTableCount =
        managedAuthSessionSetAuthorityTableNames.filter(
          (table) =>
            new Set<string>(FORCE_RLS_TABLES).has(table) &&
            new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
        ).length;
      const organizationRecoveryProtectedTableCount =
        organizationRecoveryAuthorityTableNames.filter(
          (table) =>
            new Set<string>(FORCE_RLS_TABLES).has(table) &&
            new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
        ).length;
      const contracts = hasCurrentMainActivityLedger
        ? ([
            [FORCE_RLS_TABLES, 315],
            [NON_RLS_RUNTIME_TABLES, 14],
            [RUNTIME_FULL_DML_TABLES, 157],
            [RUNTIME_READ_ONLY_TABLES, 22],
            [readUpdateTables, 1],
            [RUNTIME_READ_INSERT_TABLES, 46],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 32],
            [PROTECTED_NO_DIRECT_DML_TABLES, 71],
            [RUNTIME_DML_TABLES, 258],
          ] as const)
        : ([
            [FORCE_RLS_TABLES, 206],
            [NON_RLS_RUNTIME_TABLES, 12],
            [RUNTIME_FULL_DML_TABLES, 120],
            [RUNTIME_READ_ONLY_TABLES, 18],
            [readUpdateTables, 0],
            [RUNTIME_READ_INSERT_TABLES, 38],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 12],
            [PROTECTED_NO_DIRECT_DML_TABLES, 30],
            [RUNTIME_DML_TABLES, 188],
          ] as const);
      for (const [tables, length] of contracts) {
        const expectedLength =
          tables === FORCE_RLS_TABLES || tables === PROTECTED_NO_DIRECT_DML_TABLES
            ? length +
              personalResourceProtectedTableCount +
              managedAuthSessionSetProtectedTableCount +
              organizationRecoveryProtectedTableCount
            : length;
        expect(tables).toHaveLength(expectedLength);
        expect(new Set(tables).size).toBe(tables.length);
        expect([...tables].sort()).toEqual([...tables]);
      }

      expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
      const tableCount = hasCurrentMainActivityLedger ? 329 : 218;
      expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(
        tableCount +
          personalResourceProtectedTableCount +
          managedAuthSessionSetProtectedTableCount +
          organizationRecoveryProtectedTableCount,
      );
      expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(
        tableCount +
          personalResourceProtectedTableCount +
          managedAuthSessionSetProtectedTableCount +
          organizationRecoveryProtectedTableCount,
      );
      expect(RUNTIME_TABLE_PRIVILEGES.memory_slack_publication_configurations).toEqual([
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ]);
      expect(RUNTIME_TABLE_PRIVILEGES.memory_slack_publications).toEqual([
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ]);
      expect(RUNTIME_TABLE_PRIVILEGES.memory_slack_publication_receipts).toEqual([
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
      ]);
      if (hasCurrentMainActivityLedger) {
        expect(RUNTIME_TABLE_PRIVILEGES.browser_state_uploads).toEqual([
          "SELECT",
          "INSERT",
          "UPDATE",
        ]);
        expect(RUNTIME_TABLE_PRIVILEGES.editable_artifact_session_links).toEqual([
          "SELECT",
          "INSERT",
          "UPDATE",
        ]);
        expect(RUNTIME_TABLE_PRIVILEGES.workspace_session_activity_revisions).toEqual([
          "SELECT",
          "UPDATE",
        ]);
        expect(RUNTIME_TABLE_PRIVILEGES.slack_user_link_access_requests).toEqual([
          "SELECT",
          "INSERT",
          "UPDATE",
        ]);
        expect(RUNTIME_TABLE_PRIVILEGES.slack_user_link_access_request_operations).toEqual([
          "SELECT",
          "INSERT",
        ]);
      }
      expect(
        FORCE_RLS_TABLES.every(
          (table) =>
            table in RUNTIME_TABLE_PRIVILEGES ||
            new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
        ),
      ).toBe(true);
      return;
    }

    const contracts = [
      [FORCE_RLS_TABLES, 222],
      [NON_RLS_RUNTIME_TABLES, 12],
      [RUNTIME_FULL_DML_TABLES, 136],
      [RUNTIME_READ_ONLY_TABLES, 16],
      [RUNTIME_READ_UPDATE_TABLES, 1],
      [RUNTIME_READ_INSERT_TABLES, 41],
      [RUNTIME_READ_INSERT_UPDATE_TABLES, 18],
      [PROTECTED_NO_DIRECT_DML_TABLES, 27],
      [RUNTIME_DML_TABLES, 212],
    ] as const;
    for (const [tables, length] of contracts) {
      expect(tables).toHaveLength(length);
      expect(new Set(tables).size).toBe(tables.length);
      expect([...tables].sort()).toEqual([...tables]);
    }

    expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
    expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(239);
    expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(234);
    expect(RUNTIME_TABLE_PRIVILEGES.editable_artifact_session_links).toEqual([
      "SELECT",
      "INSERT",
      "UPDATE",
    ]);
    expect(RUNTIME_TABLE_PRIVILEGES.workspace_session_activity_revisions).toEqual([
      "SELECT",
      "UPDATE",
    ]);
    expect(RUNTIME_TABLE_PRIVILEGES.slack_user_link_access_requests).toEqual([
      "SELECT",
      "INSERT",
      "UPDATE",
    ]);
    expect(RUNTIME_TABLE_PRIVILEGES.slack_user_link_access_request_operations).toEqual([
      "SELECT",
      "INSERT",
    ]);
    expect(
      FORCE_RLS_TABLES.every(
        (table) =>
          table in RUNTIME_TABLE_PRIVILEGES ||
          new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
      ),
    ).toBe(true);
  });

  test("accepts the exact least-privilege FORCE-RLS contract", () => {
    expect(evaluateRuntimeDatabasePosture(safePosture(), options)).toEqual([]);
  });

  test("enforces the automatic session title fanout capability boundary", () => {
    const posture = safePosture();
    posture.privateTables.push({
      name: "automatic_session_title_fanout_outbox_v1",
      owner: "opengeni_migrator",
      rlsEnabled: true,
      rlsForced: true,
      rlsActive: true,
      policyCount: 1,
      select: false,
      insert: false,
      update: false,
      delete: false,
    });
    posture.privateRoutines.push(
      {
        name: "enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: false,
      },
      {
        name: "claim_automatic_session_title_fanout_v1(integer)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "enforce_automatic_session_title_policy_v1()",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: false,
      },
    );
    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);

    const enqueue = posture.privateRoutines.find((routine) =>
      routine.name.startsWith("enqueue_automatic_session_title_fanout_v1("),
    )!;
    const claim = posture.privateRoutines.find((routine) =>
      routine.name.startsWith("claim_automatic_session_title_fanout_v1("),
    )!;
    const policyTrigger = posture.privateRoutines.find(
      (routine) => routine.name === "enforce_automatic_session_title_policy_v1()",
    )!;
    enqueue.execute = false;
    enqueue.publicExecute = true;
    enqueue.securityDefiner = true;
    claim.execute = false;
    claim.publicExecute = true;
    claim.securityDefiner = false;
    policyTrigger.execute = false;
    policyTrigger.publicExecute = true;
    policyTrigger.securityDefiner = true;

    posture.privateTables.at(-1)!.insert = true;
    posture.privateTables.at(-1)!.rlsForced = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not FORCE RLS"),
        expect.stringContaining("forbidden direct privileges on private table"),
        expect.stringContaining(
          "runtime role lacks rolling-compatible automatic session title fanout migration helper",
        ),
        expect.stringContaining(
          "PUBLIC has forbidden automatic session title fanout migration helper",
        ),
        expect.stringContaining("must be SECURITY INVOKER"),
        expect.stringContaining("runtime role lacks automatic session title fanout capability"),
        expect.stringContaining("PUBLIC has forbidden automatic session title fanout capability"),
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining(
          "runtime role lacks rolling-compatible automatic session title policy trigger",
        ),
        expect.stringContaining("PUBLIC has forbidden automatic session title policy trigger"),
        expect.stringContaining("must be SECURITY INVOKER"),
      ]),
    );
  });

  test("keeps pre-policy binaries ready against the post-policy-migration private routine catalog", () => {
    const postPolicyMigrationRoutines = [
      {
        name: "enqueue_automatic_session_title_fanout_v1(uuid, uuid, uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
      },
      {
        name: "claim_automatic_session_title_fanout_v1(integer)",
        owner: "opengeni_migrator",
        execute: true,
      },
      {
        name: "mark_automatic_session_title_fanout_delivered_v1(uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
      },
      {
        name: "mark_automatic_session_title_fanout_failed_v1(uuid, uuid, text)",
        owner: "opengeni_migrator",
        execute: true,
      },
      {
        name: "enforce_automatic_session_title_policy_v1()",
        owner: "opengeni_migrator",
        execute: true,
      },
    ];
    const evaluatePrePolicyPrivateRoutinePosture = () =>
      postPolicyMigrationRoutines.flatMap((routine) => {
        const violations: string[] = [];
        if (routine.owner === options.expectedRole) {
          violations.push(`runtime role owns private routine ${routine.name}`);
        }
        // These title routines are not in the pre-policy binary's narrow
        // artifact-helper exception, so every one must remain executable.
        if (!routine.execute) {
          violations.push(`runtime role lacks EXECUTE on private routine ${routine.name}`);
        }
        return violations;
      });

    expect(evaluatePrePolicyPrivateRoutinePosture()).toEqual([]);
    postPolicyMigrationRoutines.at(-1)!.execute = false;
    expect(evaluatePrePolicyPrivateRoutinePosture()).toEqual([
      "runtime role lacks EXECUTE on private routine enforce_automatic_session_title_policy_v1()",
    ]);
  });

  test("enforces the exact personal-resource private capability boundary", () => {
    const posture = safePosture();
    const capabilityTable = posture.privateTables[0]!;
    const capabilityRoutine = posture.privateRoutines.find(
      (routine) => routine.name === "personal_resource_delegation_capability_active(text)",
    )!;
    capabilityTable.select = true;
    capabilityRoutine.owner = "another_owner";
    capabilityRoutine.execute = false;
    capabilityRoutine.publicExecute = true;
    capabilityRoutine.securityDefiner = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match table owner"),
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining("runtime role lacks personal-resource capability predicate"),
        expect.stringContaining("PUBLIC has forbidden personal-resource capability predicate"),
        expect.stringContaining("forbidden direct privileges on private table"),
      ]),
    );
  });

  test("enforces the exact personal-document private capability boundary", () => {
    const posture = safePosture();
    const capabilityTable = posture.privateTables.find(
      (table) => table.name === "personal_document_authority_capabilities",
    )!;
    const capabilityRoutine = posture.privateRoutines.find(
      (routine) => routine.name === "personal_document_authority_capability_active(text)",
    )!;
    capabilityTable.insert = true;
    capabilityRoutine.owner = "another_owner";
    capabilityRoutine.execute = false;
    capabilityRoutine.publicExecute = true;
    capabilityRoutine.securityDefiner = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match table owner"),
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining("runtime role lacks personal-document capability predicate"),
        expect.stringContaining("PUBLIC has forbidden personal-document capability predicate"),
        expect.stringContaining("forbidden direct privileges on private table"),
      ]),
    );
  });

  test("enforces the exact document-migration private capability boundary", () => {
    const posture = safePosture();
    const capabilityTable = posture.privateTables.find(
      (table) => table.name === "document_migration_capabilities",
    )!;
    const capabilityRoutine = posture.privateRoutines.find(
      (routine) => routine.name === "document_migration_capability_active(text)",
    )!;
    capabilityTable.update = true;
    capabilityRoutine.owner = "another_owner";
    capabilityRoutine.execute = false;
    capabilityRoutine.publicExecute = true;
    capabilityRoutine.securityDefiner = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match table owner"),
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining("runtime role lacks document-migration capability predicate"),
        expect.stringContaining("PUBLIC has forbidden document-migration capability predicate"),
        expect.stringContaining("forbidden direct privileges on private table"),
      ]),
    );
  });

  test("enforces the connection-tenancy backfill capability boundary", () => {
    const posture = safePosture();
    const capabilityTable = posture.privateTables.find(
      (table) => table.name === "connection_tenancy_backfill_capabilities",
    )!;
    const capabilityRoutine = posture.privateRoutines.find(
      (routine) => routine.name === "connection_tenancy_backfill_capability_active(uuid)",
    )!;
    capabilityTable.update = true;
    capabilityRoutine.owner = "another_owner";
    capabilityRoutine.execute = false;
    capabilityRoutine.publicExecute = true;
    capabilityRoutine.securityDefiner = false;

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("does not match table owner"),
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining(
          "runtime role lacks connection-tenancy backfill capability predicate",
        ),
        expect.stringContaining(
          "PUBLIC has forbidden connection-tenancy backfill capability predicate",
        ),
        expect.stringContaining("forbidden direct privileges on private table"),
      ]),
    );
  });

  test("accepts public-schema authority owned by the two protected tables", () => {
    const posture = safePosture();
    posture.schemas[0]!.owner = "pg_database_owner";
    for (const routine of posture.targetRoutines) {
      if (
        routine.name.includes("personal_document") ||
        routine.name.includes("document_authority_reclassification") ||
        routine.name.includes("document_default_collection") ||
        routine.name === "reclassify_document_authority(jsonb)" ||
        routine.name.includes("personal_github_repository") ||
        routine.name === "resolve_document_original_file(uuid, uuid, text, uuid)" ||
        routine.name.includes("scoped_variable_set") ||
        (routine.name.includes("scoped_rig") && !routine.name.startsWith("scheduled_")) ||
        routine.name.includes("scoped_enrollment") ||
        routine.name.includes("scoped_sandbox") ||
        routine.name.includes("scoped_machine_dependent_sessions") ||
        routine.name.includes("personal_machine")
      ) {
        routine.owner = "pg_database_owner";
      }
    }

    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual([]);
  });

  test("keeps dedicated-schema same-owner authority accepted", () => {
    const posture = safePosture();
    posture.schemas[0]!.name = "tenantx";

    expect(
      evaluateRuntimeDatabasePosture(posture, {
        ...options,
        targetSchema: "tenantx",
      }),
    ).toEqual([]);
  });

  test("fails closed on missing or split knowledge authority table ownership", () => {
    const missing = safePosture();
    missing.tables = missing.tables.filter((table) => table.name !== "knowledge_source_objects");
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) authority tables are missing: knowledge_source_objects",
    );

    const split = safePosture();
    split.tables.find((table) => table.name === "knowledge_source_objects")!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(split, options)).toContain(
      "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) authority table owners do not match: knowledge_sources=opengeni_migrator, knowledge_source_objects=another_owner",
    );
  });

  test("rejects knowledge authority routine and table owner mismatch", () => {
    const posture = safePosture();

    posture.targetRoutines.find(
      (routine) => routine.name === "knowledge_source_sync_lock_authority(uuid, uuid, uuid)",
    )!.owner = "another_owner";
    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) owner another_owner does not match authority table owner opengeni_migrator",
    );
  });

  test("fails closed on missing or split canonical human identity authority", () => {
    const missing = safePosture();
    missing.tables = missing.tables.filter(
      (table) => table.name !== "canonical_human_login_bindings",
    );
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      "target-schema runtime capability ensure_canonical_human_identity(text, text) canonical identity authority tables are missing",
    );

    const split = safePosture();
    split.tables.find((table) => table.name === "canonical_human_identity_operations")!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(split, options)).toContain(
      "target-schema runtime capability ensure_canonical_human_identity(text, text) authority table owners do not match: canonical_human_identities=opengeni_migrator, canonical_human_identity_subjects=opengeni_migrator, canonical_human_login_bindings=opengeni_migrator, canonical_human_identity_operations=another_owner",
    );
  });

  test("fails closed on missing or split managed-auth session-set authority", () => {
    const routineName = "managed_auth_session_set_authority_state(text)";
    const missing = safePosture();
    missing.tables = missing.tables.filter((table) => table.name !== "managed_auth_session_sets");
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      `target-schema runtime capability ${routineName} managed auth session-set authority tables are missing`,
    );

    const split = safePosture();
    split.tables.find((table) => table.name === "managed_auth_session_set_operations")!.owner =
      "another_owner";
    expect(
      evaluateRuntimeDatabasePosture(split, options).some(
        (violation) =>
          violation.startsWith(
            `target-schema runtime capability ${routineName} authority table owners do not match:`,
          ) && violation.includes("managed_auth_session_set_operations=another_owner"),
      ),
    ).toBe(true);

    const routineMismatch = safePosture();
    routineMismatch.targetRoutines.find((routine) => routine.name === routineName)!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(routineMismatch, options)).toContain(
      `target-schema runtime capability ${routineName} owner another_owner does not match authority table owner opengeni_migrator`,
    );
  });

  test("fails closed on missing or split organization recovery authority", () => {
    const routineName = "organization_recovery_command(jsonb)";
    const missing = safePosture();
    missing.tables = missing.tables.filter(
      (table) => table.name !== "organization_recovery_policy_heads",
    );
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      `target-schema runtime capability ${routineName} organization recovery authority tables are missing`,
    );

    const split = safePosture();
    split.tables.find((table) => table.name === "organization_recovery_operations")!.owner =
      "another_owner";
    expect(
      evaluateRuntimeDatabasePosture(split, options).some(
        (violation) =>
          violation.startsWith(
            `target-schema runtime capability ${routineName} authority table owners do not match:`,
          ) && violation.includes("organization_recovery_operations=another_owner"),
      ),
    ).toBe(true);

    const routineMismatch = safePosture();
    routineMismatch.targetRoutines.find((routine) => routine.name === routineName)!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(routineMismatch, options)).toContain(
      `target-schema runtime capability ${routineName} owner another_owner does not match authority table owner opengeni_migrator`,
    );
  });

  test("requires same-owner organization membership lifecycle authority", () => {
    const routineName = "organization_membership_command(jsonb)";

    const missing = safePosture();
    missing.tables = missing.tables.filter(
      (table) => table.name !== "organization_user_retention_object_obligations",
    );
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      `target-schema runtime capability ${routineName} authority tables are missing: organization_user_retention_object_obligations`,
    );

    const split = safePosture();
    split.tables.find(
      (table) => table.name === "organization_user_retention_deletion_events",
    )!.owner = "another_owner";
    expect(
      evaluateRuntimeDatabasePosture(split, options).some((violation) =>
        violation.startsWith(
          `target-schema runtime capability ${routineName} authority table owners do not match:`,
        ),
      ),
    ).toBe(true);

    const invalidRoutine = safePosture();
    invalidRoutine.targetRoutines.find((routine) => routine.name === routineName)!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(invalidRoutine, options)).toContain(
      `target-schema runtime capability ${routineName} owner another_owner does not match authority table owner opengeni_migrator`,
    );
  });

  test("classifies canonical human identity tables as FORCE-RLS with no direct DML", () => {
    for (const table of [
      "canonical_human_identities",
      "canonical_human_identity_operations",
      "canonical_human_identity_subjects",
      "canonical_human_login_bindings",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
  });

  test("classifies managed-auth session-set tables as FORCE-RLS with no direct DML", () => {
    for (const table of managedAuthSessionSetAuthorityTableNames) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toEqual(
      expect.arrayContaining([
        "managed_auth_session_set_authority_state(text)",
        "managed_auth_session_set_snapshot(text, text, boolean, boolean, boolean)",
        "managed_auth_session_set_mutate(text, text, uuid, text, bigint, bigint, text, uuid, uuid, uuid, text, text)",
        "managed_auth_actor_mutation_lease_acquire(text, bigint, uuid, integer)",
        "managed_auth_actor_mutation_lease_release(text, uuid)",
        "managed_auth_actor_mutation_lease_validate(text, bigint, uuid)",
      ]),
    );
  });

  test("classifies organization recovery tables as FORCE-RLS with no direct DML", () => {
    for (const table of organizationRecoveryAuthorityTableNames) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toEqual(
      expect.arrayContaining([
        "get_organization_recovery_overview(uuid, text, jsonb, text, text)",
        "organization_recovery_command(jsonb)",
      ]),
    );
  });

  test("classifies organization private-session settings as capability-only FORCE-RLS state", () => {
    for (const table of [
      "organization_private_session_setting_events",
      "organization_private_session_settings",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    for (const routine of [
      "get_private_session_create_policy(uuid, uuid, text)",
      "get_organization_private_session_settings(uuid, text)",
      "update_organization_private_session_settings(uuid, text, boolean, bigint, uuid)",
    ] as const) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(
      "organization_private_sessions_enabled(uuid)",
    );
  });

  test("classifies ordered session Variable Set attachments as lifecycle-only FORCE-RLS state", () => {
    expect(FORCE_RLS_TABLES).toContain("session_variable_set_attachments");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("session_variable_set_attachments");
    expect(RUNTIME_FULL_DML_TABLES).not.toContain("session_variable_set_attachments");
    expect(RUNTIME_TABLE_PRIVILEGES.session_variable_set_attachments).toBeUndefined();
  });

  test("classifies advisory work claims as readable heads with capability-only history", () => {
    expect(FORCE_RLS_TABLES).toEqual(
      expect.arrayContaining([
        "session_work_claims",
        "session_work_claim_revisions",
        "session_work_claim_write_capabilities",
      ]),
    );
    expect(RUNTIME_TABLE_PRIVILEGES.session_work_claims).toEqual(["SELECT"]);
    for (const table of [
      "session_work_claim_revisions",
      "session_work_claim_write_capabilities",
    ] as const) {
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toEqual(
      expect.arrayContaining([
        "upsert_session_work_claim_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, integer, text, text, text, text, text, text, text)",
        "release_session_work_claim_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, integer, text)",
      ]),
    );
  });

  test("classifies organization setup delivery journals as capability-only FORCE-RLS state", () => {
    for (const table of [
      "organization_user_setup_deliveries",
      "organization_user_setup_delivery_attempts",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    for (const routine of [
      "claim_organization_user_setup_delivery(jsonb)",
      "prepare_organization_user_setup_delivery(jsonb)",
      "settle_organization_user_setup_delivery(jsonb)",
      "preview_organization_user_setup(text)",
      "get_organization_invitation_for_administration(uuid, text, uuid)",
    ] as const) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
  });

  test("keeps tenancy backfill activation evidence owner-only", () => {
    expect(RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES).toContain(
      "check_tenancy_backfill_activation_evidence(uuid)",
    );
  });

  test("classifies logical-turn personal-resource ledgers as FORCE-RLS with no direct DML", () => {
    for (const table of [
      "turn_personal_resource_attachment_receipts",
      "turn_personal_resource_once_receipts",
      "turn_personal_resource_snapshots",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
  });

  test("classifies personal GitHub repository selections as lifecycle-only owner authority", () => {
    for (const table of [
      "personal_github_repository_selection_heads",
      "personal_github_repository_selection_operations",
      "personal_github_repository_selections",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toEqual(
      expect.arrayContaining([
        "get_self_personal_github_repository_selection(uuid, uuid, text, uuid)",
        "mutate_self_personal_github_repository_selection(uuid, uuid, text, uuid, bigint, bigint, text, jsonb, boolean)",
      ]),
    );
  });

  test("classifies the Company Brain preference receipt as FORCE-RLS capability-only state", () => {
    expect(FORCE_RLS_TABLES).toContain("company_brain_preference_proposal_receipts");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("company_brain_preference_proposal_receipts");
    expect(RUNTIME_TABLE_PRIVILEGES.company_brain_preference_proposal_receipts).toBeUndefined();
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "preference_registry_create_knowledge_proposal_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text, integer, text, jsonb, timestamp with time zone, text)",
    );
  });

  test("classifies Task-note replacement lineage as FORCE-RLS capability-only state", () => {
    expect(FORCE_RLS_TABLES).toContain("task_note_replacement_receipts");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("task_note_replacement_receipts");
    expect(RUNTIME_TABLE_PRIVILEGES.task_note_replacement_receipts).toBeUndefined();
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "replace_task_note_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid, uuid, integer, text, text, integer, text)",
    );
  });

  test("classifies governed-learning receipts as FORCE-RLS capability-only state", () => {
    for (const table of [
      "governed_learning_decision_receipts",
      "governed_learning_activation_receipts",
      "governed_learning_activation_undo_receipts",
      "remember_knowledge_confirmation_receipts",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "evaluate_governed_learning_proposal(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid, uuid, uuid)",
    );
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "activate_governed_learning_decision(uuid, uuid, uuid, uuid)",
    );
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "activate_human_confirmed_learning_decision(uuid, uuid, uuid, uuid, uuid)",
    );
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "confirm_remember_knowledge_claim(uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid)",
    );
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "undo_governed_learning_activation(uuid, uuid, uuid, uuid)",
    );
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toEqual(
      expect.arrayContaining([
        "inspect_governed_learning_decisions(uuid, uuid, text, integer)",
        "inspect_governed_learning_activations(uuid, uuid, text, integer)",
        "inspect_governed_learning_activation_undos(uuid, uuid, text, integer)",
      ]),
    );
    expect(FORCE_RLS_TABLES).toContain("workspace_instruction_policy_deactivation_events");
    expect(RUNTIME_READ_ONLY_TABLES).toContain("workspace_instruction_policy_deactivation_events");
    expect(RUNTIME_TABLE_PRIVILEGES.workspace_instruction_policy_deactivation_events).toEqual([
      "SELECT",
    ]);
  });

  test("classifies company-profile agent administration as capability-only organization state", () => {
    for (const table of [
      "company_profile_agent_proposal_receipts",
      "company_profile_agent_confirmation_receipts",
      "company_profile_agent_automatic_activation_receipts",
      "organization_company_profile_agent_policies",
      "organization_company_profile_agent_policy_events",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain(table);
      expect(RUNTIME_TABLE_PRIVILEGES[table]).toBeUndefined();
    }
    for (const routine of [
      "propose_company_profile_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, text)",
      "propose_company_profile_for_attempt_v2(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, text, text, text)",
      "confirm_company_profile_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, uuid, uuid)",
      "get_company_profile_agent_policy(uuid, uuid, text)",
      "update_company_profile_agent_policy(uuid, uuid, text, text, bigint, uuid)",
    ] as const) {
      expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(routine);
    }
    const split = safePosture();
    split.tables.find((table) => table.name === "company_profile_agent_proposal_receipts")!.owner =
      "another_owner";
    expect(
      evaluateRuntimeDatabasePosture(split, options).some((violation) =>
        violation.startsWith(
          "target-schema runtime capability propose_company_profile_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, text, text) authority table owners do not match:",
        ),
      ),
    ).toBe(true);
  });

  test("requires same-owner Company Brain preference proposal authority", () => {
    const routineName =
      "preference_registry_create_knowledge_proposal_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text, integer, text, jsonb, timestamp with time zone, text)";
    const split = safePosture();
    split.tables.find(
      (table) => table.name === "company_brain_preference_proposal_receipts",
    )!.owner = "another_owner";
    expect(evaluateRuntimeDatabasePosture(split, options)).toContain(
      `target-schema runtime capability ${routineName} authority table owners do not match: company_brain_preference_proposal_receipts=another_owner, knowledge_change_proposals=opengeni_migrator, knowledge_claim_evidence=opengeni_migrator, knowledge_claim_reviews=opengeni_migrator, knowledge_claims=opengeni_migrator, preference_registry_events=opengeni_migrator, preference_registry_preferences=opengeni_migrator, preference_registry_revisions=opengeni_migrator, session_attempt_interruptions=opengeni_migrator, session_turn_attempts=opengeni_migrator, session_turns=opengeni_migrator, sessions=opengeni_migrator, workspaces=opengeni_migrator`,
    );

    const invalidRoutine = safePosture();
    invalidRoutine.targetRoutines.find((routine) => routine.name === routineName)!.owner =
      "another_owner";
    expect(evaluateRuntimeDatabasePosture(invalidRoutine, options)).toContain(
      `target-schema runtime capability ${routineName} owner another_owner does not match authority table owner opengeni_migrator`,
    );
  });

  test("rejects xAI authority routine and table owner mismatch", () => {
    const posture = safePosture();
    posture.tables.find((table) => table.name === "xai_subscription_credentials")!.owner =
      "another_owner";

    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "target-schema runtime capability create_xai_subscription_credential(uuid, uuid, text, text, text, text, text, text, text, timestamp with time zone) authority table owners do not match: organization_memberships=opengeni_migrator, organization_user_resource_authorities=opengeni_migrator, workspace_memberships=opengeni_migrator, xai_subscription_credentials=another_owner",
    );
  });

  test("rejects bypass, inheritance, ownership, memberships, and inactive RLS", () => {
    const posture = safePosture();
    posture.identity.bypassRls = true;
    posture.identity.inherit = true;
    posture.identity.canCreateInDatabase = true;
    posture.memberships = ["inherits:database_admin"];
    posture.ownedSchemas = ["public"];
    posture.ownedRelations = ["public.tenant_rows"];
    posture.tables[0]!.owner = "opengeni_app";
    posture.tables[0]!.rlsActive = false;
    posture.tables[0]!.trigger = true;

    const violations = evaluateRuntimeDatabasePosture(posture, options);
    expect(violations).toContain("runtime role has BYPASSRLS");
    expect(violations).toContain("runtime role must be NOINHERIT");
    expect(violations).toContain("runtime role has memberships: inherits:database_admin");
    expect(violations).toContain("runtime role owns schemas: public");
    expect(violations).toContain("runtime role owns relations: public.tenant_rows");
    expect(violations).toContain("table tenant_rows has inactive RLS for runtime role");
    expect(violations).toContain("table tenant_rows grants excess runtime privileges: TRIGGER");
  });

  test("rejects missing and undeclared protected-table contract entries", () => {
    const posture = safePosture();
    posture.tables.push({
      ...posture.tables[0]!,
      name: "unreviewed_tenant_rows",
    });

    expect(
      evaluateRuntimeDatabasePosture(posture, {
        ...options,
        protectedTables: ["tenant_rows", "missing_tenant_rows"],
        tablePrivileges: {
          tenant_rows: ["SELECT", "INSERT", "UPDATE", "DELETE"],
          missing_tenant_rows: ["SELECT", "INSERT", "UPDATE", "DELETE"],
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "runtime privilege tables are missing: missing_tenant_rows",
        "protected tables are missing: missing_tenant_rows",
        "RLS tables are absent from the declared contract: unreviewed_tenant_rows",
      ]),
    );
  });

  test("rejects DML on a table outside the exact runtime allowlist", () => {
    const posture = safePosture();
    posture.tables.push({
      ...posture.tables[0]!,
      name: "schema_migrations",
      rlsEnabled: false,
      rlsForced: false,
      rlsActive: false,
      policyCount: 0,
    });

    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "table schema_migrations grants excess runtime privileges: SELECT, INSERT, UPDATE, DELETE",
    );
  });

  test("accepts and enforces read-only, read-insert, and protected no-DML classes", () => {
    const posture = safePosture();
    posture.tables[0] = { ...posture.tables[0]!, update: false, delete: false };
    posture.tables.push(
      {
        ...posture.tables[0]!,
        name: "configuration_rows",
        rlsEnabled: false,
        rlsForced: false,
        rlsActive: false,
        policyCount: 0,
        insert: false,
      },
      {
        ...posture.tables[0]!,
        name: "system_rows",
        select: false,
        insert: false,
      },
    );
    const limitedOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: ["tenant_rows", "system_rows"],
      tablePrivileges: {
        tenant_rows: ["SELECT", "INSERT"],
        configuration_rows: ["SELECT"],
      },
      protectedNoDirectDmlTables: ["system_rows"],
    };

    expect(evaluateRuntimeDatabasePosture(posture, limitedOptions)).toEqual([]);

    posture.tables.find((table) => table.name === "configuration_rows")!.update = true;
    posture.tables.find((table) => table.name === "system_rows")!.select = true;
    expect(evaluateRuntimeDatabasePosture(posture, limitedOptions)).toEqual(
      expect.arrayContaining([
        "table configuration_rows grants excess runtime privileges: UPDATE",
        "table system_rows grants excess runtime privileges: SELECT",
      ]),
    );
  });

  test("accepts one explicit deny-all policy for protected no-DML tables", () => {
    const posture = safePosture();
    posture.tables = [
      ...organizationMembershipLifecycleAuthorityTables().map((table) =>
        table.name === "organization_memberships"
          ? {
              ...posture.tables[0]!,
              name: table.name,
              owner: table.owner,
              policyCount: 1,
              select: false,
              insert: false,
              update: false,
              delete: false,
            }
          : table,
      ),
      ...knowledgeAuthorityTables(),
      ...googleDriveAuthorityTables(),
      ...canonicalHumanIdentityAuthorityTables(),
      ...managedAuthSessionSetAuthorityTables(),
      ...organizationRecoveryAuthorityTables(),
      ...companyBrainPreferenceAuthorityTables(),
      ...companyProfileAgentAdminAuthorityTables(),
    ];
    const inertOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: ["organization_memberships"],
      tablePrivileges: {},
      protectedNoDirectDmlTables: ["organization_memberships"],
    };

    expect(evaluateRuntimeDatabasePosture(posture, inertOptions)).toEqual([]);

    posture.tables.find((table) => table.name === "organization_memberships")!.policyCount = 0;
    expect(evaluateRuntimeDatabasePosture(posture, inertOptions)).toContain(
      "table organization_memberships has no RLS policy",
    );
  });

  test("rejects a protected table without an explicit privilege class", () => {
    expect(
      evaluateRuntimeDatabasePosture(safePosture(), {
        ...options,
        tablePrivileges: {},
      }),
    ).toContain("protected tables lack an explicit privilege class: tenant_rows");
  });

  test("requires the exact least-privilege target-schema knowledge authority lock", () => {
    const missing = safePosture();
    missing.targetRoutines = [];
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) is missing or ambiguous",
    );

    const invalid = safePosture();
    const knowledgeRoutineIndex = invalid.targetRoutines.findIndex(
      (routine) => routine.name === "knowledge_source_sync_lock_authority(uuid, uuid, uuid)",
    );
    invalid.targetRoutines[knowledgeRoutineIndex] = {
      ...invalid.targetRoutines[knowledgeRoutineIndex]!,
      owner: "another_owner",
      execute: false,
      publicExecute: true,
      securityDefiner: false,
    };
    expect(evaluateRuntimeDatabasePosture(invalid, options)).toEqual(
      expect.arrayContaining([
        "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) is not SECURITY DEFINER",
        "target-schema runtime capability knowledge_source_sync_lock_authority(uuid, uuid, uuid) owner another_owner does not match authority table owner opengeni_migrator",
        "runtime role lacks target-schema capability knowledge_source_sync_lock_authority(uuid, uuid, uuid)",
        "PUBLIC has forbidden target-schema capability knowledge_source_sync_lock_authority(uuid, uuid, uuid)",
      ]),
    );
  });

  test("allows PUBLIC execution only for the exact shared-table policy predicate", () => {
    const missing = safePosture();
    missing.targetRoutines.find(
      (routine) =>
        routine.name === "connection_authority_convergence_audit_capability_active(uuid)",
    )!.publicExecute = false;
    expect(evaluateRuntimeDatabasePosture(missing, options)).toContain(
      "PUBLIC lacks required shared-policy predicate connection_authority_convergence_audit_capability_active(uuid)",
    );

    const excess = safePosture();
    excess.targetRoutines.find(
      (routine) =>
        routine.name ===
        "inspect_organization_connection_authority_convergence(uuid, integer, uuid)",
    )!.publicExecute = true;
    expect(evaluateRuntimeDatabasePosture(excess, options)).toContain(
      "PUBLIC has forbidden target-schema capability inspect_organization_connection_authority_convergence(uuid, integer, uuid)",
    );
  });

  test("requires the session-list visibility capability on the runtime role", () => {
    const posture = safePosture();
    posture.targetRoutines = posture.targetRoutines.filter(
      (routine) => routine.name !== "session_visibility_lifecycle_capability_held()",
    );
    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "target-schema runtime capability session_visibility_lifecycle_capability_held() is missing or ambiguous",
    );
  });

  test("requires a same-owner SECURITY DEFINER artifact outbox dispatcher path", () => {
    const posture = safePosture();
    posture.tables.push({
      ...posture.tables[0]!,
      name: "editable_artifact_live_outbox",
      artifactOutboxDispatcherPolicy: true,
      update: false,
      delete: false,
    });
    for (const name of [
      "claim_editable_artifact_live_outbox(text, integer, integer, name)",
      "mark_editable_artifact_live_outbox_published(text, text, integer, name)",
      "renew_editable_artifact_live_outbox(text, text, integer, integer, name)",
      "retry_editable_artifact_live_outbox(text, text, integer, integer, text, name)",
      "dead_letter_editable_artifact_live_outbox(text, text, integer, text, name)",
      "release_editable_artifact_live_outbox(text, text, integer, name)",
      "resolve_editable_artifact_data_schema(name)",
    ]) {
      posture.privateRoutines.push({
        name,
        owner: "opengeni_migrator",
        execute: name.startsWith("resolve_"),
        securityDefiner: true,
      });
    }
    const artifactOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: ["editable_artifact_live_outbox", "tenant_rows"],
      tablePrivileges: {
        editable_artifact_live_outbox: ["SELECT", "INSERT"],
        tenant_rows: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      },
    };
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual([]);

    posture.tables.find(
      (table) => table.name === "editable_artifact_live_outbox",
    )!.artifactOutboxDispatcherPolicy = false;
    posture.privateRoutines.find((routine) =>
      routine.name.startsWith("claim_editable_artifact_live_outbox("),
    )!.securityDefiner = false;
    posture.privateRoutines.find((routine) =>
      routine.name.startsWith("mark_editable_artifact_live_outbox_published("),
    )!.owner = "another_owner";
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual(
      expect.arrayContaining([
        "table editable_artifact_live_outbox lacks its owner dispatcher RLS policy",
        expect.stringContaining("is not SECURITY DEFINER"),
        expect.stringContaining("does not match table owner"),
      ]),
    );
  });

  test("requires a same-owner artifact authorization revision capability", () => {
    const posture = safePosture();
    posture.tables[0]!.name = "editable_artifacts";
    posture.privateRoutines.push({
      name: "advance_editable_artifact_authorization_revision(uuid, uuid, text, bigint, bigint, name)",
      owner: "opengeni_migrator",
      execute: true,
      securityDefiner: true,
    });
    posture.privateRoutines.push({
      name: "authorize_editable_artifact_actor(uuid, uuid, text, text, text, text, text, text, integer, text, text, name)",
      owner: "opengeni_migrator",
      execute: true,
      securityDefiner: true,
    });
    const artifactOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: ["editable_artifacts"],
      tablePrivileges: {
        editable_artifacts: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      },
    };
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual([]);
    posture.privateRoutines.find((routine) =>
      routine.name.startsWith("advance_editable_artifact_authorization_revision("),
    )!.owner = "another_owner";
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual(
      expect.arrayContaining([expect.stringContaining("does not match table owner")]),
    );
  });

  test("requires the exact owner-fenced global artifact materializer path", () => {
    const posture = safePosture();
    const materializerTables = [
      "editable_artifact_materialization_jobs",
      "editable_artifact_materialization_results",
      "editable_artifact_blob_refs",
      "editable_artifact_sequence_checkpoints",
      "editable_artifact_versions",
      "editable_artifact_idempotency_receipts",
    ];
    posture.tables = [
      ...materializerTables.map((name) => ({
        ...posture.tables[0]!,
        name,
        artifactMaterializerPolicy: true,
      })),
      ...knowledgeAuthorityTables(),
      ...googleDriveAuthorityTables(),
      ...canonicalHumanIdentityAuthorityTables(),
      ...managedAuthSessionSetAuthorityTables(),
      ...organizationRecoveryAuthorityTables(),
      ...companyBrainPreferenceAuthorityTables(),
      ...companyProfileAgentAdminAuthorityTables(),
      ...organizationMembershipLifecycleAuthorityTables(),
    ];
    for (const name of [
      "claim_editable_artifact_materializations(text, integer, integer, name)",
      "renew_editable_artifact_materialization(uuid, uuid, text, text, text, integer, integer, name)",
      "succeed_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, text, text, bigint, text, text, timestamp with time zone, name)",
      "fail_editable_artifact_materialization(uuid, uuid, text, text, text, integer, text, name)",
    ]) {
      posture.privateRoutines.push({
        name,
        owner: "opengeni_migrator",
        execute: false,
        securityDefiner: true,
      });
    }
    const artifactOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: materializerTables,
      tablePrivileges: Object.fromEntries(
        materializerTables.map((name) => [name, ["SELECT", "INSERT", "UPDATE", "DELETE"]]),
      ),
    };
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual([]);

    posture.tables[0]!.artifactMaterializerPolicy = false;
    posture.privateRoutines.find((routine) =>
      routine.name.startsWith("claim_editable_artifact_materializations("),
    )!.execute = true;
    posture.privateRoutines.find((routine) =>
      routine.name.startsWith("renew_editable_artifact_materialization("),
    )!.owner = "another_owner";
    expect(evaluateRuntimeDatabasePosture(posture, artifactOptions)).toEqual(
      expect.arrayContaining([
        "table editable_artifact_materialization_jobs lacks its owner materializer RLS policy",
        expect.stringContaining("forbidden global artifact materializer capability"),
        expect.stringContaining("does not match table owner"),
      ]),
    );
  });

  test("scoped topology checks connection coherence without imposing standalone ownership", () => {
    const posture = safePosture();
    posture.identity.currentUser = "embedded_owner";
    posture.identity.sessionUser = "embedded_owner";
    posture.identity.databaseOwner = "embedded_owner";
    posture.identity.superuser = true;
    posture.identity.bypassRls = true;
    posture.identity.inherit = true;
    posture.ownedSchemas = ["embedded"];

    expect(
      evaluateRuntimeDatabasePosture(posture, {
        rlsStrategy: "scoped",
        expectedRole: "opengeni_app",
        targetSchema: "embedded",
      }),
    ).toEqual([]);
  });

  test("fails closed when durable session-tenancy activation outlives the deployment switch", () => {
    const posture = safePosture();
    posture.sessionTenancyProductActivationPresent = true;
    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "session-tenancy product activation is durable but OPENGENI_ORGANIZATION_TENANCY_CANONICAL_ACTIVATION_ENABLED is not true",
    );
    expect(
      evaluateRuntimeDatabasePosture(posture, {
        ...options,
        organizationTenancyCanonicalActivationEnabled: true,
      }),
    ).toEqual([]);
  });

  test("rejects runtime or PUBLIC execution of the owner-internal quiescence helper", () => {
    const posture = safePosture();
    const helper = posture.targetRoutines.find(
      (routine) => routine.name === RUNTIME_TARGET_SCHEMA_FORBIDDEN_ROUTINES[0],
    )!;
    helper.execute = true;
    helper.publicExecute = true;
    expect(evaluateRuntimeDatabasePosture(posture, options)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("runtime role has forbidden owner-internal helper"),
        expect.stringContaining("PUBLIC has forbidden owner-internal helper"),
      ]),
    );
  });
});
