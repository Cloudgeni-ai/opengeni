// Agents contract (1301 to 1319) on a database left by the expand release
// (1243-1276): legacy slack_agents rows with their agent_slack_installs rows
// and every kind of Slack record that pointed at slack_agents.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const firstContractMigration = "1301_agent_slack_install_workspace.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;
let appSql: postgres.Sql | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("agents-contract");
  if (!owned) throw new Error("Real PostgreSQL is required for the agents contract migrations");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-agents-contract-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < firstContractMigration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  appSql = postgres(appUrl.toString(), { max: 2 });
}, 600_000);

afterAll(async () => {
  await appSql?.end().catch(() => undefined);
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

type Install = { connectionId: string; workspaceId: string; label: string };

describe.skipIf(!realDatabase)("1301 to 1319 agents contract", () => {
  test("moves every Slack record onto the agent's installation and keeps its delete rules", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const installA: Install = {
      connectionId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      label: "a",
    };
    const installB: Install = {
      connectionId: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      label: "b",
    };
    const subject = "user:agents-contract";
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'Contract')`;
    for (const id of [home, installA.workspaceId, installB.workspaceId]) {
      await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    }
    for (const install of [installA, installB]) {
      await admin`insert into connections
        (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
        values (${install.connectionId}, ${accountId}, ${install.workspaceId}, 'slack.com',
          'app_install', 'active', '\\x00'::bytea)`;
    }

    // As the expand release writes them: the agent and its one installation
    // first, then its slack_agents row, with the sync triggers standing aside.
    const legacyAgent = async (install: Install, agentVersion: number, legacyVersion: number) => {
      const id = crypto.randomUUID();
      await admin.begin(async (sql) => {
        await sql`select set_config('opengeni.agents_dual_write', '1', true)`;
        await sql`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
            origin, version)
          values (${id}, ${accountId}, ${home}, 'workspace', ${`Agent ${install.label}`},
            ${`agent_${install.label}`}, 'slack', ${agentVersion})`;
        await sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
            connection_id, slack_team_id, name_key, enabled_by_subject_id)
          values (${id}, ${accountId}, ${home}, ${install.connectionId}, 'T0CONTRACT',
            ${`agent_${install.label}`}, ${subject})`;
        await sql`insert into slack_agents (id, account_id, workspace_id, connection_id,
            slack_team_id, target_account_id, target_workspace_id, name, name_key, description,
            avatar, created_by_subject_id, version)
          values (${id}, ${accountId}, ${install.workspaceId}, ${install.connectionId},
            'T0CONTRACT', ${accountId}, ${home}, ${`Agent ${install.label}`},
            ${`agent_${install.label}`}, '', '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb,
            ${subject}, ${legacyVersion})`;
      });
      return id;
    };
    const agentA = await legacyAgent(installA, 3, 5);
    const agentB = await legacyAgent(installB, 2, 1);

    const records = async (agentId: string, install: Install) => {
      const at = { accountId, workspaceId: install.workspaceId, conn: install.connectionId };
      const channel = `C0${install.label.toUpperCase()}`;
      await admin`insert into slack_channel_routes (account_id, workspace_id, connection_id,
          slack_team_id, slack_channel_id, target_account_id, target_workspace_id,
          decided_by_subject_id, decided_by_slack_user_id, source, slack_agent_id)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, 'T0CONTRACT', ${channel},
          ${accountId}, ${home}, ${subject}, 'U0ADMIN', 'admin', ${agentId})`;
      await admin`insert into slack_interactions (account_id, workspace_id, connection_id,
          slack_team_id, slack_channel_id, slack_thread_ts, route_key,
          triggering_provider_event_id, owning_subject_id, visibility, slack_agent_id)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, 'T0CONTRACT', ${channel},
          '1.0', ${`route-${install.label}`}, ${`event-${install.label}`}, ${subject},
          'workspace', ${agentId})`;
      await admin`insert into slack_agent_user_states (account_id, workspace_id, connection_id,
          slack_agent_id, slack_user_id)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, ${agentId}, 'U0PERSON')`;
      await admin`insert into slack_agent_intro_posts (account_id, workspace_id, connection_id,
          slack_agent_id, slack_channel_id, posted_by_subject_id)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, ${agentId}, ${channel}, ${subject})`;
      await admin`insert into slack_agent_suggestions (account_id, workspace_id, connection_id,
          slack_agent_id, interaction_id, turn_id, provider_event_id, slack_team_id,
          slack_user_id, slack_channel_id, slack_thread_ts)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, ${agentId}, gen_random_uuid(),
          gen_random_uuid(), ${`suggest-${install.label}`}, 'T0CONTRACT', 'U0PERSON',
          ${channel}, '1.0')`;
      await admin`insert into slack_agent_proposals (account_id, workspace_id, connection_id,
          slack_team_id, target_account_id, target_workspace_id, proposed_by_session_id,
          slack_channel_id, slack_thread_ts, message_operation_id, name, name_key, description,
          avatar, status, created_slack_agent_id)
        values (${at.accountId}, ${at.workspaceId}, ${at.conn}, 'T0CONTRACT', ${accountId},
          ${home}, gen_random_uuid(), ${channel}, '1.0', gen_random_uuid(),
          ${`Agent ${install.label}`}, ${`agent_${install.label}`}, 'An agent',
          '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb, 'created', ${agentId})`;
    };
    await records(agentA, installA);
    await records(agentB, installB);

    await migrate(owned!.ownerUrl);

    // The installation's workspace came across, and each agent's version
    // never goes below what the legacy Slack agents API last showed.
    expect([
      ...(await admin<{ agent: string; installWorkspace: string; version: number }[]>`
        select i.agent_id::text as agent, i.install_workspace_id::text as "installWorkspace",
          a.version
        from agent_slack_installs i join agents a on a.id = i.agent_id
        where i.account_id = ${accountId} order by a.name`),
    ]).toEqual([
      { agent: agentA, installWorkspace: installA.workspaceId, version: 5 },
      { agent: agentB, installWorkspace: installB.workspaceId, version: 2 },
    ]);

    // Only validated keys to agent_slack_installs are left; the sync triggers
    // are gone and the workspace fill trigger stands in until the legacy drop.
    const keys = await admin<{ name: string; table: string; validated: boolean; target: string }[]>`
      select c.conname as name, c.conrelid::regclass::text as table, c.convalidated as validated,
        c.confrelid::regclass::text as target
      from pg_constraint c
      where c.contype = 'f'
        and c.confrelid in ('slack_agents'::regclass, 'agent_slack_installs'::regclass)
        or c.conname = 'agent_slack_installs_install_workspace_fk'
      order by c.conname`;
    expect([...keys]).toEqual([
      {
        name: "agent_slack_installs_install_workspace_fk",
        table: "agent_slack_installs",
        validated: true,
        target: "workspaces",
      },
      {
        name: "slack_agent_intro_posts_agent_install_fk",
        table: "slack_agent_intro_posts",
        validated: true,
        target: "agent_slack_installs",
      },
      {
        name: "slack_agent_proposals_created_agent_install_fk",
        table: "slack_agent_proposals",
        validated: true,
        target: "agent_slack_installs",
      },
      {
        name: "slack_agent_suggestions_agent_install_fk",
        table: "slack_agent_suggestions",
        validated: true,
        target: "agent_slack_installs",
      },
      {
        name: "slack_agent_user_states_agent_install_fk",
        table: "slack_agent_user_states",
        validated: true,
        target: "agent_slack_installs",
      },
      {
        name: "slack_channel_routes_agent_install_fk",
        table: "slack_channel_routes",
        validated: true,
        target: "agent_slack_installs",
      },
      {
        name: "slack_interactions_agent_install_fk",
        table: "slack_interactions",
        validated: true,
        target: "agent_slack_installs",
      },
    ]);
    const triggers = await admin<{ name: string }[]>`
      select tgname as name from pg_trigger
      where not tgisinternal
        and tgrelid in ('slack_agents'::regclass, 'bot_templates'::regclass)
      order by tgname`;
    expect(triggers.map((row) => row.name)).toEqual(["slack_agents_fill_agent_install_workspace"]);
    const indexes = await admin<{ name: string; valid: boolean }[]>`
      select c.relname as name, i.indisvalid as valid
      from pg_index i join pg_class c on c.oid = i.indexrelid
      where c.relname in ('slack_agent_user_states_install_user_uq',
        'slack_agent_intro_posts_install_channel_uq')
      order by c.relname`;
    expect([...indexes]).toEqual([
      { name: "slack_agent_intro_posts_install_channel_uq", valid: true },
      { name: "slack_agent_user_states_install_user_uq", valid: true },
    ]);

    // A record must name one of the agent's installations.
    const rejected = await admin`insert into slack_agent_user_states (account_id, workspace_id,
        connection_id, slack_agent_id, slack_user_id)
      values (${accountId}, ${installA.workspaceId}, ${installA.connectionId}, ${agentB},
        'U0OTHER')`.catch((error: { code?: string }) => error);
    expect((rejected as { code?: string }).code).toBe("23503");

    // Turning Slack off in one installation removes or unlinks only its
    // records, as deleting its slack_agents row did.
    const left = async (agentId: string) => {
      const [row] = await admin<
        {
          routes: number;
          interactions: number;
          states: number;
          intros: number;
          suggestions: number;
          proposals: number;
        }[]
      >`select
          (select count(*)::int from slack_channel_routes where slack_agent_id = ${agentId}) as routes,
          (select count(*)::int from slack_interactions where slack_agent_id = ${agentId}) as interactions,
          (select count(*)::int from slack_agent_user_states where slack_agent_id = ${agentId}) as states,
          (select count(*)::int from slack_agent_intro_posts where slack_agent_id = ${agentId}) as intros,
          (select count(*)::int from slack_agent_suggestions where slack_agent_id = ${agentId}) as suggestions,
          (select count(*)::int from slack_agent_proposals where created_slack_agent_id = ${agentId}) as proposals`;
      return row;
    };
    const all = { routes: 1, interactions: 1, states: 1, intros: 1, suggestions: 1, proposals: 1 };
    expect(await left(agentA)).toEqual(all);
    await admin`delete from agent_slack_installs where agent_id = ${agentA}`;
    expect(await left(agentA)).toEqual({
      routes: 0,
      interactions: 0,
      states: 0,
      intros: 0,
      suggestions: 0,
      proposals: 0,
    });
    // Unlinked, not deleted: the chat and the proposal stay.
    expect(
      (
        await admin`select 1 from slack_interactions
          where connection_id = ${installA.connectionId} and slack_agent_id is null`
      ).length,
    ).toBe(1);
    expect(
      (
        await admin`select 1 from slack_agent_proposals
          where connection_id = ${installA.connectionId} and created_slack_agent_id is null`
      ).length,
    ).toBe(1);
    expect(await left(agentB)).toEqual(all);

    // Deleting the installation's workspace deletes the installation row.
    await admin`delete from workspaces where id = ${installB.workspaceId}`;
    expect(await admin`select 1 from agent_slack_installs where agent_id = ${agentB}`).toHaveLength(
      0,
    );
  }, 600_000);

  test("an expand-release write still gets its installation's workspace", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const installWorkspace = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const subject = "user:agents-contract-old-writer";
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'Old writer')`;
    for (const id of [home, installWorkspace]) {
      await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    }
    await admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${connectionId}, ${accountId}, ${installWorkspace}, 'slack.com', 'app_install',
        'active', '\\x00'::bytea)`;
    const id = crypto.randomUUID();
    // The runtime role's write grant on the legacy table, as the expand
    // release's role provisioning makes it.
    await admin.unsafe("GRANT SELECT, INSERT, UPDATE, DELETE ON slack_agents TO opengeni_app");
    // The runtime role, scoped as the expand release scopes each statement:
    // the agent's home for agents and agent_slack_installs, the installation's
    // workspace for slack_agents.
    await appSql!.begin(async (sql) => {
      const scope = (workspaceId: string) =>
        sql`select set_config('opengeni.account_id', ${accountId}, true),
          set_config('opengeni.workspace_id', ${workspaceId}, true),
          set_config('opengeni.agents_dual_write', '1', true)`;
      await scope(home);
      await sql`insert into agents (id, account_id, workspace_id, visibility, name, name_key, origin)
        values (${id}, ${accountId}, ${home}, 'workspace', 'Old', 'old', 'slack')`;
      await sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
          connection_id, slack_team_id, name_key, enabled_by_subject_id)
        values (${id}, ${accountId}, ${home}, ${connectionId}, 'T0OLD', 'old', ${subject})`;
      await scope(installWorkspace);
      await sql`insert into slack_agents (id, account_id, workspace_id, connection_id,
          slack_team_id, target_account_id, target_workspace_id, name, name_key, description,
          avatar, created_by_subject_id)
        values (${id}, ${accountId}, ${installWorkspace}, ${connectionId}, 'T0OLD', ${accountId},
          ${home}, 'Old', 'old', '', '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb, ${subject})`;
      // The trigger put the writer's own scope back.
      const [setting] = await sql<{ workspace: string }[]>`
        select current_setting('opengeni.workspace_id', true) as workspace`;
      expect(setting?.workspace).toBe(installWorkspace);
    });
    const [row] = await admin<{ installWorkspace: string | null }[]>`
      select install_workspace_id::text as "installWorkspace" from agent_slack_installs
      where agent_id = ${id}`;
    expect(row?.installWorkspace).toBe(installWorkspace);
  }, 120_000);
});
