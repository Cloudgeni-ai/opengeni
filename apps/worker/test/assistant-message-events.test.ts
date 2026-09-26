import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";

describe("assistant message events from a real agent turn", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("assistant-message-events");
    if (!acquired) throw new Error("PostgreSQL test database unavailable");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  test("each message completes once with its phase and the final is not copied at settlement", async () => {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Assistant message events",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Assistant message events",
      subjectId: `subject-${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Is the deploy healthy?",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      reasoningEffortFallback: "medium",
      createdEventPayload: {},
      goal: null,
    });

    const answer = "The deploy is healthy.";
    const scriptedModel = new ScriptedModel([
      {
        output: [
          { ...assistantMessage("Checking the deploy.", "msg_note"), phase: "commentary" },
          { ...assistantMessage(answer, "msg_answer"), phase: "final_answer" },
        ] as never,
      },
    ]);
    const productionRuntime = createProductionAgentRuntime({ model: scriptedModel });
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Test chat",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
        client: {} as never,
        model: scriptedModel,
        configured: {
          id: "scripted-model",
          label: "Scripted model",
          providerId: "test-chat",
          providerLabel: "Test chat",
          api: "chat",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactTokenLimit: 225_000,
          reasoningEffort: false,
          hostedWebSearch: false,
        },
      }),
    };
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
    });

    const attemptId = crypto.randomUUID();
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    expect(result).toMatchObject({ status: "idle", attemptId });
    if (result.status === "unclaimed") throw new Error("User turn was not claimed");

    const events = (
      await listSessionEvents(client.db, grant.workspaceId!, session.id, { after: 0, limit: 200 })
    ).filter((event) => event.turnId === result.turnId);
    expect(
      events
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload),
    ).toEqual([
      { text: "Checking the deploy.", messageId: "msg_note", phase: "commentary" },
      { text: answer, messageId: "msg_answer", phase: "final_answer" },
    ]);
    const types = events.map((event) => event.type);
    expect(types.lastIndexOf("agent.message.completed")).toBeLessThan(
      types.indexOf("turn.completed"),
    );
    expect(events.find((event) => event.type === "turn.completed")?.payload).toEqual({
      output: answer,
    });
  }, 60_000);
});
