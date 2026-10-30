// The Slack agent update sweeper's inventory under the production database
// setup: a non-superuser owner, FORCE ROW LEVEL SECURITY and the runtime role.
// The inventory is the only cross-organization read of update settings; it
// returns ids of installations with updates on, only once EXECUTE is granted.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import {
  createDb,
  listSlackAgentUpdateSweepInstallations,
  slackAgentUpdateSweepGranted,
  type DbClient,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";

let fixture: RestrictedRuntimeTestDatabase;
let client: DbClient;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("slack-agent-update-sweep");
  if (!acquired) throw new Error("Real PostgreSQL is required");
  fixture = acquired;
  client = createDb(fixture.appUrl, { searchPath: fixture.schema });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

test("the inventory lists only installations with updates on, once granted, and nothing else is readable", async () => {
  const row = (updatesEnabled: boolean, channelPostsOnly: boolean) => ({
    accountId: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    updatesEnabled,
    channelPostsOnly,
  });
  const on = row(true, false);
  const rows = [on, row(false, false), row(true, true)];
  // Settings rows without their organizations: foreign keys are not what this
  // test is about, so the superuser skips them for these inserts only.
  await fixture.admin.begin(async (sql) => {
    await sql`set local session_replication_role = replica`;
    for (const settings of rows) {
      await sql`insert into slack_agent_update_settings
        (account_id, workspace_id, connection_id, updates_enabled, channel_posts_only, updates_enabled_at)
        values (${settings.accountId}, ${settings.workspaceId}, ${settings.connectionId},
          ${settings.updatesEnabled}, ${settings.channelPostsOnly}, now())`;
    }
  });

  // Withheld by 1153: the sweeper finds nothing.
  expect(await slackAgentUpdateSweepGranted(client.db)).toBe(false);
  expect(await listSlackAgentUpdateSweepInstallations(client.db, { limit: 10 })).toEqual([]);

  await fixture.admin.unsafe(
    "GRANT EXECUTE ON FUNCTION opengeni_private.list_due_slack_agent_update_installations_v1(integer) TO opengeni_app",
  );
  expect(await slackAgentUpdateSweepGranted(client.db)).toBe(true);
  const listed = await listSlackAgentUpdateSweepInstallations(client.db, { limit: 10 });
  expect(
    listed.map(({ accountId, workspaceId, connectionId }) => ({
      accountId,
      workspaceId,
      connectionId,
    })),
  ).toEqual([
    { accountId: on.accountId, workspaceId: on.workspaceId, connectionId: on.connectionId },
  ]);

  // The runtime role itself still reads no settings row outside a tenant.
  const app = postgres(fixture.appUrl, {
    max: 1,
    connection: { search_path: fixture.schema },
  });
  try {
    const [count] = await app<{ count: number }[]>`
      select count(*)::int as count from slack_agent_update_settings`;
    expect(count!.count).toBe(0);
  } finally {
    await app.end();
  }
}, 120_000);
