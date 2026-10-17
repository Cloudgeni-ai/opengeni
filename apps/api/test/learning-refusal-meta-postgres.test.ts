import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessGrant } from "@opengeni/contracts";
import { LEARNING_REFUSAL_META_KEY } from "@opengeni/contracts/learning-refusal";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getAgentLearningSettings,
  initializeSessionStartAtomically,
  saveAgentLearningSettings,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps } from "@opengeni/core";
import { registerKnowledgeEntryTools } from "../src/mcp/knowledge-entries";

// A workspace instruction an agent saves from a chat that learns for its person
// is governed by the stricter of the chat's and the workspace's Instructions
// mode. A refusal carries a content-free `_meta` fact the model never sees, so
// the timeline tells the person it was not saved.
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("learning-refusal-meta");
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

type Mode = "automatic" | "review_first" | "off";

async function liveAgent(
  db: ReturnType<typeof createDb>["db"],
  learning: "personal" | "workspace",
  modes: { personal?: Mode; workspace?: Mode } = {},
) {
  const suffix = crypto.randomUUID();
  const subjectId = `user:learning-refusal-${suffix}`;
  const grant = (
    await bootstrapWorkspace(db, {
      accountExternalSource: "learning-refusal-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "learning-refusal-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const accountId = grant.accountId;
  const workspaceId = grant.workspaceId!;
  const human: KnowledgeContext = {
    accountId,
    workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId,
      writeScopes: ["workspace", "personal"],
      settingsScopes: ["workspace", "personal"],
      review: true,
    },
  };
  // Settings saved before the chat's turn is accepted govern that turn.
  for (const scope of ["workspace", "personal"] as const) {
    const instructions = modes[scope];
    if (!instructions) continue;
    const current = await getAgentLearningSettings(db, human, scope);
    await saveAgentLearningSettings(db, human, {
      scope,
      operationId: crypto.randomUUID(),
      expectedVersion: current.version,
      settings: { knowledge: "automatic", instructions, skills: "review_first" },
    });
  }
  const session = await createSession(db, {
    accountId,
    workspaceId,
    // A chat using personal memory saves what it learns only for its person,
    // like a private chat.
    ...(learning === "personal" ? { memoryScope: "user" as const } : {}),
    createdBy: { kind: "subject" as const, subjectId },
    initialMessage: "Always remember this rule",
    resources: [],
    metadata: {},
    model: "scripted",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(db, {
    accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: suffix,
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
  const agentGrant: AccessGrant = {
    ...grant,
    principalKind: "agent_attempt",
    metadata: {
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
      executionGeneration: claim.turn.executionGeneration,
    },
  };
  const server = new McpServer({ name: "learning-refusal", version: "1" });
  registerKnowledgeEntryTools(
    server,
    {
      db,
      settings: testSettings({ sandboxBackend: "none", mcpServers: [] }),
    } as unknown as ApiRouteDeps,
    agentGrant,
    session.id,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "learning-refusal", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const appendRule = () => ({
  name: "instruction_policy_save",
  arguments: {
    operationId: crypto.randomUUID(),
    target: { kind: "policy", scope: "global", roleKey: null },
    editMode: "append",
    content: "Always pick the smaller model for grunt work.",
    expectedCurrentRevisionId: null,
    expectedActivationVersion: 0,
    reason: "The person asked to always remember it",
  },
});

describe("learning refusal facts", () => {
  test("a workspace instruction from a chat that learns for its person waits for workspace review", async () => {
    if (!app || !shared) return;
    const client = await liveAgent(app.db, "personal", {
      personal: "automatic",
      workspace: "review_first",
    });
    try {
      const result = await client.callTool(appendRule());
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(JSON.stringify(result)).toMatch(/outcome[^a-z]*pending/);
      expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 120_000);

  test("a workspace instruction from a chat that learns for its person publishes when both modes are Automatic", async () => {
    if (!app || !shared) return;
    const client = await liveAgent(app.db, "personal", {
      personal: "automatic",
      workspace: "automatic",
    });
    try {
      const result = await client.callTool(appendRule());
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(JSON.stringify(result)).toMatch(/outcome[^a-z]*published/);
    } finally {
      await client.close();
    }
  }, 120_000);

  test("the workspace's Off refuses an instruction from a chat that learns for its person", async () => {
    if (!app || !shared) return;
    const client = await liveAgent(app.db, "personal", { personal: "automatic", workspace: "off" });
    try {
      const result = await client.callTool(appendRule());
      expect(result.isError).toBe(true);
      expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toEqual({
        destination: "instruction",
        reason: "learning_off",
      });
    } finally {
      await client.close();
    }
  }, 120_000);

  test("a saved instruction carries no refusal fact", async () => {
    if (!app || !shared) return;
    const client = await liveAgent(app.db, "workspace");
    try {
      const result = await client.callTool(appendRule());
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(result._meta?.[LEARNING_REFUSAL_META_KEY]).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 120_000);
});
