// Agents reads and writes (src/agents.ts and the Slack agent functions built
// on them) under the production database setup: restricted runtime role,
// FORCE RLS. Covers revisions, Slack availability in several installations
// (and what turning it off in one removes), name clashes, and the Slack
// projections.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  claimSlackAgentOpenNotice,
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
  listSlackAgentIntroChannelIds,
  listSlackAgentsForConnection,
  putAgentSlackInstall,
  readSessionAgentPrompt,
  recordSlackAgentIntroPost,
  sessionAgentRequiresPrivateChat,
  touchSlackAgentUserState,
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

/**
 * An organization with the agents' home and two Slack installations, each
 * bound to its own workspace.
 */
async function organization() {
  const accountId = crypto.randomUUID();
  const install = crypto.randomUUID();
  const otherInstall = crypto.randomUUID();
  const home = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const otherConnectionId = crypto.randomUUID();
  const owner = `user:${crypto.randomUUID()}`;
  await shared.admin`insert into managed_accounts (id, name) values (${accountId}, 'Agents')`;
  for (const [id, name] of [
    [install, "Slack home"],
    [otherInstall, "Other Slack home"],
    [home, "Team"],
  ] as const) {
    await shared.admin`insert into workspaces (id, account_id, name) values (${id}, ${accountId}, ${name})`;
    await shared.admin`insert into workspace_inference_controls (account_id, workspace_id)
      values (${accountId}, ${id}) on conflict (workspace_id) do nothing`;
  }
  for (const [id, workspaceId] of [
    [connectionId, install],
    [otherConnectionId, otherInstall],
  ] as const) {
    await shared.admin`insert into connections
      (id, account_id, workspace_id, provider_domain, kind, status, credential_encrypted)
      values (${id}, ${accountId}, ${workspaceId}, 'slack.com', 'app_install', 'active', '\\x00'::bytea)`;
  }
  return {
    accountId,
    install,
    otherInstall,
    home,
    connectionId,
    otherConnectionId,
    owner,
    homeScope: { accountId, workspaceId: home },
    installScope: { accountId, workspaceId: install },
    otherInstallScope: { accountId, workspaceId: otherInstall },
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

async function revisionCount(id: string): Promise<number> {
  const [row] = await shared.admin<{ count: number }[]>`
    select count(*)::int as count from agent_revisions where agent_id = ${id}`;
  return Number(row?.count ?? 0);
}

describe("agents data layer (restricted runtime role)", () => {
  test("revisions, and a bot template is only an agent", async () => {
    const org = await organization();
    const { agent } = await createAgent(
      app.db,
      org.homeScope,
      agentInput(org, { origin: "bot_template", firstMessage: "Plan it." }),
    );
    expect(await revisionCount(agent.id)).toBe(1);

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
    expect(await revisionCount(agent.id)).toBe(2);
    expect(
      await updateAgent(app.db, org.homeScope, {
        agentId: agent.id,
        expectedVersion: agent.version,
        actorSubjectId: null,
        patch: { name: "Late" },
      }),
    ).toMatchObject({ kind: "version_conflict" });

    expect(await deleteAgent(app.db, org.homeScope, agent.id)).toBe(true);
    expect(await getAgent(app.db, org.homeScope, agent.id)).toBeNull();
  }, 120_000);

  test("Slack availability: several installations, names and projections", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    const put = (agentId: string, connectionId: string, open?: boolean) =>
      putAgentSlackInstall(app.db, org.homeScope, {
        agentId,
        connectionId,
        slackTeamId: "T0AGENTS",
        installWorkspaceId: connectionId === org.connectionId ? org.install : org.otherInstall,
        ...(open !== undefined ? { open } : {}),
        actorSubjectId: org.owner,
      });

    const saved = await put(agent.id, org.connectionId);
    expect(saved).toMatchObject({
      kind: "saved",
      created: true,
      install: { nameKey: "releasehelper", open: false, installWorkspaceId: org.install },
      // Turning Slack on is a change of the agent.
      agent: { version: agent.version + 1 },
    });
    expect(await revisionCount(agent.id)).toBe(1);
    // Idempotent, and available in a second installation too.
    expect(await put(agent.id, org.connectionId)).toMatchObject({ kind: "saved", created: false });
    expect(await put(agent.id, org.otherConnectionId)).toMatchObject({
      kind: "saved",
      created: true,
      install: { installWorkspaceId: org.otherInstall },
    });
    expect(
      (await listAgentSlackInstalls(app.db, org.homeScope, [agent.id])).map(
        (install) => install.connectionId,
      ),
    ).toEqual([org.connectionId, org.otherConnectionId]);

    // Read from each installation's own workspace, Instructions included.
    const [projected] = await listSlackAgentsForConnection(app.db, org.installScope, {
      connectionId: org.connectionId,
    });
    expect(projected).toMatchObject({
      id: agent.id,
      workspaceId: org.install,
      connectionId: org.connectionId,
      targetWorkspaceId: org.home,
      instructions: "Be brief.",
      knowledgeCollectionId: null,
      avatar: { kind: "letters", letters: "RH" },
    });
    expect(
      await listSlackAgentsForConnection(app.db, org.otherInstallScope, {
        connectionId: org.otherConnectionId,
      }),
    ).toMatchObject([{ id: agent.id, workspaceId: org.otherInstall }]);
    // Not from a workspace that is not the installation's.
    expect(
      await listSlackAgentsForConnection(app.db, org.installScope, {
        connectionId: org.otherConnectionId,
      }),
    ).toEqual([]);
    expect(
      await getSlackAgent(app.db, { accountId: org.accountId, agentId: agent.id }),
    ).toMatchObject({ instructions: "Be brief.", connectionId: org.connectionId });
    expect(
      await getSlackAgent(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        connectionId: org.otherConnectionId,
      }),
    ).toMatchObject({ connectionId: org.otherConnectionId, workspaceId: org.otherInstall });

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

    // Open is per installation; a rename renames the handle in every one.
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
    expect(
      (await listAgentSlackInstalls(app.db, org.homeScope, [agent.id])).map((install) => [
        install.nameKey,
        install.open,
      ]),
    ).toEqual([
      ["releaselead", true],
      ["releaselead", false],
    ]);
    expect(
      await getSlackAgent(app.db, {
        accountId: org.accountId,
        agentId: agent.id,
        connectionId: org.connectionId,
      }),
    ).toMatchObject({
      name: "Release lead",
      instructions: "Be very brief.",
      open: true,
      version: current!.version,
    });

    // Off in one installation: the other installation, the agent and its revisions stay.
    expect(
      await deleteAgentSlackInstall(app.db, org.homeScope, {
        agentId: agent.id,
        connectionId: org.connectionId,
      }),
    ).toBe(true);
    expect(
      (await listAgentSlackInstalls(app.db, org.homeScope, [agent.id])).map(
        (install) => install.connectionId,
      ),
    ).toEqual([org.otherConnectionId]);
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

  test("turning Slack off in one installation removes only that installation's Slack records", async () => {
    const org = await organization();
    const { agent } = await createAgent(app.db, org.homeScope, agentInput(org));
    for (const [connectionId, installWorkspaceId] of [
      [org.connectionId, org.install],
      [org.otherConnectionId, org.otherInstall],
    ] as const) {
      expect(
        (
          await putAgentSlackInstall(app.db, org.homeScope, {
            agentId: agent.id,
            connectionId,
            slackTeamId: "T0AGENTS",
            installWorkspaceId,
            actorSubjectId: org.owner,
          })
        ).kind,
      ).toBe("saved");
    }
    // One record per installation.
    for (const [connectionId, scope, slackId] of [
      [org.connectionId, org.installScope, "ONE"],
      [org.otherConnectionId, org.otherInstallScope, "TWO"],
    ] as const) {
      expect(
        await touchSlackAgentUserState(app.db, scope, {
          connectionId,
          slackAgentId: agent.id,
          slackUserId: `U0${slackId}`,
          hintInteractionId: null,
        }),
      ).toEqual({ showHint: false });
      await recordSlackAgentIntroPost(app.db, scope, {
        connectionId,
        slackAgentId: agent.id,
        slackChannelId: `C0${slackId}`,
        postedBySubjectId: org.owner,
      });
      expect(
        await listSlackAgentIntroChannelIds(app.db, scope, {
          slackAgentId: agent.id,
          connectionId,
        }),
      ).toEqual([`C0${slackId}`]);
    }
    const counts = async () => {
      const [row] = await shared.admin<{ states: number; intros: number }[]>`
        select
          (select count(*)::int from slack_agent_user_states where slack_agent_id = ${agent.id}) as states,
          (select count(*)::int from slack_agent_intro_posts where slack_agent_id = ${agent.id}) as intros`;
      return row;
    };
    expect(await counts()).toEqual({ states: 2, intros: 2 });

    // The same Slack person (Enterprise Grid) or shared channel (Slack
    // Connect) in both installations: a record in each.
    expect(
      await touchSlackAgentUserState(app.db, org.otherInstallScope, {
        connectionId: org.otherConnectionId,
        slackAgentId: agent.id,
        slackUserId: "U0ONE",
        hintInteractionId: crypto.randomUUID(),
      }),
    ).toEqual({ showHint: true });
    const notice = crypto.randomUUID();
    expect(
      await claimSlackAgentOpenNotice(app.db, org.otherInstallScope, {
        connectionId: org.otherConnectionId,
        slackAgentId: agent.id,
        slackUserId: "U0ONE",
        interactionId: notice,
      }),
    ).toBe(true);
    await recordSlackAgentIntroPost(app.db, org.otherInstallScope, {
      connectionId: org.otherConnectionId,
      slackAgentId: agent.id,
      slackChannelId: "C0ONE",
      postedBySubjectId: org.owner,
    });
    expect(
      await listSlackAgentIntroChannelIds(app.db, org.otherInstallScope, {
        slackAgentId: agent.id,
        connectionId: org.otherConnectionId,
      }),
    ).toEqual(["C0ONE", "C0TWO"]);
    expect(await counts()).toEqual({ states: 3, intros: 3 });

    await deleteAgentSlackInstall(app.db, org.homeScope, {
      agentId: agent.id,
      connectionId: org.connectionId,
    });
    expect(await counts()).toEqual({ states: 2, intros: 2 });
    const left = await shared.admin<{ connection_id: string }[]>`
      select distinct connection_id::text from slack_agent_user_states
      where slack_agent_id = ${agent.id}`;
    expect(left.map((row) => row.connection_id)).toEqual([org.otherConnectionId]);

    // Deleting the agent removes the rest.
    await deleteAgent(app.db, org.homeScope, agent.id);
    expect(await counts()).toEqual({ states: 0, intros: 0 });
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
    expect(await listAgentSlackInstalls(app.db, org.homeScope, [mine.id])).toEqual([]);

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

  test("the Slack agents API uses the agent's own version", async () => {
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
    const shown = await getSlackAgent(app.db, { accountId: org.accountId, agentId: created.id });
    const agentVersion = (await getAgent(app.db, org.homeScope, created.id))!.version;
    expect(shown?.version).toBe(agentVersion);
    const updated = await updateSlackAgent(app.db, org.installScope, {
      agentId: created.id,
      expectedVersion: agentVersion,
      actorSubjectId: org.owner,
      patch: { description: "Changed" },
    });
    if (!updated || typeof updated === "string") throw new Error(`update failed: ${updated}`);
    expect(updated.version).toBe(agentVersion + 1);
    expect((await getAgent(app.db, org.homeScope, created.id))?.version).toBe(agentVersion + 1);
    expect(
      await updateSlackAgent(app.db, org.installScope, {
        agentId: created.id,
        expectedVersion: agentVersion,
        patch: { description: "Stale" },
      }),
    ).toBe("version_conflict");
    // Only open changed: one version step, no new revision.
    const opened = await updateSlackAgent(app.db, org.installScope, {
      agentId: created.id,
      expectedVersion: agentVersion + 1,
      patch: { open: true },
    });
    if (!opened || typeof opened === "string") throw new Error(`open failed: ${opened}`);
    expect(opened).toMatchObject({ open: true, version: agentVersion + 2 });
  }, 120_000);
});
