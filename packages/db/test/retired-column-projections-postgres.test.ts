import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { createDb, type DbClient } from "../src/database";
import * as schema from "../src/schema";

let database: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const realTest = test.skipIf(process.env.OPENGENI_REQUIRE_REAL_DB !== "1");

beforeAll(async () => {
  if (process.env.OPENGENI_REQUIRE_REAL_DB !== "1") return;
  database = await acquireSharedTestDatabase("retired-column-projections");
  if (!database) throw new Error("Real PostgreSQL is required for projection compatibility");
  client = createDb(database.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await database?.release();
}, 60_000);

realTest(
  "ordinary ORM selects no longer require retired feature columns",
  async () => {
    // Query compilation only, not a production contract migration. This isolated
    // fixture's CASCADE removes dependent views/triggers so it can probe the ORM.
    // Production must explicitly replace those live dependencies before dropping
    // columns; passing this test proves neither write nor authorization safety.
    await database!.admin.unsafe(`
    ALTER TABLE sessions DROP COLUMN variable_set_ids CASCADE, DROP COLUMN variable_set_id CASCADE,
      DROP COLUMN codex_pinned_credential_id CASCADE, DROP COLUMN codex_last_credential_id CASCADE,
      DROP COLUMN codex_pin_source CASCADE;
    ALTER TABLE scheduled_tasks DROP COLUMN variable_set_id CASCADE;
    ALTER TABLE rig_versions DROP COLUMN default_variable_set_ids CASCADE;
    ALTER TABLE connections DROP COLUMN claude_usage_snapshot CASCADE;
    ALTER TABLE organization_model_provider_connections DROP COLUMN claude_usage_snapshot CASCADE;
  `);
    for (const table of [
      schema.sessions,
      schema.scheduledTasks,
      schema.rigVersions,
      schema.connections,
      schema.organizationModelProviderConnections,
    ]) {
      const rows = await client!.db.select().from(table).limit(1);
      expect(rows).toEqual([]);
    }
  },
  180_000,
);
