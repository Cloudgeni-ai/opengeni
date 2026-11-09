// The contract release deletes an agent's leftover legacy `slack_agents` row
// when it renames or removes the agent or one of its installations, so the
// previous release (which still inserts them) is not refused by a stale
// primary key or name during a rollout or after a rollback. Once the legacy
// drop has removed the table, the same actions still work.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  createAgent,
  createDb,
  deleteAgent,
  deleteAgentSlackInstall,
  deleteSlackAgent,
  putAgentSlackInstall,
  updateAgent,
} from "../src/index";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("agents-legacy-slack-cleanup");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 900_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function organization() {
  const accountId = crypto.randomUUID();
  const home = crypto.randomUUID();
  const installs = [0, 1].map(() => ({
    workspaceId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
  }));
  const owner = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Cleanup')`;
  for (const id of [home, ...installs.map((install) => install.workspaceId)]) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, 'W')`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
  }
  for (const install of installs) {
    await shared.admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${install.connectionId}, ${accountId}, ${install.workspaceId}, 'slack.com',
        'app_install', 'active', '\\x00'::bytea)`;
  }
  return { accountId, home, installs, owner, homeScope: { accountId, workspaceId: home } };
}

type Org = Awaited<ReturnType<typeof organization>>;

async function slackAgent(org: Org, name: string, installCount: number) {
  const { agent } = await createAgent(app.db, org.homeScope, {
    visibility: "workspace",
    ownerSubjectId: null,
    name,
    description: "",
    avatar: null,
    instructions: "Be brief.",
    firstMessage: "",
    memoryEnabled: false,
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: org.owner,
    maxPerWorkspace: 500,
  });
  for (const install of org.installs.slice(0, installCount)) {
    const saved = await putAgentSlackInstall(app.db, org.homeScope, {
      agentId: agent.id,
      connectionId: install.connectionId,
      slackTeamId: "T0CLEAN",
      installWorkspaceId: install.workspaceId,
      actorSubjectId: org.owner,
    });
    expect(saved.kind).toBe("saved");
  }
  return agent;
}

/** The row the previous release (PR3a/PR3b) writes for an agent in an installation. */
async function insertLegacyRow(org: Org, agentId: string, name: string, installIndex = 0) {
  const install = org.installs[installIndex]!;
  const nameKey = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  await shared.admin`insert into slack_agents (id, account_id, workspace_id, connection_id,
      slack_team_id, target_account_id, target_workspace_id, name, name_key, description,
      avatar, instructions, open, created_by_subject_id, version)
    values (${agentId}, ${org.accountId}, ${install.workspaceId}, ${install.connectionId},
      'T0CLEAN', ${org.accountId}, ${org.home}, ${name}, ${nameKey}, '',
      '{"kind":"initials","initials":"A","hue":10}'::jsonb, 'Be brief.', false, ${org.owner}, 1)`;
}

async function legacyRowCount(agentId: string): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from slack_agents where id = ${agentId}`;
  return Number(row?.count ?? 0);
}

describe("leftover legacy Slack rows (restricted runtime role)", () => {
  test("renaming or removing an agent or its installation deletes its legacy row", async () => {
    const org = await organization();

    const renamed = await slackAgent(org, "Desk", 2);
    await insertLegacyRow(org, renamed.id, "Desk");
    // A change that keeps the Slack name leaves it.
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: renamed.id,
        expectedVersion: null,
        patch: { description: "Changed" },
        actorSubjectId: org.owner,
      }),
    ).toMatchObject({ kind: "updated" });
    expect(await legacyRowCount(renamed.id)).toBe(1);
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: renamed.id,
        expectedVersion: null,
        patch: { name: "Front desk" },
        actorSubjectId: org.owner,
      }),
    ).toMatchObject({ kind: "updated" });
    expect(await legacyRowCount(renamed.id)).toBe(0);
    // What the previous release does next now works: its row for the agent
    // id, and another agent taking the freed name.
    await insertLegacyRow(org, renamed.id, "Front desk");
    await insertLegacyRow(org, crypto.randomUUID(), "Desk");
    await shared.admin`delete from slack_agents where id = ${renamed.id}`;

    // Leaving one installation deletes the row of that installation only.
    await insertLegacyRow(org, renamed.id, "Front desk", 1);
    expect(
      await deleteAgentSlackInstall(app.db, org.homeScope, {
        agentId: renamed.id,
        connectionId: org.installs[0]!.connectionId,
      }),
    ).toBe(true);
    expect(await legacyRowCount(renamed.id)).toBe(1);
    expect(
      await deleteAgentSlackInstall(app.db, org.homeScope, {
        agentId: renamed.id,
        connectionId: org.installs[1]!.connectionId,
      }),
    ).toBe(true);
    expect(await legacyRowCount(renamed.id)).toBe(0);
    // The previous release can turn it on again where it left.
    await insertLegacyRow(org, renamed.id, "Front desk", 1);
    expect(await legacyRowCount(renamed.id)).toBe(1);

    const deleted = await slackAgent(org, "Help", 1);
    await insertLegacyRow(org, deleted.id, "Help");
    expect(await deleteAgent(app.db, org.homeScope, deleted.id)).toBe(true);
    expect(await legacyRowCount(deleted.id)).toBe(0);

    const legacyDeleted = await slackAgent(org, "Ops", 1);
    await insertLegacyRow(org, legacyDeleted.id, "Ops");
    expect(
      await deleteSlackAgent(
        app.db,
        { accountId: org.accountId, workspaceId: org.installs[0]!.workspaceId },
        { agentId: legacyDeleted.id, connectionId: org.installs[0]!.connectionId },
      ),
    ).toBe(true);
    expect(await legacyRowCount(legacyDeleted.id)).toBe(0);
  }, 120_000);

  test("the same actions work once the legacy drop removed the table", async () => {
    const org = await organization();
    const agent = await slackAgent(org, "Desk", 2);
    await shared.admin.unsafe(`drop table "${shared.schema}".slack_agents cascade`);
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: agent.id,
        expectedVersion: null,
        patch: { name: "Front desk" },
        actorSubjectId: org.owner,
      }),
    ).toMatchObject({ kind: "updated" });
    expect(
      await deleteAgentSlackInstall(app.db, org.homeScope, {
        agentId: agent.id,
        connectionId: org.installs[0]!.connectionId,
      }),
    ).toBe(true);
    expect(await deleteAgent(app.db, org.homeScope, agent.id)).toBe(true);
  }, 120_000);
});
