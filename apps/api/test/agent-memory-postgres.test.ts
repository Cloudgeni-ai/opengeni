// An agent's Memory rules, enforced by the tools (real PostgreSQL): its
// shared chats save into its collection; its private chats only read; its
// Slack DMs save no Knowledge at all; with Memory off the collection is not
// read, nothing is saved there and no other chats are listed. App chats
// started with an agent get the same guidance.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SESSION_INSTRUCTIONS_MAX_CHARACTERS, type AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  claimSessionWorkForAttempt,
  createAgent,
  createDb,
  createSession,
  ensureManagedAccessForUserWithOrganizationMemberships,
  initializeSessionStartAtomically,
  saveKnowledgeEntry,
  setAgentMemoryCollection,
  updateAgent,
  type KnowledgeContext,
} from "@opengeni/db";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentChatCreate } from "../src/agent-chats";
import { listSlackAgentChatsForSession } from "../src/integrations/slack-interactions";
import { registerKnowledgeEntryTools } from "../src/mcp/knowledge-entries";

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("agent-memory");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  app = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

const settings = testSettings({ sandboxBackend: "none", mcpServers: [] });

/** A workspace, its person, and a shared agent with Memory on and its collection. */
async function workspaceWithAgent(
  db: ReturnType<typeof createDb>["db"],
  options: { onlyMe?: boolean } = {},
) {
  // An organization member, so their private chats can be created.
  const userId = `agent-memory-${crypto.randomUUID()}`;
  const subjectId = `user:${userId}`;
  const provisioned = await ensureManagedAccessForUserWithOrganizationMemberships(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Agent memory",
  });
  const workspaceId = provisioned.accessContext.defaultWorkspaceId!;
  const grant = provisioned.accessContext.workspaceGrants.find(
    (candidate) => candidate.workspaceId === workspaceId,
  )! as unknown as AccessGrant;
  const home = { accountId: grant.accountId, workspaceId };
  await shared!.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${home.accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'agent-memory-test')
    on conflict do nothing`;
  const human: KnowledgeContext = {
    ...home,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
  const scope = options.onlyMe ? ("personal" as const) : ("workspace" as const);
  const collection = (await saveKnowledgeEntry(db, human, {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    scope,
    entry: {
      kind: "group",
      title: "Release desk",
      content: "Memory of the agent Release desk.",
      groupIds: [],
      evidence: [],
      relationships: [],
    },
  })) as { entryId: string };
  const remembered = (await saveKnowledgeEntry(db, human, {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    scope,
    entry: {
      kind: "fact",
      title: "Release day",
      content: "Releases go out on Tuesdays.",
      groupIds: [collection.entryId],
      evidence: [],
      relationships: [],
    },
  })) as { entryId: string; version: number };
  const { agent } = await createAgent(db, home, {
    visibility: options.onlyMe ? "private" : "workspace",
    ownerSubjectId: options.onlyMe ? subjectId : null,
    name: "Release desk",
    description: "",
    avatar: null,
    instructions: "Keep releases moving.",
    firstMessage: "",
    memoryEnabled: true,
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: subjectId,
  });
  await setAgentMemoryCollection(db, home, { agentId: agent.id, collectionId: collection.entryId });
  return {
    grant,
    home,
    subjectId,
    agentId: agent.id,
    collectionId: collection.entryId,
    remembered,
  };
}

type Fixture = Awaited<ReturnType<typeof workspaceWithAgent>>;

/** A chat with the agent, and a live turn whose tools act for it. */
async function agentChat(
  db: ReturnType<typeof createDb>["db"],
  fixture: Fixture,
  options: { private: boolean; slackDm?: boolean; memoryScope?: "off" },
) {
  const session = await createSession(db, {
    ...fixture.home,
    createdBy: { kind: "subject" as const, subjectId: fixture.subjectId },
    subjectId: fixture.subjectId,
    ...(options.private ? { visibility: "user_private" as const } : {}),
    ...(options.memoryScope ? { memoryScope: options.memoryScope } : {}),
    agent: { id: fixture.agentId },
    initialMessage: "When do releases go out?",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  if (options.slackDm) {
    // A Slack DM: a shared session row, private through its interaction.
    const [connection] = await shared!.admin<Array<{ id: string }>>`
      insert into connections (
        account_id, workspace_id, provider_domain, kind, status, credential_encrypted
      ) values (${fixture.home.accountId}, ${fixture.home.workspaceId}, 'slack.com',
        'app_install', 'active', 'sealed')
      returning id`;
    await shared!.admin`
      insert into slack_interactions (
        account_id, workspace_id, connection_id, slack_team_id, slack_channel_id,
        slack_thread_ts, route_key, triggering_provider_event_id, owning_subject_id,
        visibility, session_reservation_id, session_id
      ) values (
        ${fixture.home.accountId}, ${fixture.home.workspaceId}, ${connection!.id}, 'T1', 'D1',
        '1.1', ${`route-${crypto.randomUUID()}`}, ${`evt-${crypto.randomUUID()}`},
        ${fixture.subjectId}, 'private', ${session.id}, ${session.id}
      )`;
  }
  await initializeSessionStartAtomically(db, {
    ...fixture.home,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, fixture.home.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
    // Claimed as the worker that adds the agent layer does.
    agentInstructionsProtocol: 1,
  });
  if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
  const agentGrant: AccessGrant = {
    ...fixture.grant,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  const server = new McpServer({ name: "agent-memory", version: "1" });
  registerKnowledgeEntryTools(
    server,
    { db, settings } as unknown as ApiRouteDeps,
    agentGrant,
    session.id,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent-memory", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return Object.assign(client, { sessionId: session.id, agentGrant });
}

const saveFact = (title: string, groupIds: string[]) => ({
  name: "knowledge_save",
  arguments: {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    entry: { kind: "fact", title, content: `${title}.`, groupIds, evidence: [], relationships: [] },
  },
});

function errorOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  return (JSON.parse(text) as { error?: { code: string; message: string } }).error ?? null;
}

describe("an agent's Memory (real PostgreSQL)", () => {
  test("shared chats save into the Memory; private chats only read", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const sharedChat = await agentChat(app.db, fixture, { private: false });
    const privateChat = await agentChat(app.db, fixture, { private: true });
    try {
      const saved = await sharedChat.callTool(
        saveFact("Freeze on Fridays", [fixture.collectionId]),
      );
      expect(saved.isError, JSON.stringify(saved.content)).toBeFalsy();

      // A private chat cannot put anything into the Memory others read...
      const refused = await privateChat.callTool(
        saveFact("My salary is confidential", [fixture.collectionId]),
      );
      expect(refused.isError).toBe(true);
      expect(errorOf(refused)).toMatchObject({ code: "agent_memory_read_only" });
      expect(errorOf(refused)!.message).toContain("this chat is private");
      // ...nor change or archive what is already there...
      const archived = await privateChat.callTool({
        name: "knowledge_archive",
        arguments: {
          operationId: crypto.randomUUID(),
          entryId: fixture.remembered.entryId,
          expectedVersion: fixture.remembered.version,
        },
      });
      expect(errorOf(archived)).toMatchObject({ code: "agent_memory_read_only" });
      // ...but saves anything else as usual, and reads the Memory.
      const own = await privateChat.callTool(saveFact("Prefers short answers", []));
      expect(own.isError, JSON.stringify(own.content)).toBeFalsy();
      const read = await privateChat.callTool({
        name: "knowledge_browse",
        arguments: { groupId: fixture.collectionId },
      });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read.content)).toContain("Release day");
    } finally {
      await sharedChat.close();
      await privateChat.close();
    }
  }, 180_000);

  test("a Slack DM reads Memory but saves no Knowledge and is never listed", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const dm = await agentChat(app.db, fixture, { private: false, slackDm: true });
    const sharedChat = await agentChat(app.db, fixture, { private: false });
    try {
      // Its session row is shared, so any save would reach workspace Knowledge.
      for (const groupIds of [[fixture.collectionId], []]) {
        const refused = await dm.callTool(saveFact("My salary is confidential", groupIds));
        expect(refused.isError).toBe(true);
        expect(errorOf(refused)).toMatchObject({ code: "agent_memory_read_only" });
        expect(errorOf(refused)!.message).toContain("private Slack chat");
        expect(errorOf(refused)!.message).not.toContain("save it");
        // The timeline is told it was not saved.
        expect(JSON.stringify(refused._meta ?? {})).toContain("not_permitted");
      }
      // Nor is the DM's own text retained as a source.
      const retained = await dm.callTool({ name: "knowledge_retain_message", arguments: {} });
      expect(errorOf(retained)).toMatchObject({ code: "agent_memory_read_only" });
      const file = await dm.callTool({
        name: "knowledge_retain_file",
        arguments: { fileId: crypto.randomUUID() },
      });
      expect(errorOf(file)).toMatchObject({ code: "agent_memory_read_only" });
      const read = await dm.callTool({
        name: "knowledge_browse",
        arguments: { groupId: fixture.collectionId },
      });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read.content)).toContain("Release day");
      const listed = await listSlackAgentChatsForSession(
        { db: app.db, settings } as unknown as ApiRouteDeps,
        { grant: sharedChat.agentGrant, sessionId: sharedChat.sessionId },
      );
      expect(listed.chats.map((chat) => chat.sessionId)).not.toContain(dm.sessionId);
    } finally {
      await dm.close();
      await sharedChat.close();
    }
  }, 180_000);

  test("an Only me agent: personal Memory, written from its owner's Only me chats", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db, { onlyMe: true });
    // Its chats are Only me; a shared one cannot be bound to it.
    await expect(agentChat(app.db, fixture, { private: false })).rejects.toMatchObject({
      reason: "requires_private_chat",
    });
    const own = await agentChat(app.db, fixture, { private: true });
    try {
      const saved = await own.callTool(saveFact("Prefers mornings", [fixture.collectionId]));
      expect(saved.isError, JSON.stringify(saved.content)).toBeFalsy();
      const [row] = await shared!.admin<{ scope: string }[]>`
        select scope from knowledge_entries
        where id = ${(JSON.parse((saved.content as Array<{ text: string }>)[0]!.text) as { entryId: string }).entryId}`;
      expect(row?.scope).toBe("personal");
      // Shared later (set directly; the transition is not under test): a plain
      // chat, without the agent's Memory or its other chats.
      await shared!.admin.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update sessions set visibility = 'workspace_shared', owner_subject_id = null,
            owner_organization_membership_id = null
          where id = ${own.sessionId}`;
      });
      const unread = await own.callTool({
        name: "knowledge_search",
        arguments: { query: "mornings", groupId: fixture.collectionId },
      });
      expect(errorOf(unread)).toMatchObject({ code: "agent_memory_off" });
      expect(errorOf(unread)!.message).toContain("not its owner's Only me chat");
      const listed = await listSlackAgentChatsForSession(
        { db: app.db, settings } as unknown as ApiRouteDeps,
        { grant: own.agentGrant, sessionId: own.sessionId },
      );
      expect(listed.chats).toEqual([]);
      expect(listed.message).toContain("not its owner's Only me chat");
    } finally {
      await own.close();
    }
  }, 180_000);

  test("an open-use chat (Memory scope off) reads the Memory but never saves to it", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const open = await agentChat(app.db, fixture, { private: false, memoryScope: "off" });
    try {
      const read = await open.callTool({
        name: "knowledge_search",
        arguments: { query: "Release day", groupId: fixture.collectionId },
      });
      expect(read.isError, JSON.stringify(read.content)).toBeFalsy();
      const refused = await open.callTool(saveFact("Open note", [fixture.collectionId]));
      expect(errorOf(refused)).toMatchObject({ code: "agent_memory_read_only" });
    } finally {
      await open.close();
    }
  }, 180_000);

  test("a collection inside the Memory is guarded like the Memory", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const sharedChat = await agentChat(app.db, fixture, { private: false });
    const privateChat = await agentChat(app.db, fixture, { private: true });
    try {
      const nested = await sharedChat.callTool({
        name: "knowledge_save",
        arguments: {
          operationId: crypto.randomUUID(),
          expectedVersion: 0,
          entry: {
            kind: "group",
            title: "Hotfixes",
            content: "Hotfix notes.",
            groupIds: [fixture.collectionId],
            evidence: [],
            relationships: [],
          },
        },
      });
      expect(nested.isError, JSON.stringify(nested.content)).toBeFalsy();
      const nestedId = (
        JSON.parse((nested.content as Array<{ text: string }>)[0]!.text) as { entryId: string }
      ).entryId;
      const refused = await privateChat.callTool(saveFact("A private hotfix", [nestedId]));
      expect(errorOf(refused)).toMatchObject({ code: "agent_memory_read_only" });
    } finally {
      await sharedChat.close();
      await privateChat.close();
    }
  }, 180_000);

  test("Memory off: nothing saved into the collection, no other chats listed", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const first = await agentChat(app.db, fixture, { private: false });
    const second = await agentChat(app.db, fixture, { private: false });
    const deps = { db: app.db, settings } as unknown as ApiRouteDeps;
    try {
      const listed = await listSlackAgentChatsForSession(deps, {
        grant: second.agentGrant,
        sessionId: second.sessionId,
      });
      expect(listed.chats.map((chat) => chat.sessionId)).toContain(first.sessionId);

      const updated = await updateAgent(app.db, fixture.home, {
        agentId: fixture.agentId,
        expectedVersion: null,
        patch: { memoryEnabled: false },
        actorSubjectId: fixture.subjectId,
      });
      expect(updated.kind).toBe("updated");
      const refused = await first.callTool(saveFact("Ship on Mondays", [fixture.collectionId]));
      expect(errorOf(refused)).toMatchObject({ code: "agent_memory_read_only" });
      expect(errorOf(refused)!.message).toContain("Memory is off");
      // Nor is the collection read.
      for (const call of [
        { name: "knowledge_browse", arguments: { groupId: fixture.collectionId } },
        {
          name: "knowledge_search",
          arguments: { query: "release", groupId: fixture.collectionId },
        },
        { name: "knowledge_get", arguments: { entryId: fixture.remembered.entryId } },
      ]) {
        const unread = await first.callTool(call);
        expect(errorOf(unread), call.name).toMatchObject({ code: "agent_memory_off" });
      }
      const none = await listSlackAgentChatsForSession(deps, {
        grant: second.agentGrant,
        sessionId: second.sessionId,
      });
      expect(none.chats).toEqual([]);
      expect(none.message).toContain("Memory is off");
    } finally {
      await first.close();
      await second.close();
    }
  }, 180_000);

  test("private chats are never listed to the agent's other chats", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const privateChat = await agentChat(app.db, fixture, { private: true });
    const sharedChat = await agentChat(app.db, fixture, { private: false });
    try {
      const listed = await listSlackAgentChatsForSession(
        { db: app.db, settings } as unknown as ApiRouteDeps,
        { grant: sharedChat.agentGrant, sessionId: sharedChat.sessionId },
      );
      expect(listed.chats.map((chat) => chat.sessionId)).not.toContain(privateChat.sessionId);
    } finally {
      await privateChat.close();
      await sharedChat.close();
    }
  }, 180_000);

  test("an app chat started with the agent is told about its Memory", async () => {
    if (!app) return;
    const fixture = await workspaceWithAgent(app.db);
    const deps = { db: app.db, settings } as unknown as ApiRouteDeps;
    const sharedPayload: Record<string, unknown> = {
      agentId: fixture.agentId,
      initialMessage: "Hi",
      instructions: "Answer in English.",
    };
    expect(
      await prepareAgentChatCreate(deps, fixture.grant, fixture.home.workspaceId, sharedPayload),
    ).toEqual({ firstPartyMcpToolAdditions: ["slack_agent_chats"] });
    expect(sharedPayload["instructions"]).toStartWith("Answer in English.\n\n");
    expect(sharedPayload["instructions"]).toContain(`groupIds [${fixture.collectionId}]`);

    const privatePayload: Record<string, unknown> = {
      agentId: fixture.agentId,
      visibility: "private",
    };
    await prepareAgentChatCreate(deps, fixture.grant, fixture.home.workspaceId, privatePayload);
    expect(privatePayload["instructions"]).toContain("never save anything from it");

    // Instructions that leave no room keep their text; the guidance is left out.
    const long = "x".repeat(SESSION_INSTRUCTIONS_MAX_CHARACTERS - 10);
    const full: Record<string, unknown> = { agentId: fixture.agentId, instructions: long };
    await prepareAgentChatCreate(deps, fixture.grant, fixture.home.workspaceId, full);
    expect(full["instructions"]).toBe(long);

    // No agent, or Memory off: nothing added.
    const plain: Record<string, unknown> = { initialMessage: "Hi" };
    expect(
      await prepareAgentChatCreate(deps, fixture.grant, fixture.home.workspaceId, plain),
    ).toBeUndefined();
    await updateAgent(app.db, fixture.home, {
      agentId: fixture.agentId,
      expectedVersion: null,
      patch: { memoryEnabled: false },
      actorSubjectId: fixture.subjectId,
    });
    const off: Record<string, unknown> = { agentId: fixture.agentId };
    expect(
      await prepareAgentChatCreate(deps, fixture.grant, fixture.home.workspaceId, off),
    ).toBeUndefined();
    expect(off["instructions"]).toBeUndefined();
  }, 180_000);
});
