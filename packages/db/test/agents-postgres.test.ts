// Agents reads and writes (src/agents.ts and the Slack agent functions built
// on them) under the production database setup: restricted runtime role,
// FORCE RLS. Covers revisions, the legacy rows written in the same
// transaction (and the legacy sync triggers staying out of the way), Slack
// availability in one installation, name clashes, and the Slack projections.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
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
  getAgent,
  getSessionAgent,
  getSlackAgent,
  insertSlackAgent,
  listAgentSlackInstalls,
  listSlackAgentsForConnection,
  putAgentSlackInstall,
  updateAgent,
  updateSlackAgent,
  withWorkspaceSessionActivityRls,
  type CreateAgentInput,
} from "../src/index";

let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("agents-api");
  if (!acquired) throw new Error("PostgreSQL required");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 900_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

/** An organization with a Slack installation's workspace, the agents' home, and two installations. */
async function organization() {
  const accountId = crypto.randomUUID();
  const install = crypto.randomUUID();
  const home = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const otherConnectionId = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Agents')`;
  for (const [id, name] of [
    [install, "Slack home"],
    [home, "Team"],
  ] as const) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, ${name})`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
  }
  for (const id of [connectionId, otherConnectionId]) {
    await shared.admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${id}, ${accountId}, ${install}, 'slack.com', 'app_install', 'active', '\\x00'::bytea)`;
  }
  return {
    accountId,
    install,
    home,
    connectionId,
    otherConnectionId,
    owner,
    homeScope: { accountId, workspaceId: home },
    installScope: { accountId, workspaceId: install },
  };
}

type Org = Awaited<ReturnType<typeof organization>>;

function agentInput(org: Org, overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
  return {
    visibility: "workspace",
    ownerSubjectId: null,
    name: "Release helper",
    description: "Keeps releases moving",
    avatar: null,
    instructions: "Be brief.",
    firstMessage: "",
    memoryEnabled: false,
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: org.owner,
    maxPerWorkspace: 500,
    ...overrides,
  };
}

async function legacySlackRow(id: string) {
  const [row] = await shared.admin<
    {
      workspace_id: string;
      target_workspace_id: string;
      name: string;
      name_key: string;
      instructions: string;
      open: boolean;
      version: number;
      avatar: unknown;
    }[]
  >`select workspace_id::text, target_workspace_id::text, name, name_key, instructions, open,
      version, avatar from slack_agents where id = ${id}`;
  return row ?? null;
}

