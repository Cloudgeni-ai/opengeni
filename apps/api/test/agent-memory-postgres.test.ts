// An agent's Memory rules, enforced by the tools (real PostgreSQL): its
// shared chats save into its collection; its private chats (Slack DMs
// included) only read; with Memory off nothing is saved there and no other
// chats are listed. App chats started with an agent get the same guidance.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
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
async function workspaceWithAgent(db: ReturnType<typeof createDb>["db"]) {
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
  const collection = (await saveKnowledgeEntry(db, human, {
    operationId: crypto.randomUUID(),
    expectedVersion: 0,
    scope: "workspace",
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
    scope: "workspace",
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
    visibility: "workspace",
    ownerSubjectId: null,
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
  options: { private: boolean },
) {
  const session = await createSession(db, {
    ...fixture.home,
    createdBy: { kind: "subject" as const, subjectId: fixture.subjectId },
    subjectId: fixture.subjectId,
    ...(options.private ? { visibility: "user_private" as const } : {}),
    agent: { id: fixture.agentId },
    initialMessage: "When do releases go out?",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
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
