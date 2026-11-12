// Agents contract orphans (1387): on a database at 1378, Slack records whose
// agent has no installation row for their connection, and an installation row
// whose workspace is gone, are cleaned up the way each new key's delete rule
// would, so 1388 validates every key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const firstMigrationAfterSeed = "1374_agent_slack_installs_install_workspace_fk.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let owned: OwnerMigratedTestDatabase | null = null;
let prefix: string | null = null;

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("agents-contract-orphans");
  if (!owned) throw new Error("Real PostgreSQL is required for the agents contract migrations");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-agents-contract-orphans-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < firstMigrationAfterSeed) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
}, 600_000);

afterAll(async () => {
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

describe.skipIf(!realDatabase)("1387 agents contract orphans", () => {
  test("orphaned Slack records are unlinked or deleted as their key's delete rule would, and every key validates", async () => {
    const admin = owned!.admin;
    const accountId = crypto.randomUUID();
    const home = crypto.randomUUID();
    const installWorkspace = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    const subject = "user:agents-contract-orphans";
    await admin`insert into managed_accounts (id, name) values (${accountId}, 'Orphans')`;
    for (const id of [home, installWorkspace]) {
      await admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    }
    await admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${connectionId}, ${accountId}, ${installWorkspace}, 'slack.com',
        'app_install', 'active', '\\x00'::bytea)`;

    // An agent and its slack_agents row, with or without its installation row
    // (the sync triggers stand aside).
    const agent = async (label: string, withInstall: boolean) => {
      const id = crypto.randomUUID();
      await admin.begin(async (sql) => {
        await sql`select set_config('opengeni.agents_dual_write', '1', true)`;
        await sql`insert into agents (id, account_id, workspace_id, visibility, name, name_key,
            origin, version)
          values (${id}, ${accountId}, ${home}, 'workspace', ${`Agent ${label}`},
            ${`agent_${label}`}, 'slack', 1)`;
        if (withInstall) {
          await sql`insert into agent_slack_installs (agent_id, account_id, workspace_id,
              connection_id, slack_team_id, name_key, enabled_by_subject_id)
            values (${id}, ${accountId}, ${home}, ${connectionId}, 'T0ORPHANS',
              ${`agent_${label}`}, ${subject})`;
        }
        await sql`insert into slack_agents (id, account_id, workspace_id, connection_id,
            slack_team_id, target_account_id, target_workspace_id, name, name_key, description,
            avatar, created_by_subject_id, version)
          values (${id}, ${accountId}, ${installWorkspace}, ${connectionId}, 'T0ORPHANS',
            ${accountId}, ${home}, ${`Agent ${label}`}, ${`agent_${label}`}, '',
            '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb, ${subject}, 1)`;
      });
      return id;
    };
    const records = async (agentId: string, label: string) => {
      const channel = `C0${label.toUpperCase()}`;
      await admin`insert into slack_channel_routes (account_id, workspace_id, connection_id,
          slack_team_id, slack_channel_id, target_account_id, target_workspace_id,
          decided_by_subject_id, decided_by_slack_user_id, source, slack_agent_id)
        values (${accountId}, ${installWorkspace}, ${connectionId}, 'T0ORPHANS', ${channel},
          ${accountId}, ${home}, ${subject}, 'U0ADMIN', 'admin', ${agentId})`;
      await admin`insert into slack_interactions (account_id, workspace_id, connection_id,
          slack_team_id, slack_channel_id, slack_thread_ts, route_key,
          triggering_provider_event_id, owning_subject_id, visibility, slack_agent_id)
        values (${accountId}, ${installWorkspace}, ${connectionId}, 'T0ORPHANS', ${channel},
          '1.0', ${`route-${label}`}, ${`event-${label}`}, ${subject}, 'workspace', ${agentId})`;
      await admin`insert into slack_agent_user_states (account_id, workspace_id, connection_id,
          slack_agent_id, slack_user_id)
        values (${accountId}, ${installWorkspace}, ${connectionId}, ${agentId}, 'U0PERSON')`;
      await admin`insert into slack_agent_intro_posts (account_id, workspace_id, connection_id,
          slack_agent_id, slack_channel_id, posted_by_subject_id)
        values (${accountId}, ${installWorkspace}, ${connectionId}, ${agentId}, ${channel},
          ${subject})`;
      await admin`insert into slack_agent_suggestions (account_id, workspace_id, connection_id,
          slack_agent_id, interaction_id, turn_id, provider_event_id, slack_team_id,
          slack_user_id, slack_channel_id, slack_thread_ts)
        values (${accountId}, ${installWorkspace}, ${connectionId}, ${agentId},
          gen_random_uuid(), gen_random_uuid(), ${`suggest-${label}`}, 'T0ORPHANS',
          'U0PERSON', ${channel}, '1.0')`;
      await admin`insert into slack_agent_proposals (account_id, workspace_id, connection_id,
          slack_team_id, target_account_id, target_workspace_id, proposed_by_session_id,
          slack_channel_id, slack_thread_ts, message_operation_id, name, name_key, description,
          avatar, status, created_slack_agent_id)
        values (${accountId}, ${installWorkspace}, ${connectionId}, 'T0ORPHANS', ${accountId},
          ${home}, gen_random_uuid(), ${channel}, '1.0', gen_random_uuid(), ${`Agent ${label}`},
          ${`agent_${label}`}, 'An agent', '{"kind":"emoji","emoji":"🤖","hue":1}'::jsonb,
          'created', ${agentId})`;
    };

    // Kept: an agent in its installation.
    const kept = await agent("kept", true);
    await records(kept, "kept");
    // Records whose agent has no installation row for their connection.
    const orphan = await agent("orphan", false);
    await records(orphan, "orphan");
    // An installation row whose installation workspace is gone, and its records.
    const gone = await agent("gone", true);
    await records(gone, "gone");
    await admin`update agent_slack_installs set install_workspace_id = ${crypto.randomUUID()}
      where agent_id = ${gone}`;

    await migrate(owned!.ownerUrl);

    const left = async (agentId: string) => {
      const [row] = await admin<
        {
          installs: number;
          routes: number;
          interactions: number;
          states: number;
          intros: number;
          suggestions: number;
          proposals: number;
        }[]
      >`select
          (select count(*)::int from agent_slack_installs where agent_id = ${agentId}) as installs,
          (select count(*)::int from slack_channel_routes where slack_agent_id = ${agentId}) as routes,
          (select count(*)::int from slack_interactions where slack_agent_id = ${agentId}) as interactions,
          (select count(*)::int from slack_agent_user_states where slack_agent_id = ${agentId}) as states,
          (select count(*)::int from slack_agent_intro_posts where slack_agent_id = ${agentId}) as intros,
          (select count(*)::int from slack_agent_suggestions where slack_agent_id = ${agentId}) as suggestions,
          (select count(*)::int from slack_agent_proposals where created_slack_agent_id = ${agentId}) as proposals`;
      return row;
    };
    const none = {
      installs: 0,
      routes: 0,
      interactions: 0,
      states: 0,
      intros: 0,
      suggestions: 0,
      proposals: 0,
    };
    expect(await left(kept)).toEqual({
      installs: 1,
      routes: 1,
      interactions: 1,
      states: 1,
      intros: 1,
      suggestions: 1,
      proposals: 1,
    });
    expect(await left(orphan)).toEqual(none);
    expect(await left(gone)).toEqual(none);
    // Unlinked, not deleted: the chats and the proposals stay.
    const chats = await admin<{ route: string; agent: string | null }[]>`
      select route_key as route, slack_agent_id::text as agent from slack_interactions
      where connection_id = ${connectionId} order by route_key`;
    expect([...chats]).toEqual([
      { route: "route-gone", agent: null },
      { route: "route-kept", agent: kept },
      { route: "route-orphan", agent: null },
    ]);
    const proposals = await admin<{ name: string; agent: string | null }[]>`
      select name, created_slack_agent_id::text as agent from slack_agent_proposals
      where connection_id = ${connectionId} order by name`;
    expect([...proposals]).toEqual([
      { name: "Agent gone", agent: null },
      { name: "Agent kept", agent: kept },
      { name: "Agent orphan", agent: null },
    ]);

    // Every key validated, and FORCE ROW LEVEL SECURITY is back.
    const keys = await admin<{ name: string; validated: boolean }[]>`
      select conname as name, convalidated as validated from pg_constraint
      where conname in ('agent_slack_installs_install_workspace_fk',
        'slack_channel_routes_agent_install_fk', 'slack_interactions_agent_install_fk',
        'slack_agent_user_states_agent_install_fk',
        'slack_agent_proposals_created_agent_install_fk',
        'slack_agent_intro_posts_agent_install_fk', 'slack_agent_suggestions_agent_install_fk')`;
    expect(keys).toHaveLength(7);
    expect(keys.every((key) => key.validated)).toBe(true);
    const unforced = await admin<{ name: string }[]>`
      select relname as name from pg_class
      where relname in ('agent_slack_installs', 'slack_channel_routes', 'slack_interactions',
        'slack_agent_user_states', 'slack_agent_proposals', 'slack_agent_intro_posts',
        'slack_agent_suggestions')
        and not relforcerowsecurity`;
    expect([...unforced]).toEqual([]);
  }, 600_000);
});
