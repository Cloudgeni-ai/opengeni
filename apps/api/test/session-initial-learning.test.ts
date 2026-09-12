import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createSessionForRequestWithOutcome,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  freezeAgentLearningPolicy,
  getAgentLearningSettings,
  saveAgentLearningSettings,
  type KnowledgeContext,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const database = await acquireSharedTestDatabase("session-initial-learning");
  if (!database) throw new Error("Initial chat learning verification requires PostgreSQL");
  shared = database;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

test.each([false, true])(
  "chat overrides are committed before its first accepted run (personal=%s)",
  async (personal) => {
    const id = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: id,
      accountName: "Initial learning",
      workspaceExternalSource: "test",
      workspaceExternalId: id,
      workspaceName: "Workspace",
      subjectId: `user:${id}`,
    });
    const grant = { ...access.workspaceGrants[0]!, principalKind: "human_session" as const };
    const authorization = {
      grant,
      authenticatedSubjectId: grant.subjectId,
      contextIntegrity: true,
      canonicalManagedHumanSession: true,
    } as AccessGrantAuthorization;
    const noop = async () => undefined;
    const deps = {
      db: client.db,
      settings: testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" }),
      bus: new MemoryEventBus(),
      workflowClient: {
        wakeSessionWorkflow: noop,
        requestSessionWorkflowWakeDispatch: noop,
        signalUserMessage: noop,
      },
      objectStorage: null,
      githubStateSecret: "test",
      documentIndexer: { indexDocument: noop },
      getDocumentServices: () => ({}),
    } as unknown as ApiRouteDeps;
    const request = {
      initialMessage: "Read this source and retain useful information",
      idempotencyKey: `learning-${id}`,
      ...(personal ? { memoryScope: "user" } : {}),
      agentLearning: { knowledge: "review_first", skills: "off" },
    };
    const outcome = await createSessionForRequestWithOutcome(
      deps,
      grant,
      grant.workspaceId,
      request,
      authorization,
    );
    const session = outcome.session;
    const context: KnowledgeContext = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "human",
        principalKind: "human_session",
        subjectId: grant.subjectId,
        writeScopes: [],
        settingsScopes: [personal ? "personal" : "workspace"],
        review: false,
      },
    };
    const policy = await getAgentLearningSettings(
      client.db,
      context,
      personal ? "personal" : "workspace",
      { kind: "chat", id: session.id },
    );
    expect(policy.settings).toEqual({ knowledge: "review_first", skills: "off" });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: session.temporalWorkflowId!,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error(JSON.stringify(claim));
    const frozen = await freezeAgentLearningPolicy(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      actor: {
        kind: "agent",
        sessionId: session.id,
        turnId: claim.turn.id,
        attemptId,
        executionGeneration: claim.turn.executionGeneration,
      },
    });
    expect(frozen.effective.knowledge).toBe("review_first");
    expect(frozen.effective.skills).toBe("off");
    expect(frozen.defaultScope).toBe(personal ? "personal" : "workspace");
    // Later settings are independent of the immutable creation identity: replay
    // must neither reset them nor accept a different initial policy.
    const updated = await saveAgentLearningSettings(client.db, context, {
      scope: personal ? "personal" : "workspace",
      source: { kind: "chat", id: session.id },
      operationId: crypto.randomUUID(),
      expectedVersion: policy.version,
      settings: { knowledge: "automatic" },
    });
    for (const agentLearning of [undefined, { knowledge: "automatic" }]) {
      await expect(
        createSessionForRequestWithOutcome(
          deps,
          grant,
          grant.workspaceId,
          { ...request, agentLearning },
          authorization,
        ),
      ).rejects.toMatchObject({ status: 409 });
    }
    const replay = await createSessionForRequestWithOutcome(
      deps,
      grant,
      grant.workspaceId,
      request,
      authorization,
    );
    expect(replay.session.id).toBe(session.id);
    expect(
      (
        await getAgentLearningSettings(client.db, context, personal ? "personal" : "workspace", {
          kind: "chat",
          id: session.id,
        })
      ).version,
    ).toBe(updated.version);
  },
);
