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
  RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES,
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

function xaiAuthorityTables(): RuntimeTablePosture[] {
  return [
    "organization_memberships",
    "organization_user_resource_authorities",
    "workspace_memberships",
    "xai_subscription_credentials",
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
      ...companyBrainPreferenceAuthorityTables(),
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
    ],
    targetRoutines: RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.map((name) => ({
      name,
      owner: "opengeni_migrator",
      execute: true,
      publicExecute: false,
      securityDefiner: !(RUNTIME_TARGET_SCHEMA_INVOKER_ROUTINES as readonly string[]).includes(
        name,
      ),
    })),
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
    ],
  };
}

describe("runtime database posture evaluator", () => {
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
        "scheduled_task_personal_resource_authorities",
        "scheduled_task_personal_resource_snapshots",
        "scheduled_task_run_personal_resource_admissions",
        "scheduled_task_run_personal_resource_once_receipts",
        "scheduled_task_run_personal_resource_snapshots",
        "session_attempt_personal_resource_admissions",
        "session_attempt_personal_resource_snapshots",
      ].filter(
        (table) =>
          new Set<string>(FORCE_RLS_TABLES).has(table) &&
          new Set<string>(PROTECTED_NO_DIRECT_DML_TABLES).has(table),
      ).length;
      const contracts = hasCurrentMainActivityLedger
        ? ([
            [FORCE_RLS_TABLES, 246],
            [NON_RLS_RUNTIME_TABLES, 11],
            [RUNTIME_FULL_DML_TABLES, 137],
            [RUNTIME_READ_ONLY_TABLES, 17],
            [readUpdateTables, 1],
            [RUNTIME_READ_INSERT_TABLES, 45],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 29],
            [PROTECTED_NO_DIRECT_DML_TABLES, 28],
            [RUNTIME_DML_TABLES, 229],
          ] as const)
        : ([
            [FORCE_RLS_TABLES, 187],
            [NON_RLS_RUNTIME_TABLES, 11],
            [RUNTIME_FULL_DML_TABLES, 112],
            [RUNTIME_READ_ONLY_TABLES, 16],
            [readUpdateTables, 0],
            [RUNTIME_READ_INSERT_TABLES, 38],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 12],
            [PROTECTED_NO_DIRECT_DML_TABLES, 20],
            [RUNTIME_DML_TABLES, 178],
          ] as const);
      for (const [tables, length] of contracts) {
        const expectedLength =
          tables === FORCE_RLS_TABLES || tables === PROTECTED_NO_DIRECT_DML_TABLES
            ? length + personalResourceProtectedTableCount
            : length;
        expect(tables).toHaveLength(expectedLength);
        expect(new Set(tables).size).toBe(tables.length);
        expect([...tables].sort()).toEqual([...tables]);
      }

      expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
      const tableCount = hasCurrentMainActivityLedger ? 257 : 198;
      expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(
        tableCount + personalResourceProtectedTableCount,
      );
      expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(
        tableCount + personalResourceProtectedTableCount,
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
      [FORCE_RLS_TABLES, 211],
      [NON_RLS_RUNTIME_TABLES, 11],
      [RUNTIME_FULL_DML_TABLES, 133],
      [RUNTIME_READ_ONLY_TABLES, 14],
      [RUNTIME_READ_UPDATE_TABLES, 1],
      [RUNTIME_READ_INSERT_TABLES, 41],
      [RUNTIME_READ_INSERT_UPDATE_TABLES, 18],
      [PROTECTED_NO_DIRECT_DML_TABLES, 20],
      [RUNTIME_DML_TABLES, 207],
    ] as const;
    for (const [tables, length] of contracts) {
      expect(tables).toHaveLength(length);
      expect(new Set(tables).size).toBe(tables.length);
      expect([...tables].sort()).toEqual([...tables]);
    }

    expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
    expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(227);
    expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(222);
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

  test("accepts public-schema authority owned by the two protected tables", () => {
    const posture = safePosture();
    posture.schemas[0]!.owner = "pg_database_owner";
    for (const routine of posture.targetRoutines) {
      if (
        routine.name.includes("personal_document") ||
        routine.name === "resolve_document_original_file(uuid, uuid, text, uuid)" ||
        routine.name.includes("scoped_variable_set") ||
        routine.name.startsWith("list_self_organization_") ||
        routine.name.startsWith("list_organization_") ||
        routine.name === "get_self_organization_invitation(text, uuid)" ||
        routine.name === "organization_membership_command(jsonb)" ||
        routine.name === "get_organization_retention_policy(uuid, text)"
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

  test("classifies the Company Brain preference receipt as FORCE-RLS capability-only state", () => {
    expect(FORCE_RLS_TABLES).toContain("company_brain_preference_proposal_receipts");
    expect(PROTECTED_NO_DIRECT_DML_TABLES).toContain("company_brain_preference_proposal_receipts");
    expect(RUNTIME_TABLE_PRIVILEGES.company_brain_preference_proposal_receipts).toBeUndefined();
    expect(RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES).toContain(
      "preference_registry_create_knowledge_proposal_for_attempt(uuid, uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text, text, text, text, integer, text, jsonb, timestamp with time zone, text)",
    );
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
      {
        ...posture.tables[0]!,
        name: "organization_memberships",
        policyCount: 1,
        select: false,
        insert: false,
        update: false,
        delete: false,
      },
      ...knowledgeAuthorityTables(),
      ...googleDriveAuthorityTables(),
      ...canonicalHumanIdentityAuthorityTables(),
    ];
    const inertOptions: RuntimeDatabasePostureOptions = {
      ...options,
      protectedTables: ["organization_memberships"],
      tablePrivileges: {},
      protectedNoDirectDmlTables: ["organization_memberships"],
    };

    expect(evaluateRuntimeDatabasePosture(posture, inertOptions)).toEqual([]);

    posture.tables[0]!.policyCount = 0;
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
});
