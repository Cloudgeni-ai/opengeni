import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import { OpenAIResponsesModel, tool, type Model } from "@openai/agents";
import type { ResolvedModelProvider } from "@opengeni/config";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { assistantMessage, functionCall, ScriptedModel } from "@opengeni/testing/scripted-model";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import OpenAI from "openai";
import { createActivityTestHarness } from "../src/activities";
import {
  INPUT_WAIT_REPLY_REFUSAL,
  latestDurableTurnMessageText,
} from "../src/activities/agent-turn/input-wait-reply";
import { AnthropicMessagesModel } from "../../../packages/runtime/src/anthropic-messages";

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

type ClaudeBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const claudeProvider: ResolvedModelProvider = {
  id: "claude",
  label: "Claude",
  kind: "api-key",
  api: "anthropic-messages",
  wireProfile: "openai",
  builtin: false,
  baseUrl: "https://api.anthropic.com/v1",
  apiKey: "test-key",
  credentialSource: { kind: "deployment", mechanism: "api_key" },
  billing: { upstreamPayer: "deployment", metering: "external" },
};

/** One Claude Messages stream; each content block streams in one delta. */
function claudeStream(id: string, blocks: ClaudeBlock[]): Response {
  const frames: unknown[] = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      frames.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        },
      );
    } else if (block.type === "text") {
      frames.push(
        { type: "content_block_start", index, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
      );
    } else {
      frames.push(
        { type: "content_block_start", index, content_block: { ...block, input: {} } },
        {
          type: "content_block_delta",
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        },
      );
    }
    frames.push({ type: "content_block_stop", index });
  });
  frames.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
      },
      usage: { output_tokens: 20 },
    },
    { type: "message_stop" },
  );
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": `req_${id}` },
  });
}

/**
 * Claude Opus 5.5 behind the real Messages transport, answering each request
 * with the next scripted response (`msg_1`, `msg_2`, ...).
 */
function scriptedClaude(responses: ClaudeBlock[][]) {
  let calls = 0;
  const model = new AnthropicMessagesModel(claudeProvider, "claude-opus-5-5", (async () => {
    const blocks = responses[calls];
    calls += 1;
    if (!blocks) throw new Error("a yielded wait must not reach another inference");
    return claudeStream(`msg_${calls}`, blocks);
  }) as typeof fetch);
  return { model, calls: () => calls };
}

// Under display "updates" reasoning comes back empty and a progress update
// carries Anthropic's summary, not the model's words. These are the shapes of
// the production responses whose summaries were shown as the agent's reply.
const emptyReasoning: ClaudeBlock = { type: "thinking", thinking: "", signature: "sig_reasoning" };
const FABRICATED =
  "Both workers are running now. I've explained how subagents currently choose between asking you or the parent and proposed a rule.\n\n";
