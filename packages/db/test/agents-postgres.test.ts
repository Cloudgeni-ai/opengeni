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
  agentInstructionsSql,
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
  readSessionAgentPrompt,
  sessionAgentRequiresPrivateChat,
  updateAgent,
  updateSlackAgent,
  withWorkspaceSessionActivityRls,
  type CreateAgentInput,
} from "../src/index";
import { AGENT_FIRST_MESSAGE_LEAD, agentInstructionsWithFirstMessage } from "@opengeni/contracts";

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
    // A First message joins the Instructions as its own paragraph.
    expect(agent.content).toMatchObject({
      instructions: "Be brief.\n\nWhen a chat starts:\nPlan it.",
      firstMessage: "",
    });
    const [stored] = await shared.admin<{ instructions: string; first_message: string }[]>`
      select instructions, first_message from agent_revisions where agent_id = ${agent.id}`;
    expect(stored).toEqual({
      instructions: "Be brief.\n\nWhen a chat starts:\nPlan it.",
      first_message: "",
    });
    const [template] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${agent.id}`;
    expect(template?.setup_instructions).toBe("Be brief.\n\nWhen a chat starts:\nPlan it.");

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
      patch: { instructions: "Plan the release." },
    });
    expect(updated).toMatchObject({
      kind: "updated",
      revised: true,
      agent: {
        currentRevision: 2,
        content: { instructions: "Plan the release.", createdBySubjectId: "user:editor" },
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

  test("an older First message joins the Instructions when read, and is stored that way on the next change", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    // As an older release stores it: a revision with a First message.
    const olderRevision = async (instructions: string, firstMessage: string) => {
      await shared.admin.begin(async (tx) => {
        const [row] = await tx<{ revision: number }[]>`
          update agents set current_revision = current_revision + 1
          where id = ${agent.id} returning current_revision as revision`;
        await tx`insert into agent_revisions (agent_id, account_id, workspace_id, revision, name,
            instructions, first_message)
          values (${agent.id}, ${org.accountId}, ${org.home}, ${row!.revision}, 'Release helper',
            ${instructions}, ${firstMessage})`;
      });
    };
    await olderRevision("Be brief.", "  Ask which release.  ");
    const read = await getAgent(app.db, org.homeScope, agent.id);
    expect(read?.content).toMatchObject({
      instructions: "Be brief.\n\nWhen a chat starts:\nAsk which release.",
      firstMessage: "",
    });
    expect(read?.hasFirstMessage).toBe(false);
    // Any change stores it joined, once.
    const renamed = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: read!.version,
      actorSubjectId: org.owner,
      patch: { name: "Release desk" },
    });
    expect(renamed).toMatchObject({ kind: "updated", revised: true });
    const [stored] = await shared.admin<{ instructions: string; first_message: string }[]>`
      select r.instructions, r.first_message from agents a
      join agent_revisions r on r.agent_id = a.id and r.revision = a.current_revision
      where a.id = ${agent.id}`;
    expect(stored).toEqual({
      instructions: "Be brief.\n\nWhen a chat starts:\nAsk which release.",
      first_message: "",
    });
    // Sent again by an older client, it isn't added twice.
    const again = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { firstMessage: "Ask which release." },
    });
    expect(again).toMatchObject({ kind: "updated", revised: false });
    // New Instructions replace a stored First message: they were written over the joined text.
    await olderRevision("Be brief.", "Ask which release.");
    const rewritten = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { instructions: "Be thorough." },
    });
    expect(rewritten).toMatchObject({
      kind: "updated",
      agent: { content: { instructions: "Be thorough.", firstMessage: "" } },
    });
    // Too long together: both are kept as sent, and readers still see them joined.
    const long = "x".repeat(15_000);
    const kept = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { name: "Long one", instructions: long, firstMessage: "y".repeat(15_000) }),
    );
    const [both] = await shared.admin<{ instructions: string; first_message: string }[]>`
      select instructions, first_message from agent_revisions where agent_id = ${kept.agent.id}`;
    expect(both?.instructions.length).toBe(15_000);
    expect(both?.first_message.length).toBe(15_000);
    expect(kept.agent.content?.instructions.length).toBe(
      30_002 + `${AGENT_FIRST_MESSAGE_LEAD}\n`.length,
    );
    // A legacy template row copies the stored First message as it is, never a
    // cut joined text, so an older release writing it back loses nothing.
    const keptTemplate = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, {
        name: "Long template",
        origin: "bot_template",
        legacyBotTemplate: true,
        instructions: long,
        firstMessage: "y".repeat(15_000),
      }),
    );
    const [legacy] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${keptTemplate.agent.id}`;
    expect(legacy?.setup_instructions).toBe("y".repeat(15_000));
    // The SQL form, for reads that never map an agent, reads the same.
    const viaSql = async (instructions: string, firstMessage: string) => {
      const rows = (await app.db.execute(
        sql`select ${agentInstructionsSql("r")} as joined
          from (values (${instructions}::text, ${firstMessage}::text)) as r(instructions, first_message)`,
      )) as unknown as { rows?: { joined: string }[] } | { joined: string }[];
      const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
      return list[0]?.joined;
    };
    for (const [instructions, firstMessage] of [
      ["Be brief.", ""],
      ["Be brief.", "  Ask which release.\n"],
      ["", " Ask. "],
      ["Be brief. Ask.", "Ask."],
      ["Line one\n", "Line two"],
    ] as const) {
      expect(await viaSql(instructions, firstMessage)).toBe(
        agentInstructionsWithFirstMessage(instructions, firstMessage),
      );
    }
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
      // Turning Slack on is a change of the agent.
      version: agent.version + 1,
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

  test("a chat's agent: sessions.agent_id, or an older Slack chat's interaction", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    await putAgentSlackInstall(app.db, org.homeScope, {
      agentId: agent.id,
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      installWorkspaceId: org.install,
      actorSubjectId: org.owner,
    });
    const older = crypto.randomUUID();
    const forged = crypto.randomUUID();
    const plain = crypto.randomUUID();
    for (const [id, metadata] of [
      [older, { slackAgent: { id: agent.id, name: agent.name } }],
      [forged, { slackAgent: { id: agent.id, name: agent.name } }],
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
    // The older Slack chat names its agent through its interaction.
    await shared.admin`insert into slack_interactions
      (account_id, workspace_id, connection_id, slack_team_id, slack_channel_id, slack_thread_ts,
       route_key, triggering_provider_event_id, owning_subject_id, visibility, session_id,
       session_reservation_id, slack_agent_id)
      values (${org.accountId}, ${org.home}, ${org.connectionId}, 'T0AGENTS', 'C0AGENTS', '1.1',
        ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${org.owner}, 'workspace', ${older},
        ${older}, ${agent.id})`;
    expect(
      await getSessionAgent(app.db, { workspaceId: org.home, sessionId: older }),
    ).toMatchObject({ agentChat: true, agent: { id: agent.id } });
    // Metadata a caller set on create never names the agent.
    expect(await getSessionAgent(app.db, { workspaceId: org.home, sessionId: forged })).toEqual({
      agentChat: true,
      agent: null,
    });
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

  test("an Only me agent serves only its owner's Only me chats", async () => {
    const org = await organization();
    const personal = crypto.randomUUID();
    await shared.admin`insert into workspaces (id, account_id, name) values (${personal}, ${org.accountId}, 'Personal')`;
    const [membership] = await shared.admin<{ id: string }[]>`
      insert into organization_memberships (account_id, subject_id, role, status, personal_workspace_id)
      values (${org.accountId}, ${org.owner}, 'member', 'active', ${personal}) returning id::text`;
    const { agent } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { visibility: "private", ownerSubjectId: org.owner }),
    );
    const { agent: sharedAgent } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { name: "Shared helper" }),
    );
    const mine = crypto.randomUUID();
    const sharedLater = crypto.randomUUID();
    const onShared = crypto.randomUUID();
    for (const id of [mine, sharedLater, onShared]) {
      await withWorkspaceSessionActivityRls(app.db, org.home, (tx) =>
        tx.execute(sql`insert into sessions (id, account_id, workspace_id, status, initial_message,
            metadata, model, reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, tool_policy)
          values (${id}, ${org.accountId}, ${org.home}, 'idle', 'hello', '{}'::jsonb,
            'scripted-model', 'medium', 'standard', 'modal', ${id},
            jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null))`),
      );
    }
    // Visibility set directly: the tenancy transition itself is not under test here.
    const setChat = (id: string, agentId: string, onlyMe: boolean) =>
      shared.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update sessions set agent_id = ${agentId}, agent_prompt_revision = 1,
            visibility = ${onlyMe ? "user_private" : "workspace_shared"},
            owner_subject_id = ${onlyMe ? org.owner : null},
            owner_organization_membership_id = ${onlyMe ? membership!.id : null}::uuid
          where id = ${id}`;
      });
    await setChat(mine, agent.id, true);
    await setChat(sharedLater, agent.id, true);
    await setChat(onShared, sharedAgent.id, false);
    const prompt = (sessionId: string) =>
      readSessionAgentPrompt(app.db, { ...org.homeScope, sessionId });
    expect(await prompt(mine)).toEqual({
      agentId: agent.id,
      revision: 1,
      instructions: "Be brief.",
    });
    expect(
      await sessionAgentRequiresPrivateChat(app.db, { workspaceId: org.home, sessionId: mine }),
    ).toBe(true);
    expect(
      await sessionAgentRequiresPrivateChat(app.db, { workspaceId: org.home, sessionId: onShared }),
    ).toBe(false);
    // Shared after it started: it continues as a plain chat.
    await setChat(sharedLater, agent.id, false);
    expect(await prompt(sharedLater)).toEqual({
      agentId: agent.id,
      revision: 1,
      instructions: null,
    });
    // A shared agent made Only me: its shared chats continue as plain chats.
    expect((await prompt(onShared))?.instructions).toBe("Be brief.");
    const madePrivate = await updateAgent(app.db, org.homeScope, {
      agentId: sharedAgent.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { visibility: "private", ownerSubjectId: org.owner },
    });
    expect(madePrivate.kind).toBe("updated");
    expect((await prompt(onShared))?.instructions).toBeNull();
  }, 120_000);

  test("the legacy Slack row's version never goes backwards", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    await putAgentSlackInstall(app.db, org.homeScope, {
      agentId: agent.id,
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      installWorkspaceId: org.install,
      actorSubjectId: org.owner,
    });
    await shared.admin`update slack_agents set version = 7 where id = ${agent.id}`;
    const revised = await updateAgent(app.db, org.homeScope, {
      agentId: agent.id,
      expectedVersion: null,
      actorSubjectId: org.owner,
      patch: { description: "Newer" },
    });
    expect(revised.kind).toBe("updated");
    expect(await legacySlackRow(agent.id)).toMatchObject({ version: 8 });
    expect(
      (await getSlackAgent(app.db, { accountId: org.accountId, agentId: agent.id }))?.version,
    ).toBe(8);
  }, 120_000);

  test("an agent in Slack stays shared, checked under its row lock", async () => {
    const org = await organization();
    const { agent: mine } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { visibility: "private", ownerSubjectId: org.owner, name: "Diary" }),
    );
    // The route's own check could be stale; the write refuses anyway.
    expect(
      await putAgentSlackInstall(app.db, org.homeScope, {
        agentId: mine.id,
        connectionId: org.connectionId,
        slackTeamId: "T0AGENTS",
        installWorkspaceId: org.install,
        actorSubjectId: org.owner,
      }),
    ).toEqual({ kind: "requires_workspace_visibility" });
    expect(await legacySlackRow(mine.id)).toBeNull();

    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    const saved = await putAgentSlackInstall(app.db, org.homeScope, {
      agentId: agent.id,
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      installWorkspaceId: org.install,
      actorSubjectId: org.owner,
    });
    // Turning Slack on changes the agent: a stale edit conflicts.
    expect(saved).toMatchObject({ kind: "saved", agent: { version: agent.version + 1 } });
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: agent.id,
        expectedVersion: agent.version,
        actorSubjectId: org.owner,
        patch: { description: "Stale" },
      }),
    ).toMatchObject({ kind: "version_conflict" });
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: agent.id,
        expectedVersion: null,
        actorSubjectId: org.owner,
        patch: { visibility: "private", ownerSubjectId: org.owner },
      }),
    ).toEqual({ kind: "requires_workspace_visibility" });
    expect((await getAgent(app.db, org.homeScope, agent.id))?.visibility).toBe("workspace");
  }, 120_000);

  test("the legacy Slack API accepts either version during the rollout", async () => {
    const org = await organization();
    const created = await insertSlackAgent(app.db, org.installScope, {
      connectionId: org.connectionId,
      slackTeamId: "T0AGENTS",
      targetAccountId: org.accountId,
      targetWorkspaceId: org.home,
      name: "Data team",
      nameKey: "data-team",
      description: "",
      avatar: { kind: "emoji", emoji: "📊", hue: 120 },
      instructions: "Cite the dashboard.",
      createdBySubjectId: org.owner,
    });
    if (created === "name_taken") throw new Error("unexpected name clash");
    // As after the backfill: the legacy row is ahead of the agent.
    await shared.admin`update slack_agents set version = 7 where id = ${created.id}`;
    const shown = await getSlackAgent(app.db, { accountId: org.accountId, agentId: created.id });
    expect(shown?.version).toBe(7);
    const updated = await updateSlackAgent(app.db, org.installScope, {
      agentId: created.id,
      expectedVersion: 7,
      actorSubjectId: org.owner,
      patch: { description: "From an older page" },
    });
    if (!updated || typeof updated === "string") throw new Error(`update failed: ${updated}`);
    expect(updated.version).toBe(8);
    expect(await legacySlackRow(created.id)).toMatchObject({ version: 8 });
    expect((await getAgent(app.db, org.homeScope, created.id))?.version).toBe(8);
    expect(
      await updateSlackAgent(app.db, org.installScope, {
        agentId: created.id,
        expectedVersion: 7,
        patch: { description: "Stale" },
      }),
    ).toBe("version_conflict");
    // Only open changed: one version step, no new revision.
    const opened = await updateSlackAgent(app.db, org.installScope, {
      agentId: created.id,
      expectedVersion: 8,
      patch: { open: true },
    });
    if (!opened || typeof opened === "string") throw new Error(`open failed: ${opened}`);
    expect(opened).toMatchObject({ open: true, version: 9 });
  }, 120_000);
});
