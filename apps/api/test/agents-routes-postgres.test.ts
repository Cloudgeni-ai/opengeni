import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Permission } from "@opengeni/contracts";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, SessionWorkflowClient } from "@opengeni/core";
import { createDb, createSession, listSlackAgentChats, type DbClient } from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createApp } from "../src/app";

// Agents through the API (real PostgreSQL): `/agents` CRUD with revisions and
// optimistic versions, who may see and change an agent, the legacy rows kept
// for older releases, chats started with an agent, and which of its chats
// each reader sees.

const DELEGATION_SECRET = "agents-api-test-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient;
let app: ReturnType<typeof createApp>;

type Workspace = { accountId: string; workspaceId: string };

class WorkflowStub implements SessionWorkflowClient {
  async signalUserMessage(): Promise<void> {}
  async wakeSessionWorkflow(): Promise<void> {}
  async requestSessionWorkflowWakeDispatch(): Promise<void> {}
  async signalApprovalDecision(): Promise<void> {}
  async signalSessionControl(): Promise<void> {}
  async syncScheduledTask(): Promise<void> {}
  async deleteScheduledTaskSchedule(): Promise<void> {}
  async triggerScheduledTask(): Promise<void> {}
}

async function freshWorkspace(name: string): Promise<Workspace> {
  const admin = shared!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  // Only me chats need the organization's private-chat activation.
  await admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${account!.id}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'agents-test')
    on conflict do nothing`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

/** Make a person a member of the workspace and its organization. */
async function member(workspace: Workspace, subjectId: string): Promise<void> {
  const admin = shared!.admin;
  const [personal] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${workspace.accountId}, ${`Personal ${subjectId}`}) returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${personal!.id}, ${workspace.accountId})`;
  await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${workspace.accountId}, ${subjectId}, 'active', ${personal!.id})`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${workspace.accountId}, ${workspace.workspaceId}, ${subjectId})`;
}

async function bearer(
  workspace: Workspace,
  subjectId: string,
  permissions: Permission[],
): Promise<string> {
  const token = await signDelegatedAccessToken(DELEGATION_SECRET, {
    ...workspace,
    subjectId,
    subjectLabel: subjectId,
    permissions,
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1000) + 3_600,
  });
  return `Bearer ${token}`;
}

