import { describe, expect, test } from "bun:test";
import {
  evaluateRuntimeDatabasePosture,
  FORCE_RLS_TABLES,
  RUNTIME_DML_TABLES,
  type RuntimeDatabasePosture,
  type RuntimeDatabasePostureOptions,
} from "../src/runtime-posture";

const options: RuntimeDatabasePostureOptions = {
  rlsStrategy: "force",
  expectedRole: "opengeni_app",
  targetSchema: "public",
  protectedTables: ["tenant_rows"],
  runtimeTables: ["tenant_rows"],
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
      { name: "public", owner: "opengeni_migrator", usage: true, create: false },
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
      { name: "workspace_rls_visible(uuid, uuid)", owner: "opengeni_migrator", execute: true },
    ],
  };
}

describe("runtime database posture evaluator", () => {
  test("freezes unique, sorted 65-table RLS and 75-table runtime DML contracts", () => {
    expect(FORCE_RLS_TABLES).toHaveLength(65);
    expect(new Set(FORCE_RLS_TABLES).size).toBe(FORCE_RLS_TABLES.length);
    expect([...FORCE_RLS_TABLES].sort()).toEqual([...FORCE_RLS_TABLES]);
    expect(RUNTIME_DML_TABLES).toHaveLength(75);
    expect(new Set(RUNTIME_DML_TABLES).size).toBe(RUNTIME_DML_TABLES.length);
    expect([...RUNTIME_DML_TABLES].sort()).toEqual([...RUNTIME_DML_TABLES]);
    expect(FORCE_RLS_TABLES.every((table) => RUNTIME_DML_TABLES.includes(table))).toBe(true);
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
    expect(violations).toContain("table tenant_rows grants runtime DDL: TRIGGER");
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
        runtimeTables: ["tenant_rows", "missing_tenant_rows"],
      }),
    ).toEqual(
      expect.arrayContaining([
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
      "table schema_migrations grants undeclared runtime privileges: SELECT, INSERT, UPDATE, DELETE",
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
