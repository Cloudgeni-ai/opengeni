import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { OpenAIResponsesModel, type Model } from "@openai/agents";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import OpenAI from "openai";
import { createActivityTestHarness } from "../src/activities";

/** One Responses API stream: each message is announced, streamed, then done. */
function responsesStream(
  messages: Array<{ id: string; phase: "commentary" | "final_answer"; chunks: string[] }>,
): string {
  const item = (id: string, phase: string, text: string | null) => ({
    type: "message",
    id,
    role: "assistant",
    status: text === null ? "in_progress" : "completed",
    phase,
    content: text === null ? [] : [{ type: "output_text", text, annotations: [], logprobs: [] }],
  });
  const events: unknown[] = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
  ];
  const output: unknown[] = [];
  messages.forEach((message, outputIndex) => {
    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: item(message.id, message.phase, null),
    });
    for (const delta of message.chunks) {
      events.push({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      });
    }
    const done = item(message.id, message.phase, message.chunks.join(""));
    output.push(done);
    events.push({ type: "response.output_item.done", output_index: outputIndex, item: done });
  });
  events.push({
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

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

  async function runTurn(model: Model, api: "chat" | "responses") {
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

    const settings = testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: api === "chat" ? "scripted-model" : "gpt-5.6-sol",
      sandboxBackend: "none",
    });
    const productionRuntime = createProductionAgentRuntime({ model });
    // A Responses turn keeps the catalogue's real provider and capabilities;
    // only the transport behind the model is local.
    const catalogued =
      api === "responses" ? productionRuntime.resolveTurnModel(settings, "gpt-5.6-sol") : null;
    const runtime: OpenGeniRuntime = {
      ...productionRuntime,
      configure: () => undefined,
      resolveTurnModel: () =>
        catalogued
          ? { ...catalogued, model }
          : {
              provider: {
                id: "test-chat",
                label: "Test chat",
                kind: "api-key",
                api: "chat",
                builtin: false,
              },
              client: {} as never,
              model,
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
            },
    };
    const activities = createActivityTestHarness({
      settings,
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
    return (
      await listSessionEvents(client.db, grant.workspaceId!, session.id, { after: 0, limit: 200 })
    ).filter((event) => event.turnId === result.turnId);
  }

  test("each message completes once with its phase and the final is not copied at settlement", async () => {
    const answer = "The deploy is healthy.";
    const events = await runTurn(
      new ScriptedModel([
        {
          output: [
            { ...assistantMessage("Checking the deploy.", "msg_note"), phase: "commentary" },
            { ...assistantMessage(answer, "msg_answer"), phase: "final_answer" },
          ] as never,
        },
      ]),
      "chat",
    );
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

  test("a Responses message is durable before the next message of its response streams", async () => {
    const answer = "The deploy is healthy.";
    const openai = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://responses.example.test/v1",
      maxRetries: 0,
      fetch: async () =>
        new Response(
          responsesStream([
            { id: "msg_note", phase: "commentary", chunks: ["Checking ", "the deploy."] },
            { id: "msg_answer", phase: "final_answer", chunks: ["The deploy ", "is healthy."] },
          ]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });
    const events = await runTurn(new OpenAIResponsesModel(openai, "gpt-5.6-sol"), "responses");
    const messageEvents = events
      .filter((event) => event.type.startsWith("agent.message."))
      .map((event) => {
        const payload = event.payload as { messageId?: string; phase?: string };
        return `${event.type}:${payload.messageId}:${payload.phase}`;
      });
    // Deltas may coalesce; what matters is that each message completes right
    // after its own text and exactly once.
    expect([...new Set(messageEvents)]).toEqual([
      "agent.message.delta:msg_note:commentary",
      "agent.message.completed:msg_note:commentary",
      "agent.message.delta:msg_answer:final_answer",
      "agent.message.completed:msg_answer:final_answer",
    ]);
    expect(messageEvents.filter((entry) => entry.startsWith("agent.message.completed"))).toEqual([
      "agent.message.completed:msg_note:commentary",
      "agent.message.completed:msg_answer:final_answer",
    ]);
    expect(events.find((event) => event.type === "turn.completed")?.payload).toEqual({
      output: answer,
    });
  }, 60_000);
});