async function call(
  auth: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await app.request(path, {
    method,
    headers: { "content-type": "application/json", authorization: auth },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const PERSON: Permission[] = ["workspace:read", "sessions:create", "sessions:read"];

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-agents");
  if (!shared) return;
  client = createDb(shared.appUrl);
  const deps = {
    settings: testSettings({
      databaseUrl: shared.appUrl,
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxBackend: "none",
    }),
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: new WorkflowStub(),
    objectStorage: null,
    githubStateSecret: "agents-test-state",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services are not used by agent tests");
    },
    resumeBoxById: async () => {
      throw new Error("sandbox resume is not used with backend=none");
    },
  } as unknown as ApiRouteDeps;
  app = createApp(deps);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("agents through the API (real PostgreSQL)", () => {
  test("create, read, change with revisions and versions, delete", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("agents crud");
    await member(workspace, "user:alice");
    const alice = await bearer(workspace, "user:alice", PERSON);
    const reader = await bearer(workspace, "user:reader", ["workspace:read", "sessions:read"]);
    const base = `/v1/workspaces/${workspace.workspaceId}/agents`;

    // Lenient input, clear errors.
    const blank = await call(alice, "POST", base, { name: "   " });
    expect(blank.status).toBe(400);
    expect(JSON.stringify(blank.json)).toContain("Give the agent a name.");
    const long = await call(alice, "POST", base, {
      name: "Long",
      instructions: "x".repeat(20_001),
    });
    expect(long.status).toBe(400);
    expect((await call(reader, "POST", base, { name: "Nope" })).status).toBe(403);

    const created = await call(alice, "POST", base, {
      name: "  Release helper ",
      description: "Keeps releases moving",
      instructions: "Answer in short sentences.",
      firstMessage: "Help me plan the next release.",
    });
    expect(created.status).toBe(201);
    const agent = created.json.agent;
    expect(agent).toMatchObject({
      workspaceId: workspace.workspaceId,
      name: "Release helper",
      description: "Keeps releases moving",
      avatar: null,
      visibility: "workspace",
      ownerSubjectId: null,
      origin: "app",
      createdBySubjectId: "user:alice",
      revision: 1,
      // An older client's First message joins the Instructions as its own paragraph.
      hasFirstMessage: false,
      instructions:
        "Answer in short sentences.\n\nWhen a chat starts:\nHelp me plan the next release.",
      firstMessage: "",
      revisionCreatedBySubjectId: "user:alice",
      memory: { enabled: false, collectionId: null, scope: "workspace" },
      slack: [],
      viewer: { canEdit: true, canManageSlack: false, canOpenInSlack: false },
      version: 1,
    });
    // An agent made in the app keeps no legacy template row.
    expect(await shared.admin`select id from bot_templates where id = ${agent.id}`).toHaveLength(0);

    expect((await call(reader, "GET", `${base}/${agent.id}`)).json.agent).toMatchObject({
      instructions:
        "Answer in short sentences.\n\nWhen a chat starts:\nHelp me plan the next release.",
      viewer: { canEdit: false },
    });
    const listed = await call(reader, "GET", base);
    expect(listed.json.agents.map((row: any) => row.id)).toEqual([agent.id]);
    expect(listed.json.agents[0]).not.toHaveProperty("instructions");
    expect((await call(reader, "GET", `${base}?filter=yours`)).json.agents).toEqual([]);
    expect((await call(alice, "GET", `${base}?filter=yours`)).json.agents).toHaveLength(1);

    // A rename alone keeps the revision; changing the Instructions adds one.
    const renamed = await call(alice, "PATCH", `${base}/${agent.id}`, {
      expectedVersion: 1,
      name: "Release lead",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.json.agent).toMatchObject({ name: "Release lead", revision: 1, version: 2 });
    const stale = await call(alice, "PATCH", `${base}/${agent.id}`, {
      expectedVersion: 1,
      instructions: "Never seen.",
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.details).toMatchObject({
      code: "agent_version_conflict",
      currentVersion: 2,
    });
    const revised = await call(alice, "PATCH", `${base}/${agent.id}`, {
      expectedVersion: 2,
      instructions: "Answer in one sentence.",
    });
    expect(revised.json.agent).toMatchObject({
      revision: 2,
      instructions: "Answer in one sentence.",
      firstMessage: "",
      version: 3,
    });
    const revisions = await call(alice, "GET", `${base}/${agent.id}/revisions?limit=1`);
    expect(revisions.json.revisions).toEqual([
      expect.objectContaining({ revision: 2, instructions: "Answer in one sentence." }),
    ]);
    expect(revisions.json.nextCursor).toBe("2");
    const older = await call(alice, "GET", `${base}/${agent.id}/revisions?cursor=2`);
    expect(older.json).toMatchObject({
      revisions: [
        {
          revision: 1,
          instructions:
            "Answer in short sentences.\n\nWhen a chat starts:\nHelp me plan the next release.",
          firstMessage: "",
        },
      ],
      nextCursor: null,
    });

    expect((await call(reader, "DELETE", `${base}/${agent.id}`)).status).toBe(403);
    expect((await call(alice, "DELETE", `${base}/${agent.id}`)).json).toEqual({ deleted: true });
    expect((await call(alice, "GET", `${base}/${agent.id}`)).status).toBe(404);
  }, 180_000);

  test("who may change an agent, and Only me agents", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("agents permissions");
    for (const subject of ["user:alice", "user:bob"]) await member(workspace, subject);
    const alice = await bearer(workspace, "user:alice", PERSON);
    const bob = await bearer(workspace, "user:bob", PERSON);
    const admin = await bearer(workspace, "user:admin", ["workspace:admin"]);
    const base = `/v1/workspaces/${workspace.workspaceId}/agents`;

    const shared_ = (await call(alice, "POST", base, { name: "Team helper" })).json.agent;
    // Another member uses it but cannot change it; an admin can.
    expect((await call(bob, "GET", `${base}/${shared_.id}`)).json.agent.viewer.canEdit).toBe(false);
    expect(
      (await call(bob, "PATCH", `${base}/${shared_.id}`, { expectedVersion: 1, name: "Mine" }))
        .status,
    ).toBe(403);
    const byAdmin = await call(admin, "PATCH", `${base}/${shared_.id}`, {
      expectedVersion: 1,
      description: "Helps the team",
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.json.agent.viewer).toMatchObject({ canEdit: true, canManageSlack: true });
    // ...but only whoever made it (or an admin) takes it away from everyone.
    const hidden = await call(alice, "PATCH", `${base}/${shared_.id}`, {
      expectedVersion: 2,
      visibility: "private",
    });
    expect(hidden.status).toBe(200);
    expect(hidden.json.agent).toMatchObject({
      visibility: "private",
      ownerSubjectId: "user:alice",
      memory: { scope: "personal" },
    });

    // Only me: nobody else sees it, not even an admin.
    const mine = await call(alice, "POST", base, { name: "Inbox", visibility: "private" });
    expect(mine.status).toBe(201);
    expect(mine.json.agent).toMatchObject({ visibility: "private", ownerSubjectId: "user:alice" });
    for (const other of [bob, admin]) {
      expect((await call(other, "GET", base)).json.agents).toEqual([]);
      expect((await call(other, "GET", `${base}/${mine.json.agent.id}`)).status).toBe(404);
    }
    expect((await call(alice, "GET", base)).json.agents).toHaveLength(2);
    // A person the organization does not know cannot keep one to themselves.
    const stranger = await bearer(workspace, "user:stranger", PERSON);
    const refused = await call(stranger, "POST", base, { name: "Secret", visibility: "private" });
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toContain("member of the organization");
  }, 180_000);

  test("bot templates are agents: setup text as Instructions, legacy row, and ids", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("agents templates");
    await member(workspace, "user:alice");
    const alice = await bearer(workspace, "user:alice", PERSON);
    const templates = `/v1/workspaces/${workspace.workspaceId}/bot-templates`;
    const agents = `/v1/workspaces/${workspace.workspaceId}/agents`;

    const saved = await call(alice, "POST", templates, {
      name: "SRE bot",
      setupInstructions: "Ask how they deploy today.",
    });
    expect(saved.status).toBe(201);
    const id = saved.json.template.id as string;
    // Same id, template text as its Instructions.
    expect((await call(alice, "GET", `${agents}/${id}`)).json.agent).toMatchObject({
      origin: "bot_template",
      instructions: "Ask how they deploy today.",
      firstMessage: "",
    });
    const [legacy] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${id}`;
    expect(legacy?.setup_instructions).toBe("Ask how they deploy today.");

    // A change through /agents keeps the legacy row in step.
    await call(alice, "PATCH", `${agents}/${id}`, {
      expectedVersion: 1,
      instructions: "Ask how they deploy.",
    });
    const [synced] = await shared.admin<{ setup_instructions: string }[]>`
      select setup_instructions from bot_templates where id = ${id}`;
    expect(synced?.setup_instructions).toBe("Ask how they deploy.");
    // Only agents made as templates are listed: the old gallery opens them
    // unbound, as composer text.
    const plain = await call(alice, "POST", agents, {
      name: "Plain agent",
      instructions: "Be brief.",
    });
    await call(alice, "POST", agents, { name: "Greeter", firstMessage: "Say hello." });
    expect(
      (await call(alice, "GET", templates)).json.templates.map((row: any) => [
        row.name,
        row.setupInstructions,
      ]),
    ).toEqual([["SRE bot", "Ask how they deploy."]]);
    // It is still reachable by id.
    expect(
      (await call(alice, "GET", `${templates}/${plain.json.agent.id}`)).json.template,
    ).toMatchObject({ name: "Plain agent", setupInstructions: "Be brief." });
    expect((await call(alice, "DELETE", `${templates}/${id}`)).status).toBe(200);
    expect(await shared.admin`select id from agents where id = ${id}`).toHaveLength(0);
    expect(await shared.admin`select id from bot_templates where id = ${id}`).toHaveLength(0);
  }, 180_000);

  test("a chat started with an agent runs on its current revision; chats list by privacy", async () => {
    if (!shared) return;
    const workspace = await freshWorkspace("agents chats");
    for (const subject of ["user:alice", "user:bob"]) await member(workspace, subject);
    const alice = await bearer(workspace, "user:alice", PERSON);
    const bob = await bearer(workspace, "user:bob", PERSON);
    const agents = `/v1/workspaces/${workspace.workspaceId}/agents`;
    const sessions = `/v1/workspaces/${workspace.workspaceId}/sessions`;

    const agent = (
      await call(alice, "POST", agents, { name: "Planner", instructions: "Plan carefully." })
    ).json.agent;
    await call(alice, "PATCH", `${agents}/${agent.id}`, {
      expectedVersion: 1,
      instructions: "Plan very carefully.",
    });

    const chat = await call(alice, "POST", sessions, {
      initialMessage: "Plan the week",
      model: "scripted-model",
      agentId: agent.id,
    });
    expect(chat.status).toBe(202);
    expect(chat.json.agentId).toBe(agent.id);
    const [row] = await shared.admin<
      { agent_id: string; agent_prompt_revision: number; instructions: string | null }[]
    >`select agent_id::text, agent_prompt_revision, instructions from sessions
      where id = ${chat.json.id}`;
    // Bound to the agent at its current revision; nothing copied into the chat.
    expect(row).toEqual({ agent_id: agent.id, agent_prompt_revision: 2, instructions: null });
    expect((await call(alice, "GET", `${sessions}/${chat.json.id}`)).json.agentId).toBe(agent.id);

    // An agent nobody here can use refuses the create.
    const missing = await call(alice, "POST", sessions, {
      initialMessage: "Plan the week",
      model: "scripted-model",
      agentId: crypto.randomUUID(),
    });
    expect(missing.status).toBe(422);
    const mine = (await call(alice, "POST", agents, { name: "Diary", visibility: "private" })).json
      .agent;
    const foreign = await call(bob, "POST", sessions, {
      initialMessage: "Read the diary",
      model: "scripted-model",
      agentId: mine.id,
    });
    expect(foreign.status).toBe(422);
    // An Only me agent's chat is Only me: the default (this fixture's people
    // are not managed-account users, so the Only me create itself is refused,
    // which shows the default applied), and a shared one is refused.
    const diary = await call(alice, "POST", sessions, {
      initialMessage: "Dear diary",
      model: "scripted-model",
      agentId: mine.id,
    });
    expect(diary.status).toBe(403);
    expect(diary.json.message).toContain("Only-me");
    const sharedDiary = await call(alice, "POST", sessions, {
      initialMessage: "Dear everyone",
      model: "scripted-model",
      agentId: mine.id,
      visibility: "workspace",
    });
    expect(sharedDiary.status).toBe(422);
    expect(sharedDiary.json.details).toMatchObject({ code: "agent_requires_private_chat" });

    // Alice's Only me chat with the shared agent: listed only to her.
    const privateChat = await createSession(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "Just for me",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: "user:alice" },
      subjectId: "user:alice",
      visibility: "user_private",
      agent: { id: agent.id },
    });
    const bobs = await call(bob, "POST", sessions, {
      initialMessage: "Plan my week",
      model: "scripted-model",
      agentId: agent.id,
    });
    expect(bobs.status).toBe(202);
    // Alice's Slack DM with the agent: a shared session row, private through
    // its interaction, so listed only to her as well.
    const slackDm = await createSession(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      initialMessage: "A private question",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: "user:alice" },
      subjectId: "user:alice",
      agent: { id: agent.id },
    });
    const [connection] = await shared.admin<Array<{ id: string }>>`
      insert into connections (
        account_id, workspace_id, provider_domain, kind, status, credential_encrypted
      ) values (${workspace.accountId}, ${workspace.workspaceId}, 'slack.com', 'app_install',
        'active', 'sealed')
      returning id`;
    await shared.admin`
      insert into slack_interactions (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
        visibility, session_reservation_id, session_id
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, ${connection!.id}, 'T1', 'D1', '1.1',
        ${`route-${crypto.randomUUID()}`}, ${`evt-${crypto.randomUUID()}`},
        'user:alice', 'private', ${slackDm.id}, ${slackDm.id}
      )`;

    const ids = (response: { json: any }) =>
      (response.json.chats as Array<{ sessionId: string }>).map((entry) => entry.sessionId).sort();
    const everyoneForAlice = await call(
      alice,
      "GET",
      `${agents}/${agent.id}/chats?filter=everyone`,
    );
    expect(ids(everyoneForAlice)).toEqual(
      [chat.json.id, privateChat.id, bobs.json.id, slackDm.id].sort(),
    );
    expect(
      everyoneForAlice.json.chats.find((entry: any) => entry.sessionId === privateChat.id),
    ).toMatchObject({ visibility: "private", source: "app", slack: null });
    expect(
      everyoneForAlice.json.chats.find((entry: any) => entry.sessionId === slackDm.id),
    ).toMatchObject({ visibility: "private", source: "slack" });
    expect(ids(await call(bob, "GET", `${agents}/${agent.id}/chats?filter=everyone`))).toEqual(
      [chat.json.id, bobs.json.id].sort(),
    );
    expect(ids(await call(bob, "GET", `${agents}/${agent.id}/chats`))).toEqual([bobs.json.id]);
    // An agent's other chats never see either private chat.
    const shared_ = await listSlackAgentChats(client.db, {
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      slackAgentId: agent.id,
      limit: 50,
    });
    expect(shared_.map((entry) => entry.sessionId).sort()).toEqual(
      [chat.json.id, bobs.json.id].sort(),
    );
    // Paged newest first.
    const first = await call(alice, "GET", `${agents}/${agent.id}/chats?filter=everyone&limit=2`);
    expect(first.json.chats).toHaveLength(2);
    const rest = await call(
      alice,
      "GET",
      `${agents}/${agent.id}/chats?filter=everyone&limit=2&cursor=${first.json.nextCursor}`,
    );
    expect(rest.json).toMatchObject({ nextCursor: null });
    expect(rest.json.chats).toHaveLength(2);
  }, 180_000);
});
