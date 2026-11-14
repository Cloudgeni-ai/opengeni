// Anyone in the organization, contract step (1418): on a database the
// previous release left, each shared agent in Slack gets the value that
// release read from its installations (open only if every one is), run as the
// NOSUPERUSER migration owner through FORCE row level security.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const backfillMigration = "1418_agents_organization_access_backfill.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("agents-organization-access");
  if (!owned) throw new Error("Real PostgreSQL is required for the agents migrations");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-organization-access-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < backfillMigration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
}, 600_000);

afterAll(async () => {
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1418 agents organization access backfill", () => {
  test("each shared agent in Slack gets what the previous release read from its installations", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const installs = [
      { connectionId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
      { connectionId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
    ];
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'Access')`;
    for (const id of [home, ...installs.map((install) => install.workspaceId)]) {
      await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    }
    for (const install of installs) {
      await admin`insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values (${install.connectionId}, ${accountId}, ${install.workspaceId}, 'slack.com',
          'app_install', 'active', '\\x00'::bytea)`;
    }
    const agent = async (name: string, flag: boolean, opens: boolean[]) => {
      const id = crypto.randomUUID();
      const key = name.toLowerCase().replaceAll(" ", "");
      await admin`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
          origin, organization_access)
        values (${id}, ${accountId}, ${home}, 'workspace', ${name}, ${key}, 'app', ${flag})`;
      for (const [index, open] of opens.entries()) {
        const install = installs[index]!;
        await admin`insert into agent_slack_installs (agent_id, account_id, workspace_id,
            connection_id, install_workspace_id, slack_team_id, name_key, open)
          values (${id}, ${accountId}, ${home}, ${install.connectionId}, ${install.workspaceId},
            'T0ACCESS', ${key}, ${open})`;
      }
      return id;
    };
    // Opened through Slack's switch by an older release: the column never set.
    const openedInSlack = await agent("Opened in Slack", false, [true, true]);
    // Closed in one Slack workspace by the previous release's switch.
    const closedInOne = await agent("Closed in one", true, [true, false]);
    // Not in Slack: the column already decides.
    const notInSlack = await agent("Not in Slack", true, []);
    const closed = await agent("Closed", false, [false, false]);

    await migrate(owned!.ownerUrl);

    const rows = await admin<{ id: string; access: boolean }[]>`
      select id::text, organization_access as access from agents where account_id = ${accountId}`;
    expect(Object.fromEntries(rows.map((row) => [row.id, row.access]))).toEqual({
      [openedInSlack]: true,
      [closedInOne]: false,
      [notInSlack]: true,
      [closed]: false,
    });
    // The installations' open is left as it was, and FORCE RLS is back.
    const opens = await admin<{ open: boolean }[]>`
      select open from agent_slack_installs where agent_id = ${closedInOne}
      order by connection_id = ${installs[0]!.connectionId} desc`;
    expect(opens.map((row) => row.open)).toEqual([true, false]);
    const unforced = await admin<{ name: string }[]>`
      select relname as name from pg_class
      where relname in ('agents', 'agent_slack_installs') and not relforcerowsecurity`;
    expect([...unforced]).toEqual([]);
  }, 600_000);
});
