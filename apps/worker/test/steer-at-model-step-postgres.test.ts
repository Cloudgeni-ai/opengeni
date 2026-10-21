import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  tool,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import * as opengeniDb from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  MemoryEventBus,
  testSettings,
  ScriptedModel,
  functionCall,
  assistantMessage,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
  listSessionEvents,
  steerQueuedTurnInTransaction,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import {
  createProductionAgentRuntime,
  isModelPreempted,
  preemptedResponseDone,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// A Steer to a busy chat is read at the running turn's next model-step
// boundary: the current step's tool calls finish, nothing in flight is cut
// off, and the Steer runs next on the same history. A queued Send keeps its
// meaning and waits for the whole turn. Real worker turn path, real
// PostgreSQL in the production RLS posture, and the real SDK call flow with an
// offline ScriptedModel. No provider, network or paid model.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("steer-at-model-step");
  if (!acquired) throw new Error("Native PostgreSQL required for Steer at model step tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:steer-at-model-step:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "steer-at-model-step",
    accountExternalId: crypto.randomUUID(),
    accountName: "Steer at model step",
    workspaceExternalSource: "steer-at-model-step",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Steer at model step",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
}
type Ctx = Awaited<ReturnType<typeof fixture>>;

async function startSession(ctx: Ctx) {
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: "Work through the long task",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "medium",
    createdEventPayload: {},
    goal: null,
  });
  return session;
}

async function send(
  ctx: Ctx,
  sessionId: string,
  text: string,
  delivery: "send" | "steer" = "send",
) {
  return await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId,
        subjectId: ctx.subjectId,
        actor: { type: "human", subjectId: ctx.subjectId },
        operationKey: crypto.randomUUID(),
        delivery,
        text,
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
}

/** Offline runtime: the production SDK call flow over a ScriptedModel plus one local tool. */
function scriptedRuntime(scripted: Model, onTool: () => Promise<void>): OpenGeniRuntime {
  const production = createProductionAgentRuntime({ model: scripted });
  return {
    ...production,
    configure: () => {},
    resolveTurnModel: () => ({
      provider: { id: "test-chat", label: "Offline", kind: "api-key", api: "chat", builtin: false },
      client: {} as NonNullable<ReturnType<OpenGeniRuntime["resolveTurnModel"]>>["client"],
      model: scripted,
      configured: {
        id: "scripted-model",
        label: "Offline",
        providerId: "test-chat",
        providerLabel: "Offline",
        api: "chat",
        contextWindowTokens: 250_000,
        effectiveContextWindowTokens: 250_000,
        autoCompactTokenLimit: 225_000,
        reasoningEffort: false,
        hostedWebSearch: false,
      },
    }),
    buildAgent: (...args) => {
      const agent = production.buildAgent(...args);
      agent.tools.push(
        tool({
          name: "local_fixture",
          description: "Offline step of the long task",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => {
            await onTool();
            // The tool keeps working after the Steer is admitted: a Steer
            // never cuts off a call in progress.
            await Bun.sleep(50);
            return "step done";
          },
        }),
      );
      return agent;
    },
  };
}