const progressSummary: ClaudeBlock = {
  type: "thinking",
  thinking: FABRICATED,
  signature: "sig_progress",
};
const waitCall = (id: string): ClaudeBlock => ({
  type: "tool_use",
  id,
  name: "wait_for_input",
  input: {},
});

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

  async function runTurn(
    model: Model,
    api: "chat" | "responses",
    options: { waitForInputTool?: boolean; createdBy?: "human" | "agent" } = {},
  ) {
    const suffix = crypto.randomUUID();
    const human = `subject-${suffix}`;
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `account-${suffix}`,
      accountName: "Assistant message events",
      workspaceExternalSource: "test",
      workspaceExternalId: `workspace-${suffix}`,
      workspaceName: "Assistant message events",
      subjectId: human,
    });
    const grant = access.workspaceGrants[0]!;
    const sessionDefaults = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Is the deploy healthy?",
      resources: [],
      metadata: {},
      createdBy: { kind: "subject" as const, subjectId: human },
      model: "scripted-model",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sandboxBackend: "none" as const,
    };
    let session = await createSession(client.db, sessionDefaults);
    if (options.createdBy === "agent") {
      // The human's session is running a turn whose agent spawns a child: the
      // child's first turn is the agent's task prompt, not a human message.
      await initializeSessionStartAtomically(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        sessionId: session.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
        goal: null,
      });
      const parentAttemptId = crypto.randomUUID();
      const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId!, {
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: parentAttemptId,
        dispatchId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      if (claimed.action !== "claimed") throw new Error("parent turn was not claimed");
      session = await createSession(client.db, {
        ...sessionDefaults,
        initialMessage: "Report the deploy status, then wait for the rollout.",
        parentSessionId: session.id,
        createdByActor: {
          type: "agent_attempt",
          sessionId: session.id,
          turnId: claimed.turn.id,
          attemptId: parentAttemptId,
          executionGeneration: claimed.turn.executionGeneration,
        },
      });
    }
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
      // The first-party wait_for_input tool lives behind the MCP gateway; a
      // local tool accepts the wait through the same attempt gate.
      buildAgent: (agentSettings, resources, agentOptions) => {
        const agent = productionRuntime.buildAgent(agentSettings, resources, agentOptions);
        if (options.waitForInputTool) {
          agent.tools.push(
            tool({
              name: "wait_for_input",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              strict: false,
              execute: async () => {
                // Same admission order as the first-party MCP wrapper.
                const refusal = await agentOptions?.inputWaitYield?.replyRefusal();
                if (refusal) return { isError: true, error: refusal };
                agentOptions?.inputWaitYield?.beginWait()(true);
                return { status: "waiting_for_input" };
              },
            }),
          );
        }
        return agent;
      },
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

  test("a status answer before the turn waits for input is recorded as the reply", async () => {
    const status = "Two of the ten reviews are done; the rest are still running.";
    const events = await runTurn(
      new ScriptedModel([
        {
          output: [
            { ...assistantMessage(status, "msg_status"), phase: "commentary" },
            functionCall("wait_for_input", {}, "call_wait"),
          ] as never,
        },
        { error: new Error("a yielded wait must not reach another inference") },
      ]),
      "chat",
      { waitForInputTool: true },
    );
    expect(
      events
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload),
    ).toEqual([{ text: status, messageId: "msg_status", phase: "commentary" }]);
    // The wait leaves the output empty; the reply to the human's message rides
    // beside it. Stored history keeps the provider's commentary phase.
    expect(events.find((event) => event.type === "turn.completed")?.payload).toEqual({
      output: "",
      reply: status,
    });
    // An activity that later resumes this turn without a message of its own
    // (after an approval or a recovery) reads the same answer back.
    const completed = events.find((event) => event.type === "turn.completed")!;
    const scope = { workspaceId: completed.workspaceId, sessionId: completed.sessionId };
    expect(
      await latestDurableTurnMessageText(client.db, { ...scope, turnId: completed.turnId! }),
    ).toBe(status);
    expect(
      await latestDurableTurnMessageText(client.db, { ...scope, turnId: crypto.randomUUID() }),
    ).toBeNull();
  }, 60_000);

  test("a person's turn that waits before any visible reply is sent back to answer first", async () => {
    const status = "Four more pieces merged overnight; the worker is on the next one.";
    const model = new ScriptedModel([
      // The status drafted only in reasoning: the wait alone would end the turn silently.
      { output: [functionCall("wait_for_input", {}, "call_silent_wait")] as never },
      {
        output: [
          { ...assistantMessage(status, "msg_status"), phase: "commentary" },
          functionCall("wait_for_input", {}, "call_wait"),
        ] as never,
      },
      { error: new Error("a yielded wait must not reach another inference") },
    ]);
    const events = await runTurn(model, "chat", { waitForInputTool: true });
    expect(model.calls).toBe(2);
    const outputs = events.filter((event) => event.type === "agent.toolCall.output");
    expect(JSON.stringify(outputs[0]?.payload)).toContain(INPUT_WAIT_REPLY_REFUSAL);
    expect(
      events
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload),
    ).toEqual([{ text: status, messageId: "msg_status", phase: "commentary" }]);
    expect(events.find((event) => event.type === "turn.completed")?.payload).toEqual({
      output: "",
      reply: status,
    });
  }, 60_000);

  test("an agent-spawned child's first turn that waits for input records no reply", async () => {
    const status = "The rollout is at 40 percent; waiting for it to finish.";
    const events = await runTurn(
      new ScriptedModel([
        {
          output: [
            { ...assistantMessage(status, "msg_status"), phase: "commentary" },
            functionCall("wait_for_input", {}, "call_wait"),
          ] as never,
        },
        { error: new Error("a yielded wait must not reach another inference") },
      ]),
      "chat",
      { waitForInputTool: true, createdBy: "agent" },
    );
    // The turn's source is still `user`, but no human asked: the note stays
    // activity and the wait records only its empty output.
    expect(
      events
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload),
    ).toEqual([{ text: status, messageId: "msg_status", phase: "commentary" }]);
    expect(events.find((event) => event.type === "turn.completed")?.payload).toEqual({
      output: "",
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

  describe("Claude progress-update summaries are never the agent's reply", () => {
    const messageEvents = (events: Awaited<ReturnType<typeof runTurn>>) =>
      events.filter((event) => event.type.startsWith("agent.message."));
    const completedMessages = (events: Awaited<ReturnType<typeof runTurn>>) =>
      events
        .filter((event) => event.type === "agent.message.completed")
        .map((event) => event.payload);
    const turnCompleted = (events: Awaited<ReturnType<typeof runTurn>>) =>
      events.find((event) => event.type === "turn.completed")?.payload;

    test("no text: the summary is not recorded and the model is asked to write its reply", async () => {
      const reply = "Sub-agents can ask you through a question form, or ask their parent.";
      const claude = scriptedClaude([
        [emptyReasoning, progressSummary, waitCall("toolu_wait_1")],
        [emptyReasoning, { type: "text", text: reply }, waitCall("toolu_wait_2")],
      ]);
      const events = await runTurn(claude.model, "chat", { waitForInputTool: true });
      expect(claude.calls()).toBe(2);
      const outputs = events.filter((event) => event.type === "agent.toolCall.output");
      expect(JSON.stringify(outputs[0]?.payload)).toContain(INPUT_WAIT_REPLY_REFUSAL);
      expect(completedMessages(events)).toEqual([
        { text: reply, messageId: "msg_2:1", phase: "commentary" },
      ]);
      expect(JSON.stringify(messageEvents(events))).not.toContain("I've explained");
      expect(turnCompleted(events)).toEqual({ output: "", reply });
    }, 60_000);

    test("no text ever: nothing is invented and the turn records no reply", async () => {
      const claude = scriptedClaude([
        [emptyReasoning, progressSummary, waitCall("toolu_wait_1")],
        [emptyReasoning, progressSummary, waitCall("toolu_wait_2")],
        [emptyReasoning, progressSummary, waitCall("toolu_wait_3")],
      ]);
      const events = await runTurn(claude.model, "chat", { waitForInputTool: true });
      // Two refusals, then the wait proceeds rather than looping.
      expect(claude.calls()).toBe(3);
      expect(messageEvents(events)).toEqual([]);
      expect(turnCompleted(events)).toEqual({ output: "" });
    }, 60_000);

    test("long text: the model's full answer is the reply, never the summary beside it", async () => {
      const answer = [
        "Those messages were not written by me.",
        "",
        "**Your question: can a sub-agent choose who answers?** Yes, it has two options:",
        "",
        "- **Ask a person.** It shows a question form, which you get in the inbox.",
        "- **Ask its parent agent.** It sends the parent a message.",
        "",
        "What's missing is a rule for when to use which. ".repeat(40).trim(),
        "",
        "Want me to add that rule as a separate change?",
      ].join("\n");
      const claude = scriptedClaude([
        [emptyReasoning, { type: "text", text: answer }, progressSummary, waitCall("toolu_wait")],
      ]);
      const events = await runTurn(claude.model, "chat", { waitForInputTool: true });
      expect(claude.calls()).toBe(1);
      expect(completedMessages(events)).toEqual([
        { text: answer, messageId: "msg_1:1", phase: "commentary" },
      ]);
      expect(JSON.stringify(messageEvents(events))).not.toContain("I've explained");
      expect(turnCompleted(events)).toEqual({ output: "", reply: answer });
    }, 60_000);

    test("normal text: the model's reply is recorded exactly as written", async () => {
      const status = "Both workers are running; I'll report back when they finish.";
      const claude = scriptedClaude([
        [emptyReasoning, { type: "text", text: status }, waitCall("toolu_wait")],
      ]);
      const events = await runTurn(claude.model, "chat", { waitForInputTool: true });
      expect(claude.calls()).toBe(1);
      expect(completedMessages(events)).toEqual([
        { text: status, messageId: "msg_1:1", phase: "commentary" },
      ]);
      expect(turnCompleted(events)).toEqual({ output: "", reply: status });
    }, 60_000);
  });
});
