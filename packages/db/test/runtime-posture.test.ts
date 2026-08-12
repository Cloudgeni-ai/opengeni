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
      {
        name: "sessions",
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
      },
      ...knowledgeAuthorityTables(),
    ],
    targetRoutines: [
      {
        name: "fork_session_content(uuid, uuid, uuid, text, uuid, text, text, text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "knowledge_source_sync_lock_authority(uuid, uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "ensure_managed_human_personal_workspace(uuid, text, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "session_private_actor_visible(uuid, uuid, uuid, text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
      {
        name: "transition_session_visibility(uuid, uuid, uuid, text, text, integer, text, text)",
        owner: "opengeni_migrator",
        execute: true,
        publicExecute: false,
        securityDefiner: true,
      },
    ],
    privateRoutines: [
      {
        name: "workspace_rls_visible(uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
        securityDefiner: false,
      },
    ],
  };
}

describe("runtime database posture evaluator", () => {
  test("freezes the unique, sorted current-ledger table privilege classes", () => {
    const hasOpe121SlackPublicationLedger = FORCE_RLS_TABLES.includes("memory_slack_publications");
    if (hasOpe121SlackPublicationLedger) {
      const sessionVisibilityProtectedTableDelta = FORCE_RLS_TABLES.includes(
        "session_visibility_write_capabilities",
      )
        ? 1
        : 0;
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
      const contracts = hasCurrentMainActivityLedger
        ? ([
            [FORCE_RLS_TABLES, 222],
            [NON_RLS_RUNTIME_TABLES, 11],
            [RUNTIME_FULL_DML_TABLES, 133],
            [RUNTIME_READ_ONLY_TABLES, 17],
            [readUpdateTables, 1],
            [RUNTIME_READ_INSERT_TABLES, 42],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 29],
            [PROTECTED_NO_DIRECT_DML_TABLES, 11],
            [RUNTIME_DML_TABLES, 222],
          ] as const)
        : ([
            [FORCE_RLS_TABLES, 173],
            [NON_RLS_RUNTIME_TABLES, 11],
            [RUNTIME_FULL_DML_TABLES, 107],
            [RUNTIME_READ_ONLY_TABLES, 16],
            [readUpdateTables, 0],
            [RUNTIME_READ_INSERT_TABLES, 38],
            [RUNTIME_READ_INSERT_UPDATE_TABLES, 12],
            [PROTECTED_NO_DIRECT_DML_TABLES, 11],
            [RUNTIME_DML_TABLES, 173],
          ] as const);
      for (const [tables, length] of contracts) {
        const protectedTableDelta =
          tables === FORCE_RLS_TABLES || tables === PROTECTED_NO_DIRECT_DML_TABLES
            ? sessionVisibilityProtectedTableDelta
            : 0;
        expect(tables).toHaveLength(length + protectedTableDelta);
        expect(new Set(tables).size).toBe(tables.length);
        expect([...tables].sort()).toEqual([...tables]);
      }

      expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
      const tableCount =
        (hasCurrentMainActivityLedger ? 233 : 184) + sessionVisibilityProtectedTableDelta;
      expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(
        tableCount,
      );
      expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(tableCount);
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

    const sessionVisibilityProtectedTableDelta = FORCE_RLS_TABLES.includes(
      "session_visibility_write_capabilities",
    )
      ? 1
      : 0;
    const contracts = [
      [FORCE_RLS_TABLES, 197],
      [NON_RLS_RUNTIME_TABLES, 11],
      [RUNTIME_FULL_DML_TABLES, 128],
      [RUNTIME_READ_ONLY_TABLES, 14],
      [RUNTIME_READ_UPDATE_TABLES, 1],
      [RUNTIME_READ_INSERT_TABLES, 41],
      [RUNTIME_READ_INSERT_UPDATE_TABLES, 18],
      [PROTECTED_NO_DIRECT_DML_TABLES, 11],
      [RUNTIME_DML_TABLES, 202],
    ] as const;
    for (const [tables, length] of contracts) {
      const protectedTableDelta =
        tables === FORCE_RLS_TABLES || tables === PROTECTED_NO_DIRECT_DML_TABLES
          ? sessionVisibilityProtectedTableDelta
          : 0;
      expect(tables).toHaveLength(length + protectedTableDelta);
      expect(new Set(tables).size).toBe(tables.length);
      expect([...tables].sort()).toEqual([...tables]);
    }

    expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
    expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(
      213 + sessionVisibilityProtectedTableDelta,
    );
    expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(
      208 + sessionVisibilityProtectedTableDelta,
    );
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

  test("accepts public-schema authority owned by the two protected tables", () => {
    const posture = safePosture();
    posture.schemas[0]!.owner = "pg_database_owner";

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
    posture.privateRoutines[1]!.securityDefiner = false;
    posture.privateRoutines[2]!.owner = "another_owner";
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
    posture.privateRoutines[1]!.owner = "another_owner";
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
    posture.privateRoutines[1]!.execute = true;
    posture.privateRoutines[2]!.owner = "another_owner";
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