async function runTurn(
  ctx: Ctx,
  sessionId: string,
  runtime: OpenGeniRuntime,
  bus = new MemoryEventBus(),
) {
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    }),
    db: app.db,
    bus,
    runtime,
  });
  return await activities.runAgentTurn({
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
}

async function events(ctx: Ctx, sessionId: string) {
  return await listSessionEvents(app.db, ctx.workspaceId, sessionId, { after: 0, limit: 500 });
}

async function turns(sessionId: string) {
  return await shared.admin<Array<{ id: string; status: string; source: string; prompt: string }>>`
    select id, status, source, prompt from session_turns
     where session_id = ${sessionId} order by created_at`;
}

async function interruptionCount(sessionId: string) {
  const [row] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from session_attempt_interruptions
     where session_id = ${sessionId}`;
  return row?.count ?? 0;
}

function historyShape(rows: Array<{ item: unknown }>) {
  return rows.flatMap((row) => {
    const item = row.item as {
      type?: string;
      role?: string;
      content?: unknown;
      name?: string;
    };
    // Session context (system/developer messages) is not conversation.
    if (item.role === "system" || item.role === "developer") return [];
    const text = JSON.stringify(item.content ?? "");
    if (item.role === "user") {
      return [
        text.includes("What is the status?")
          ? "user:status"
          : text.includes("Also keep notes")
            ? "user:notes"
            : text.includes("Work through the long task")
              ? "user:task"
              : "user:other",
      ];
    }
    if (item.type === "function_call") return [`call:${item.name}`];
    if (item.type === "function_call_result") return ["result"];
    if (item.role === "assistant") return ["assistant"];
    return [`${item.type ?? "item"}:${item.role ?? "none"}`];
  });
}

test("a Steer sent while a tool runs is read before the next model request, and the tool finishes", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let steered = false;
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    // Without the boundary handover the running turn would spend this
    // response (and every later step) before the Steer is read.
    { id: `answer-${session.id}`, output: [assistantMessage("Status: step one is done.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (steered) return;
    steered = true;
    // The person steers while the tool step runs.
    const accepted = await send(ctx, session.id, "What is the status?", "steer");
    // The live attempt is not interrupted; nothing is stopping.
    expect(accepted.interruptionCount).toBe(0);
  });

  const first = await runTurn(ctx, session.id, runtime);
  expect(first.status).toBe("idle");
  // The running turn handed over before its second model request.
  expect(scripted.calls).toBe(1);
  expect(await interruptionCount(session.id)).toBe(0);
  const afterFirst = await events(ctx, session.id);
  const requested = afterFirst.filter((event) => event.type === "session.control.steer_requested");
  expect(requested).toHaveLength(1);
  expect(requested[0]!.payload).toMatchObject({ stopping: false, deferredUntilModelStep: true });
  const superseded = afterFirst.filter((event) => event.type === "turn.superseded");
  expect(superseded).toHaveLength(1);
  expect(superseded[0]!.payload).toMatchObject({ reason: "steer", atModelStep: true });
  expect(afterFirst.some((event) => event.type === "turn.failed")).toBe(false);
  // The tool call in flight was not cut off: its real output was recorded.
  const output = afterFirst.find(
    (event) =>
      event.type === "agent.toolCall.output" && JSON.stringify(event.payload).includes("call-1"),
  );
  expect(JSON.stringify(output?.payload)).toContain("step done");
  const [taskTurn, steerTurn] = await turns(session.id);
  expect(taskTurn).toMatchObject({ status: "superseded" });
  expect(steerTurn).toMatchObject({ status: "queued", source: "user" });

  // The Steer runs next on the unchanged history: the earlier step's call and
  // result stay where they were and the message is appended after them.
  const second = await runTurn(ctx, session.id, runtime);
  expect(second.status).toBe("idle");
  expect(scripted.calls).toBe(2);
  const [, answered] = await turns(session.id);
  expect(answered).toMatchObject({ status: "completed" });
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(historyShape(history)).toEqual([
    "user:task",
    "call:local_fixture",
    "result",
    "user:status",
    "assistant",
  ]);
});

test("a queued Send keeps waiting for the whole running turn", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let sent = false;
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `step-2-${session.id}`, output: [functionCall("local_fixture", {}, "call-2")] },
    { id: `answer-${session.id}`, output: [assistantMessage("All steps done.")] },
    { id: `status-${session.id}`, output: [assistantMessage("Status: all done.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (sent) return;
    sent = true;
    await send(ctx, session.id, "What is the status?");
  });
  const first = await runTurn(ctx, session.id, runtime);
  expect(first.status).toBe("idle");
  // The whole turn ran; the queued message did not cut in.
  expect(scripted.calls).toBe(3);
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.superseded")).toBe(false);
  const [taskTurn, statusTurn] = await turns(session.id);
  expect(taskTurn).toMatchObject({ status: "completed" });
  expect(statusTurn).toMatchObject({ status: "queued" });
});

test("a Steer withdrawn before the handover commits leaves the turn working", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `answer-${session.id}`, output: [assistantMessage("All steps done.")] },
  ]);
  // The unlocked read sees a Steer, but none is waiting when the settlement
  // re-checks under the session lock (it was withdrawn or claimed between).
  let phantomReads = 0;
  const read = spyOn(opengeniDb, "hasPendingSteerForTurn").mockImplementation(async () => {
    if (scripted.calls !== 1 || phantomReads > 0) return false;
    phantomReads += 1;
    return true;
  });
  try {
    const result = await runTurn(
      ctx,
      session.id,
      scriptedRuntime(scripted, async () => {}),
    );
    expect(result.status).toBe("idle");
  } finally {
    read.mockRestore();
  }
  expect(phantomReads).toBe(1);
  expect(scripted.calls).toBe(2);
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.superseded")).toBe(false);
  expect(timeline.filter((event) => event.type === "turn.completed")).toHaveLength(1);
  const [taskTurn] = await turns(session.id);
  expect(taskTurn).toMatchObject({ status: "completed" });
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(historyShape(history)).toEqual(["user:task", "call:local_fixture", "result", "assistant"]);
});

test("a handover after parallel tool calls keeps every call and result, even with slow persistence", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let steered = false;
  const scripted = new ScriptedModel([
    {
      id: `step-1-${session.id}`,
      output: [
        functionCall("local_fixture", {}, "call-1"),
        functionCall("local_fixture", {}, "call-2"),
      ],
    },
    { id: `answer-${session.id}`, output: [assistantMessage("Status: both steps are done.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (steered) return;
    steered = true;
    await send(ctx, session.id, "What is the status?", "steer");
  });
  // The stream consumer lags behind the SDK: the next model call is admitted
  // while the completed step's tool events are still queued for it.
  const append = opengeniDb.appendSessionHistoryItems;
  const slowAppend = spyOn(opengeniDb, "appendSessionHistoryItems").mockImplementation(
    async (...args: Parameters<typeof append>) => {
      await Bun.sleep(150);
      return await append(...args);
    },
  );
  try {
    const first = await runTurn(ctx, session.id, runtime);
    expect(first.status).toBe("idle");
  } finally {
    slowAppend.mockRestore();
  }
  expect(scripted.calls).toBe(1);
  const timeline = await events(ctx, session.id);
  expect(timeline.filter((event) => event.type === "turn.superseded")).toHaveLength(1);
  // Both calls and both outputs reached the live timeline, not only history.
  const callIds = (type: string) =>
    ["call-1", "call-2"].filter((id) =>
      timeline.some(
        (event) => event.type === type && JSON.stringify(event.payload).includes(`"${id}"`),
      ),
    );
  expect(callIds("agent.toolCall.created")).toEqual(["call-1", "call-2"]);
  expect(callIds("agent.toolCall.output")).toEqual(["call-1", "call-2"]);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(historyShape(history)).toEqual([
    "user:task",
    "call:local_fixture",
    "call:local_fixture",
    "result",
    "result",
  ]);
});

test.each(["new", "queued"] as const)(
  "two %s Steers share one replacement attempt",
  async (mode) => {
    const ctx = await fixture();
    const session = await startSession(ctx);
    let steered = false;
    const scripted = new ScriptedModel([
      { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
      { id: `answer-${session.id}`, output: [assistantMessage("Status, and noted.")] },
    ]);
    const runtime = scriptedRuntime(scripted, async () => {
      if (steered) return;
      steered = true;
      for (const text of ["What is the status?", "Also keep notes"]) {
        const accepted = await send(ctx, session.id, text, mode === "new" ? "steer" : "send");
        if (mode === "queued") {
          const [queued] = await shared.admin<Array<{ version: number }>>`
          select version from session_turns where id = ${accepted.turnId}`;
          await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
            db.transaction((tx) =>
              steerQueuedTurnInTransaction(tx as unknown as typeof db, {
                accountId: ctx.accountId,
                workspaceId: ctx.workspaceId,
                sessionId: session.id,
                turnId: accepted.turnId,
                expectedTurnVersion: queued!.version,
                actor: { type: "human", subjectId: ctx.subjectId },
                operationKey: crypto.randomUUID(),
              }),
            ),
          );
        }
      }
    });

    expect((await runTurn(ctx, session.id, runtime)).status).toBe("idle");
    expect(scripted.calls).toBe(1);
    // One claim consumes the waiting Steer prefix. The earlier prompt keeps its
    // own history item without paying for an empty worker attempt.
    expect((await runTurn(ctx, session.id, runtime)).status).toBe("idle");
    expect(scripted.calls).toBe(2);
    expect((await turns(session.id)).map((turn) => turn.status)).toEqual([
      "superseded",
      "superseded",
      "completed",
    ]);
    const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
    expect(historyShape(history)).toEqual([
      "user:task",
      "call:local_fixture",
      "result",
      "user:status",
      "user:notes",
      "assistant",
    ]);
    const [attempts] = await shared.admin<Array<{ count: number }>>`
    select count(*)::int as count from session_turn_attempts where session_id = ${session.id}`;
    expect(attempts?.count).toBe(2);
  },
);

test("an API caller's interrupt on a waiting Steer still stops the running attempt", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let steered = false;
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `answer-${session.id}`, output: [assistantMessage("Status: step one is done.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (steered) return;
    steered = true;
    const accepted = await send(ctx, session.id, "What is the status?", "steer");
    const [steerTurn] = await shared.admin<Array<{ version: number }>>`
      select version from session_turns where id = ${accepted.turnId}`;
    const now = await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
      db.transaction((tx) =>
        steerQueuedTurnInTransaction(tx as unknown as typeof db, {
          accountId: ctx.accountId,
          workspaceId: ctx.workspaceId,
          sessionId: session.id,
          turnId: accepted.turnId,
          expectedTurnVersion: steerTurn!.version,
          actor: { type: "human", subjectId: ctx.subjectId },
          operationKey: crypto.randomUUID(),
          interrupt: true,
        }),
      ),
    );
    expect(now.interruptionCount).toBe(1);
  });
  // The interrupted attempt is fenced at once instead of finishing its step.
  const fenced = await runTurn(ctx, session.id, runtime).then(
    () => null,
    (error: unknown) => error,
  );
  expect(String((fenced as Error | null)?.message)).toContain("TURN_ATTEMPT_FENCED");
  expect(scripted.calls).toBe(1);
  expect(await interruptionCount(session.id)).toBe(1);
  const timeline = await events(ctx, session.id);
  const requested = timeline.filter((event) => event.type === "session.control.steer_requested");
  expect(requested.map((event) => (event.payload as { stopping?: boolean }).stopping)).toEqual([
    false,
    true,
  ]);
});

/** Publish the session's events after `after` to the live bus, as the API does. */
async function publishSince(ctx: Ctx, sessionId: string, bus: MemoryEventBus, after: number) {
  const fresh = (await events(ctx, sessionId)).filter((event) => event.sequence > after);
  await bus.publish(ctx.workspaceId, sessionId, fresh);
}

/**
 * A provider stream that keeps generating until it is cut short. Like the
 * real Responses and Claude transports, it ends a preempted request with the
 * output items it had already completed.
 */
class StreamingModel implements Model {
  calls = 0;
  requests: ModelRequest[] = [];
  preemptedAt: number[] = [];
  constructor(
    private readonly script: (call: number) => {
      completed: ModelResponse["output"];
      cutOff?: { itemId: string; text: string; unstarted?: ModelResponse["output"] };
      onStreaming?: () => Promise<void>;
    },
  ) {}
  async getResponse(): Promise<ModelResponse> {
    throw new Error("streamed only");
  }
  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const call = this.calls++;
    const step = this.script(call);
    yield { type: "response_started" };
    for (const item of step.completed) {
      const message = item as { type?: string; id?: string; content?: Array<{ text?: string }> };
      if (message.type === "message")
        yield {
          type: "output_text_delta",
          itemId: message.id,
          delta: message.content?.[0]?.text ?? "",
        } as StreamEvent;
    }
    if (step.cutOff) {
      yield {
        type: "output_text_delta",
        itemId: step.cutOff.itemId,
        delta: step.cutOff.text,
      } as StreamEvent;
      await step.onStreaming?.();
      // Keep generating until the request is cut short.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the Steer never cut the stream")), 30_000);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        if (request.signal?.aborted) stop();
        else request.signal?.addEventListener("abort", stop, { once: true });
      });
      if (!isModelPreempted(request.signal)) throw request.signal?.reason;
      this.preemptedAt.push(call);
      yield preemptedResponseDone({
        id: `cut-${call}`,
        output: [...step.completed, ...(step.cutOff.unstarted ?? [])],
        usage: { requests: 1, inputTokens: 40, outputTokens: 0, totalTokens: 40 },
      } as never);
      return;
    }
    yield {
      type: "response_done",
      response: {
        id: `done-${call}`,
        output: step.completed,
        usage: { requests: 1, inputTokens: 40, outputTokens: 5, totalTokens: 45 },
      },
    } as StreamEvent;
  }
}

test("a Steer while the model is still generating cuts that request short and keeps what finished", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const bus = new MemoryEventBus();
  let steeredAt = 0;
  const model = new StreamingModel((call) =>
    call === 0
      ? {
          completed: [assistantMessage("Checking the logs.", "msg-done")],
          cutOff: {
            itemId: "msg-cut",
            text: "Next I wi",
            // A call the cut-off answer had not finished: it never ran.
            unstarted: [functionCall("local_fixture", {}, "call-unstarted")],
          },
          onStreaming: async () => {
            const before = (await events(ctx, session.id)).at(-1)?.sequence ?? 0;
            await send(ctx, session.id, "What is the status?", "steer");
            steeredAt = Date.now();
            await publishSince(ctx, session.id, bus, before);
          },
        }
      : { completed: [assistantMessage("Status: the logs are clean.", "msg-answer")] },
  );
  let toolRuns = 0;
  const runtime = scriptedRuntime(model, async () => {
    toolRuns += 1;
  });

  const first = await runTurn(ctx, session.id, runtime, bus);
  expect(first.status).toBe("idle");
  // The live notice reached the stream within moments, not at a step boundary.
  expect(model.preemptedAt).toEqual([0]);
  expect(model.calls).toBe(1);
  expect(Date.now() - steeredAt).toBeLessThan(10_000);
  expect(toolRuns).toBe(0);
  expect(await interruptionCount(session.id)).toBe(0);
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  const superseded = timeline.filter((event) => event.type === "turn.superseded");
  expect(superseded).toHaveLength(1);
  expect(superseded[0]!.payload).toMatchObject({
    reason: "steer",
    atModelStep: true,
    cutOffText: "Next I wi",
  });
  // The finished message stays, as a progress note; the call never started.
  const completed = timeline.filter((event) => event.type === "agent.message.completed");
  expect(completed.map((event) => event.payload)).toEqual([
    expect.objectContaining({ text: "Checking the logs.", phase: "commentary" }),
  ]);
  expect(timeline.some((event) => event.type === "agent.toolCall.created")).toBe(false);

  // The Steer runs next on the unchanged history plus the kept message.
  const second = await runTurn(ctx, session.id, runtime, bus);
  expect(second.status).toBe("idle");
  expect(model.calls).toBe(2);
  const nextInput = JSON.stringify(model.requests[1]!.input);
  expect(nextInput).toContain("Checking the logs.");
  expect(nextInput).toContain("What is the status?");
  expect(nextInput).not.toContain("Next I wi");
  expect(nextInput).not.toContain("call-unstarted");
  // Earlier history is a prefix of the next request: nothing was rewritten.
  const firstInput = JSON.stringify(model.requests[0]!.input);
  expect(nextInput.startsWith(firstInput.slice(0, -1))).toBe(true);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(historyShape(history)).toEqual(["user:task", "assistant", "user:status", "assistant"]);
  expect((await turns(session.id)).map((turn) => turn.status)).toEqual(["superseded", "completed"]);
});

test("several quick Steers while the model generates are read in order by one request", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const bus = new MemoryEventBus();
  const model = new StreamingModel((call) =>
    call === 0
      ? {
          completed: [],
          cutOff: { itemId: "msg-cut", text: "Let me" },
          onStreaming: async () => {
            const before = (await events(ctx, session.id)).at(-1)?.sequence ?? 0;
            await send(ctx, session.id, "What is the status?", "steer");
            await publishSince(ctx, session.id, bus, before);
            const middle = (await events(ctx, session.id)).at(-1)?.sequence ?? 0;
            await send(ctx, session.id, "Also keep notes", "steer");
            await publishSince(ctx, session.id, bus, middle);
          },
        }
      : { completed: [assistantMessage("Status, and noted.", "msg-answer")] },
  );
  const runtime = scriptedRuntime(model, async () => {});
  expect((await runTurn(ctx, session.id, runtime, bus)).status).toBe("idle");
  // One cut request, however many Steers arrived while it streamed.
  expect(model.preemptedAt).toEqual([0]);
  // Both waiting messages reach the model in one replacement attempt.
  expect((await runTurn(ctx, session.id, runtime, bus)).status).toBe("idle");
  expect(model.calls).toBe(2);
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(historyShape(history)).toEqual(["user:task", "user:status", "user:notes", "assistant"]);
  const superseded = (await events(ctx, session.id)).filter(
    (event) => event.type === "turn.superseded",
  );
  expect(superseded[0]!.payload).toMatchObject({ cutOffText: "Let me" });
  expect(await interruptionCount(session.id)).toBe(0);
});
