import { describe, expect, test } from "bun:test";
import {
  evaluateRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  NON_RLS_RUNTIME_TABLES,
  PROTECTED_NO_DIRECT_DML_TABLES,
  RUNTIME_DML_TABLES,
  RUNTIME_FULL_DML_TABLES,
  RUNTIME_READ_INSERT_TABLES,
  RUNTIME_READ_ONLY_TABLES,
  RUNTIME_TABLE_PRIVILEGES,
  type RuntimeDatabasePosture,
  type RuntimeDatabasePostureOptions,
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
        select: true,
        insert: true,
        update: true,
        delete: true,
        truncate: false,
        references: false,
        trigger: false,
      },
    ],
    privateRoutines: [
      {
        name: "workspace_rls_visible(uuid, uuid)",
        owner: "opengeni_migrator",
        execute: true,
      },
    ],
  };
}

describe("runtime database posture evaluator", () => {
  test("freezes the unique, sorted current-ledger table privilege classes", () => {
    const contracts = [
      [FORCE_RLS_TABLES, 91],
      [NON_RLS_RUNTIME_TABLES, 11],
      [RUNTIME_FULL_DML_TABLES, 89],
      [RUNTIME_READ_ONLY_TABLES, 3],
      [RUNTIME_READ_INSERT_TABLES, 5],
      [PROTECTED_NO_DIRECT_DML_TABLES, 5],
      [RUNTIME_DML_TABLES, 97],
    ] as const;
    for (const [tables, length] of contracts) {
      expect(tables).toHaveLength(length);
      expect(new Set(tables).size).toBe(tables.length);
      expect([...tables].sort()).toEqual([...tables]);
    }

    expect(Object.keys(RUNTIME_TABLE_PRIVILEGES).sort()).toEqual([...RUNTIME_DML_TABLES]);
    expect(new Set([...RUNTIME_DML_TABLES, ...PROTECTED_NO_DIRECT_DML_TABLES]).size).toBe(102);
    expect(new Set([...FORCE_RLS_TABLES, ...NON_RLS_RUNTIME_TABLES]).size).toBe(102);
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

  test("rejects a protected table without an explicit privilege class", () => {
    expect(
      evaluateRuntimeDatabasePosture(safePosture(), {
        ...options,
        tablePrivileges: {},
      }),
    ).toContain("protected tables lack an explicit privilege class: tenant_rows");
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
