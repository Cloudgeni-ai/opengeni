// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../drizzle/0392_workspace_memory_and_learning_defaults.sql",
  import.meta.url,
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let shared: SharedTestDatabase | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0392-memory-learning-defaults");
  if (!shared && requireRealDatabase) {
    throw new Error("migration 0392 requires real PostgreSQL");
  }
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 180_000);

describe("migration 0392 workspace Memory and learning defaults", () => {
  test("pins the rolling, non-retroactive default transition", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain(
      `ALTER COLUMN "settings" SET DEFAULT '{"memoryEnabled": true}'::jsonb`,
    );
    expect(migration).toContain(`WHERE NOT ("settings" ? 'memoryEnabled')`);
    expect(migration).toContain(`'workspaceMode', 'suggest'`);
    expect(migration).not.toContain(`UPDATE "workspace_learning_policy_snapshots"`);
    expect(migration).not.toContain(`UPDATE "company_brain_turn_context_snapshots"`);
  });

  test("backfills only omitted Memory settings and defaults unconfigured learning to suggest", async () => {
    if (!shared) return;
    const migration = await readFile(migrationUrl, "utf8");
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name)
      values ('migration 0392 defaults account')
      returning id`;
    const [omitted, disabled] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name, settings)
      values
        (${account!.id}, 'memory omitted', '{}'::jsonb),
        (${account!.id}, 'memory disabled', '{"memoryEnabled": false}'::jsonb)
      returning id`;

    await shared.admin.begin(async (sql) => {
      await sql.unsafe(migration);
    });

    const rows = await shared.admin<{ id: string; settings: Record<string, unknown> }[]>`
      select id, settings
      from workspaces
      where id in (${omitted!.id}, ${disabled!.id})
      order by name`;
    const byId = new Map(rows.map((row) => [row.id, row.settings]));
    expect(byId.get(omitted!.id)).toMatchObject({ memoryEnabled: true });
    expect(byId.get(disabled!.id)).toMatchObject({ memoryEnabled: false });

    const [createdAfter] = await shared.admin<
      {
        id: string;
        settings: Record<string, unknown>;
      }[]
    >`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'memory defaulted')
      returning id, settings`;
    expect(createdAfter!.settings).toMatchObject({ memoryEnabled: true });

    const [canonical] = await shared.admin<{ policy: Record<string, unknown> }[]>`
      select workspace_learning_policy_canonical_at(
        ${account!.id}, ${createdAfter!.id}, clock_timestamp()
      ) as policy`;
    expect(canonical!.policy).toMatchObject({
      revisionId: null,
      activationVersion: 0,
      workspaceMode: "suggest",
      sourceOverrides: [],
    });
  }, 180_000);
});