async function revisionCount(id: string): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from agent_revisions where agent_id = ${id}`;
  return Number(row?.count ?? 0);
}

describe("agents data layer (restricted runtime role)", () => {
  test("revisions, the legacy template row and the triggers standing aside", async () => {
    const org = await organization();
    const { agent } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, {
        origin: "bot_template",
        firstMessage: "Plan it.",
        legacyBotTemplate: true,
      }),
    );
    expect(await revisionCount(agent.id)).toBe(1);
    const [template] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${agent.id}`;
    expect(template?.setup_instructions).toBe("Plan it.");

    // A retried create with the same id finds the agent it made.
    const again = await createAgent(app.db, org.homeScope, {
      ...agentInput(org),
      id: agent.id,
      name: "Something else",
    });
    expect(again).toMatchObject({ created: false, agent: { name: "Release helper" } });

    const updated = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: agent.version,
      actorSubjectId: "user:editor",
      patch: { firstMessage: "Plan the release." },
    });
    expect(updated).toMatchObject({
      kind: "updated",
      revised: true,
      agent: {
        currentRevision: 2,
        content: { firstMessage: "Plan the release.", createdBySubjectId: "user:editor" },
      },
    });
    // Exactly one new revision: the template trigger did not add its own.
    expect(await revisionCount(agent.id)).toBe(2);
    const [synced] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${agent.id}`;
    expect(synced?.setup_instructions).toBe("Plan the release.");
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: agent.id,
        expectedVersion: agent.version,
        actorSubjectId: null,
        patch: { name: "Late" },
      }),
    ).toMatchObject({ kind: "version_conflict" });

    expect(await deleteAgent(app.db, org.homeScope, agent.id)).toBe(true);
    expect(await shared.admin`select id from bot_templates where id = ${agent.id}`).toHaveLength(0);
  }, 120_000);

  test("Slack availability: one installation, the legacy row, names and projections", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    const put = (agentId: string, connectionId: string, open?: boolean) =>
      putAgentSlackInstall(app.db, org.homeScope, {
        agentId,
        connectionId,
        slackTeamId: "T0AGENTS",
        installWorkspaceId: org.install,
        ...(open !== undefined ? { open } : {}),
        actorSubjectId: org.owner,
      });

    const saved = await put(agent.id, org.connectionId);
    expect(saved).toMatchObject({
      kind: "saved",
      created: true,
      install: { nameKey: "releasehelper", open: false, installWorkspaceId: org.install },
    });
    // The legacy row lives in the installation's workspace and targets the home.
    expect(await legacySlackRow(agent.id)).toMatchObject({
      workspace_id: org.install,
      target_workspace_id: org.home,
      name: "Release helper",
      name_key: "releasehelper",
      instructions: "Be brief.",
      version: agent.version,
      avatar: { kind: "letters", letters: "RH" },
    });
    // No duplicate revision from the Slack agent trigger.
    expect(await revisionCount(agent.id)).toBe(1);
    // Idempotent, and at most one installation until the contract step.
    expect(await put(agent.id, org.connectionId)).toMatchObject({ kind: "saved", created: false });
    expect(await put(agent.id, org.otherConnectionId)).toMatchObject({
      kind: "single_install",
      connectionId: org.connectionId,
    });

    // Read from the installation's own workspace, Instructions included.
    const [projected] = await listSlackAgentsForConnection(app.db, org.installScope, {
      connectionId: org.connectionId,
    });
    expect(projected).toMatchObject({
      id: agent.id,
      workspaceId: org.install,
      targetWorkspaceId: org.home,
      instructions: "Be brief.",
      knowledgeCollectionId: null,
    });
    expect(
      await getSlackAgent(app.db, { accountId: org.accountId, agentId: agent.id }),
    ).toMatchObject({ instructions: "Be brief." });

    // Another agent with the same Slack name is refused there; the first keeps it.
    const { agent: twin } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { name: "Release Helper" }),
    );
    expect(await put(twin.id, org.connectionId)).toEqual({ kind: "name_taken" });
    expect(await listAgentSlackInstalls(app.db, org.homeScope, [twin.id])).toEqual([]);
    const { agent: other } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { name: "Ops desk" }),
    );
    expect((await put(other.id, org.connectionId)).kind).toBe("saved");
    const clash = await updateAgent(app.db, org.homeScope, {
      agentId: other.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { name: "release helper" },
    });
    expect(clash).toMatchObject({ kind: "slack_name_taken", connectionId: org.connectionId });
    expect((await getAgent(app.db, org.homeScope, other.id))?.name).toBe("Ops desk");

    // Changes reach the legacy row; open mirrors the agent's version.
    const opened = await put(agent.id, org.connectionId, true);
    expect(opened).toMatchObject({ kind: "saved", install: { open: true } });
    const revised = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { instructions: "Be very brief.", name: "Release lead" },
    });
    expect(revised.kind).toBe("updated");
    const current = await getAgent(app.db, org.homeScope, agent.id);
    expect(await legacySlackRow(agent.id)).toMatchObject({
      name: "Release lead",
      name_key: "releaselead",
      instructions: "Be very brief.",
      open: true,
      version: current!.version,
    });

    // Off in Slack: the legacy row goes, the agent and its revisions stay.
    expect(
      await deleteAgentSlackInstall(app.db, org.homeScope, {
        agentId: agent.id,
        connectionId: org.connectionId,
      }),
    ).toBe(true);
    expect(await legacySlackRow(agent.id)).toBeNull();
    expect(await getAgent(app.db, org.homeScope, agent.id)).not.toBeNull();
    expect(await revisionCount(agent.id)).toBe(2);
  }, 120_000);

  test("the Slack agent functions write through agents", async () => {
    const org = await organization();
    const created = await insertSlackAgent(app.db, org.installScope, {
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      targetAccountId: org.accountId,
      targetWorkspaceId: org.home,
      name: "Data team",
      nameKey: "data-team",
      description: "Answers data questions",
      avatar: { kind: "emoji", emoji: "📊", hue: 120 },
      instructions: "Cite the dashboard.",
      createdBySubjectId: org.owner,
      origin: "slack",
    });
    if (created === "name_taken") throw new Error("unexpected name clash");
    expect(created).toMatchObject({
      workspaceId: org.install,
      targetWorkspaceId: org.home,
      instructions: "Cite the dashboard.",
    });
    expect(await getAgent(app.db, org.homeScope, created.id)).toMatchObject({
      origin: "slack",
      memoryEnabled: true,
      content: { instructions: "Cite the dashboard." },
    });

    // A clashing name creates nothing at all.
    const clash = await insertSlackAgent(app.db, org.installScope, {
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      targetAccountId: org.accountId,
      targetWorkspaceId: org.home,
      name: "Data Team",
      nameKey: "data-team",
      description: "",
      avatar: { kind: "emoji", emoji: "📊", hue: 120 },
      instructions: "",
      createdBySubjectId: org.owner,
    });
    expect(clash).toBe("name_taken");
    const [count] = await shared.admin<{ count: number }[]>`
      select count(*)::int as count from agents where workspace_id = ${org.home}`;
    expect(Number(count?.count)).toBe(1);

    const opened = await updateSlackAgent(app.db, org.installScope, {
      agentId: created.id,
      expectedVersion: created.version,
      actorSubjectId: org.owner,
      patch: { open: true, instructions: "Cite the source." },
    });
    if (!opened || typeof opened === "string") throw new Error(`update failed: ${opened}`);
    expect(opened).toMatchObject({ open: true, instructions: "Cite the source." });
    expect(
      await updateSlackAgent(app.db, org.installScope, {
        agentId: created.id,
        expectedVersion: created.version,
        patch: { description: "Late" },
      }),
    ).toBe("version_conflict");
    // From another workspace than the installation's, it is not found.
    expect(
      await updateSlackAgent(app.db, org.homeScope, {
        agentId: created.id,
        expectedVersion: opened.version,
        patch: { description: "Wrong home" },
      }),
    ).toBeNull();

    expect(await deleteSlackAgent(app.db, org.installScope, { agentId: created.id })).toBe(true);
    expect(await getAgent(app.db, org.homeScope, created.id)).toBeNull();
    expect(await legacySlackRow(created.id)).toBeNull();
  }, 120_000);

  test("a chat's agent: sessions.agent_id, or an older Slack chat's metadata", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    const older = crypto.randomUUID();
    const plain = crypto.randomUUID();
    for (const [id, metadata] of [
      [older, { slackAgent: { id: agent.id, name: agent.name } }],
      [plain, {}],
    ] as const) {
      await withWorkspaceSessionActivityRls(app.db, org.home, (tx) =>
        tx.execute(sql`insert into sessions (id, account_id, workspace_id, status, initial_message,
            metadata, model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy)
          values (${id}, ${org.accountId}, ${org.home}, 'idle', 'hello',
            ${JSON.stringify(metadata)}::jsonb, 'scripted-model', 'medium', 'standard', 'modal', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null))`),
      );
    }
    expect(
      await getSessionAgent(app.db, { workspaceId: org.home, sessionId: older }),
    ).toMatchObject({ agentChat: true, agent: { id: agent.id } });
    expect(await getSessionAgent(app.db, { workspaceId: org.home, sessionId: plain })).toEqual({
      agentChat: false,
      agent: null,
    });
    await deleteAgent(app.db, org.homeScope, agent.id);
    // A deleted agent's chat stays an agent chat (it posts as plain Opengeni).
    expect(await getSessionAgent(app.db, { workspaceId: org.home, sessionId: older })).toEqual({
      agentChat: true,
      agent: null,
    });
  }, 120_000);
});
