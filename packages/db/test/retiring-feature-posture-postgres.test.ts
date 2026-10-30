import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, type DbClient } from "../src/database";
import {
  assertRuntimeDatabasePosture,
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  RETIRING_FEATURE_TABLES,
  RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES,
} from "../src/runtime-posture";

let database: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
const options = { rlsStrategy: "force" as const, targetSchema: "og_retiring" };
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  database = await acquireRestrictedRuntimeTestDatabase(
    "retiring-feature-posture",
    options.targetSchema,
  );
  if (!database) throw new Error("Real PostgreSQL is required for retirement readiness");
  client = createDb(database.appUrl, { searchPath: database.schema, max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 180_000);

realTest("the restricted inspector observes the still-present legacy schema", async () => {
  const posture = await assertRuntimeDatabasePosture(client!.db, options);
  expect(posture.retiringFeatureTablesPresent).toEqual({ subscription: true, variableSets: true });
});

realTest(
  "the compatibility binary stays ready after the exact retired tables and receipts disappear",
  async () => {
    // This is a disposable readiness-only probe, NOT the production contract
    // migration. That migration must also replace every surviving SQL caller,
    // reconcile frozen permission snapshots and prove previous-release ancestry.
    const names = Object.values(RETIRING_FEATURE_TABLES).flat();
    await database!.admin.unsafe(
      `DROP TABLE ${names.map((name) => `"${database!.schema}"."${name}"`).join(", ")} CASCADE`,
    );
    await database!.admin.unsafe(`
    DROP FUNCTION opengeni_private.subscription_provider_cutover_committed(text) CASCADE;
    DROP FUNCTION opengeni_private.subscription_codex_cutover_v1_active() CASCADE;
    DROP FUNCTION opengeni_private.session_variable_set_attachments_protocol_v1_active() CASCADE;
    DROP TABLE opengeni_private.variable_set_authority_capabilities CASCADE;
    DROP FUNCTION opengeni_private.variable_set_authority_capability_active(text) CASCADE;
  `);
    for (const signature of RUNTIME_TARGET_SCHEMA_CAPABILITY_ROUTINES.filter(
      (name) =>
        name.includes("variable_set") ||
        name === "resolve_workspace_codex_subscription_source(uuid, uuid)" ||
        name === "capture_legacy_codex_turn_sources(uuid, uuid)",
    )) {
      await database!.admin.unsafe(`DROP FUNCTION "${database!.schema}".${signature} CASCADE`);
    }
    const posture = await assertRuntimeDatabasePosture(client!.db, options);
    expect(posture.retiringFeatureTablesPresent).toEqual({
      subscription: false,
      variableSets: false,
    });
    expect(posture.subscriptionProviderCutoverReceipts).toEqual([]);
    expect(posture.subscriptionCodexCutoverActivationPresent).toBe(false);
    expect(posture.sessionVariableSetAttachmentsCutoverPresent).toBe(false);
    expect(posture.tables.some((table) => (names as readonly string[]).includes(table.name))).toBe(
      false,
    );
    // The embedded inspector exits before loading table posture, so its witness
    // must come from pg_catalog, never an empty or RLS-filtered application list.
    const scoped = await assertRuntimeDatabasePosture(client!.db, {
      ...options,
      rlsStrategy: "scoped",
    });
    expect(scoped.retiringFeatureTablesPresent).toEqual({
      subscription: false,
      variableSets: false,
    });
  },
  180_000,
);

realTest("retiring schema does not relax the live vault contract", async () => {
  await database!.admin.unsafe(
    `ALTER TABLE "${database!.schema}".vaults NO FORCE ROW LEVEL SECURITY`,
  );
  try {
    const posture = await inspectRuntimeDatabasePosture(client!.db, options);
    expect(evaluateRuntimeDatabasePosture(posture, options)).toContain(
      "table vaults does not FORCE RLS",
    );
  } finally {
    await database!.admin.unsafe(
      `ALTER TABLE "${database!.schema}".vaults FORCE ROW LEVEL SECURITY`,
    );
  }
});
