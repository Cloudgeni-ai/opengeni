// Agents legacy drop (1320 to 1330) on a database left by the contract release
// (through 1319), run as the NOSUPERUSER migration owner: the installation
// workspace becomes required, the per-agent unique keys go, and the legacy
// tables and their trigger functions are dropped without CASCADE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const firstLegacyDropMigration = "1320_agent_slack_installs_workspace_check.sql";
// 1325 to 1327 drop slack_agents's own foreign keys so its table drop locks no
// other table; the suite checks that state before 1328.
const tableDropMigration = "1328_slack_agents_drop.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;
let beforeTableDrop: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("agents-legacy-drop");
  if (!owned) throw new Error("Real PostgreSQL is required for the agents legacy drop");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-agents-legacy-drop-"));
  beforeTableDrop = await mkdtemp(join(tmpdir(), "opengeni-before-slack-agents-drop-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (!name.endsWith(".sql")) continue;
    if (name < firstLegacyDropMigration) await copyFile(join(source, name), join(prefix, name));
    if (name < tableDropMigration) await copyFile(join(source, name), join(beforeTableDrop, name));
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
}, 600_000);

afterAll(async () => {
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
  if (beforeTableDrop) await rm(beforeTableDrop, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1320 to 1330 agents legacy drop", () => {
  test("requires the installation workspace and drops the legacy tables", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const installs = [
      { connectionId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
      { connectionId: crypto.randomUUID(), workspaceId: crypto.randomUUID() },
    ] as const;
    const subject = "user:agents-legacy-drop";
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'Legacy drop')`;
    for (const id of [home, ...installs.map((install) => install.workspaceId)]) {
      await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    }
    for (const install of installs) {
      await admin`insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values (${install.connectionId}, ${accountId}, ${install.workspaceId}, 'slack.com',
          'app_install', 'active', '\\x00'::bytea)`;
    }
    const agentId = crypto.randomUUID();
    await admin`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
        origin)
      values (${agentId}, ${accountId}, ${home}, 'workspace', 'Desk', 'desk', 'slack')`;
    // One installation as the contract release writes it; one that slipped
    // past 1301's fill (no workspace yet). The legacy drop refuses to run
    // until an operator fills it, so nothing is dropped from a second copy.
    await admin`insert into agent_slack_installs (agent_id, account_id, workspace_id,
        connection_id, install_workspace_id, slack_team_id, name_key)
      values (${agentId}, ${accountId}, ${home}, ${installs[0].connectionId},
        ${installs[0].workspaceId}, 'T0DROP', 'desk')`;
    await admin.begin(async (sql) => {
      await sql`alter table slack_agents disable trigger slack_agents_fill_agent_install_workspace`;
      await sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, slack_team_id, name_key)
        values (${agentId}, ${accountId}, ${home}, ${installs[1].connectionId}, 'T0DROP', 'desk')`;
      await sql`insert into slack_agents (id, account_id, workspace_id, connection_id,
          slack_team_id, target_account_id, target_workspace_id, name, name_key, description,
          avatar, created_by_subject_id)
        values (${agentId}, ${accountId}, ${installs[1].workspaceId},
          ${installs[1].connectionId}, 'T0DROP', ${accountId}, ${home}, 'Desk', 'desk', '',
          '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb, ${subject})`;
      await sql`alter table slack_agents enable trigger slack_agents_fill_agent_install_workspace`;
    });
    await admin`insert into bot_templates (account_id, workspace_id, name, setup_instructions,
        visibility, created_by_subject_id)
      values (${accountId}, ${home}, 'Old template', 'x', 'workspace', ${subject})`;
    expect(
      await admin`select 1 from agent_slack_installs
        where agent_id = ${agentId} and install_workspace_id is null`,
    ).toHaveLength(1);

    // A row without its workspace stops the release at 1321, before anything
    // is dropped.
    await expect(
      migrate(owned!.ownerUrl, undefined, { migrationsDirectory: beforeTableDrop! }),
    ).rejects.toThrow(/agent_slack_installs_install_workspace_check/);
    const [stopped] = await admin<{ slackAgents: string | null; keys: number }[]>`
      select to_regclass('slack_agents')::text as "slackAgents",
        (select count(*)::int from pg_constraint
          where conrelid = 'slack_agents'::regclass and contype = 'f') as keys`;
    expect(stopped).toEqual({ slackAgents: "slack_agents", keys: 7 });
    // The documented pre-release check (as an RLS-exempt role) finds it; the
    // documented repair sets it from the Slack connection's workspace, and
    // the release goes on.
    const [found] = await admin<{ count: number }[]>`
      select count(*)::int as count from agent_slack_installs where install_workspace_id is null`;
    expect(found?.count).toBe(1);
    await admin`update agent_slack_installs i set install_workspace_id = c.workspace_id
      from connections c where c.id = i.connection_id and i.install_workspace_id is null`;
    const [repaired] = await admin<{ installWorkspace: string }[]>`
      select install_workspace_id::text as "installWorkspace" from agent_slack_installs
      where agent_id = ${agentId} and connection_id = ${installs[1].connectionId}`;
    expect(repaired?.installWorkspace).toBe(installs[1].workspaceId);

    await migrate(owned!.ownerUrl, undefined, { migrationsDirectory: beforeTableDrop! });
    const legacyKeys = await admin<{ name: string }[]>`
      select conname as name from pg_constraint
      where contype = 'f' and (conrelid = 'slack_agents'::regclass
        or confrelid = 'slack_agents'::regclass)`;
    expect([...legacyKeys]).toEqual([]);

    // A foreign key 1325 to 1327 missed (a production name that differs)
    // stops 1328 before it drops anything.
    await admin`alter table slack_agents add constraint slack_agents_drifted_fk
      foreign key (connection_id) references connections (id) not valid`;
    await expect(migrate(owned!.ownerUrl)).rejects.toThrow(
      /still has a foreign key \(slack_agents_drifted_fk\)/,
    );
    expect((await admin`select to_regclass('slack_agents')::text as name`)[0]?.name).toBe(
      "slack_agents",
    );
    await admin`alter table slack_agents drop constraint slack_agents_drifted_fk`;

    await migrate(owned!.ownerUrl);

    // Every installation has its workspace, and the column requires one.
    const rows = await admin<{ connection: string; installWorkspace: string }[]>`
      select connection_id::text as connection, install_workspace_id::text as "installWorkspace"
      from agent_slack_installs where agent_id = ${agentId} order by created_at, id`;
    expect(Object.fromEntries(rows.map((row) => [row.connection, row.installWorkspace]))).toEqual(
      Object.fromEntries(installs.map((install) => [install.connectionId, install.workspaceId])),
    );
    const [column] = await admin<{ notNull: boolean }[]>`
      select attnotnull as "notNull" from pg_attribute
      where attrelid = 'agent_slack_installs'::regclass and attname = 'install_workspace_id'`;
    expect(column?.notNull).toBe(true);

    // The legacy tables, their functions, 1320's check and the per-agent keys
    // are gone; the per-installation keys stay.
    const [gone] = await admin<
      { slackAgents: string | null; botTemplates: string | null; functions: number }[]
    >`select to_regclass('slack_agents')::text as "slackAgents",
        to_regclass('bot_templates')::text as "botTemplates",
        (select count(*)::int from pg_proc
          where proname in ('sync_agent_from_bot_template', 'sync_agent_from_slack_agent',
            'fill_agent_slack_install_workspace')) as functions`;
    expect(gone).toEqual({ slackAgents: null, botTemplates: null, functions: 0 });
    const constraints = await admin<{ name: string }[]>`
      select conname as name from pg_constraint
      where conname in ('agent_slack_installs_install_workspace_check',
        'slack_agent_user_states_agent_user_uq', 'slack_agent_intro_posts_agent_channel_uq')`;
    expect([...constraints]).toEqual([]);
    const indexes = await admin<{ name: string }[]>`
      select indexrelid::regclass::text as name from pg_index
      where indexrelid::regclass::text in ('slack_agent_user_states_install_user_uq',
        'slack_agent_intro_posts_install_channel_uq')
      order by 1`;
    expect(indexes.map((row) => row.name)).toEqual([
      "slack_agent_intro_posts_install_channel_uq",
      "slack_agent_user_states_install_user_uq",
    ]);

    // The same Slack person and channel in both installations: one record each.
    for (const install of installs) {
      await admin`insert into slack_agent_user_states (account_id, workspace_id, connection_id,
          slack_agent_id, slack_user_id)
        values (${accountId}, ${install.workspaceId}, ${install.connectionId}, ${agentId},
          'U0SAME')`;
      await admin`insert into slack_agent_intro_posts (account_id, workspace_id, connection_id,
          slack_agent_id, slack_channel_id, posted_by_subject_id)
        values (${accountId}, ${install.workspaceId}, ${install.connectionId}, ${agentId},
          'C0SAME', ${subject})`;
    }
    const [counted] = await admin<{ states: number; intros: number }[]>`
      select
        (select count(*)::int from slack_agent_user_states where slack_agent_id = ${agentId}) as states,
        (select count(*)::int from slack_agent_intro_posts where slack_agent_id = ${agentId}) as intros`;
    expect(counted).toEqual({ states: 2, intros: 2 });
    // A new installation row without its workspace is refused.
    const refused = await admin`insert into agent_slack_installs (agent_id, account_id,
        workspace_id, connection_id, slack_team_id, name_key)
      values (${agentId}, ${accountId}, ${home}, gen_random_uuid(), 'T0DROP', 'desk')`.catch(
      (error: { code?: string }) => error,
    );
    expect((refused as { code?: string }).code).toBe("23502");
  }, 600_000);
});
