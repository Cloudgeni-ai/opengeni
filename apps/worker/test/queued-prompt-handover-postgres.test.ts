import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { tool } from "@openai/agents";
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
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// A person's Send to a busy chat is delivered at the running turn's next
// model-step boundary instead of waiting behind the whole turn. Real worker
// turn path, real PostgreSQL in the production RLS posture, and the real SDK
// call flow with an offline ScriptedModel. No provider, network or paid model.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("queued-prompt-handover");
  if (!acquired) throw new Error("Native PostgreSQL required for queued prompt handover tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const subjectId = `user:queued-prompt-handover:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "queued-prompt-handover",
    accountExternalId: crypto.randomUUID(),
    accountName: "Queued prompt handover",
    workspaceExternalSource: "queued-prompt-handover",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Queued prompt handover",
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

async function send(ctx: Ctx, sessionId: string, text: string) {
  await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId,
        subjectId: ctx.subjectId,
        actor: { type: "human", subjectId: ctx.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text,
        resources: [],
        source: "user",
        reasoningEffortFallback: "medium",
      }),
    ),
  );
}

/** Offline runtime: the production SDK call flow over a ScriptedModel plus one local tool. */
function scriptedRuntime(scripted: ScriptedModel, onTool: () => Promise<void>): OpenGeniRuntime {
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
            return "step done";
          },
        }),
      );
      return agent;
    },
  };
}

async function runTurn(ctx: Ctx, sessionId: string, runtime: OpenGeniRuntime) {
  const activities = createActivityTestHarness({
    settings: testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
    }),
    db: app.db,
    bus: new MemoryEventBus(),
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
     where session_id = ${sessionId} order by position, created_at`;
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

test("a Send queued while a long turn works is read at the next model step, not after the whole turn", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let sent = false;
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    // Without the handover the running turn would spend this response (and
    // every later step) before the person's message is read.
    { id: `answer-${session.id}`, output: [assistantMessage("Status: step one is done.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (sent) return;
    sent = true;
    // The person sends a normal message while the tool step runs.
    await send(ctx, session.id, "What is the status?");
  });

  const first = await runTurn(ctx, session.id, runtime);
  expect(first.status).toBe("idle");
  // The running turn handed over before its second model request.
  expect(scripted.calls).toBe(1);
  const afterFirst = await events(ctx, session.id);
  const superseded = afterFirst.filter((event) => event.type === "turn.superseded");
  expect(superseded).toHaveLength(1);
  expect(superseded[0]!.payload).toMatchObject({ reason: "queued_prompt" });
  expect(afterFirst.some((event) => event.type === "turn.failed")).toBe(false);
  const [taskTurn, statusTurn] = await turns(session.id);
  expect(taskTurn).toMatchObject({ status: "superseded" });
  expect(statusTurn).toMatchObject({ status: "queued", source: "user" });
  expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
    activeTurnId: null,
  });

  // The queued message runs next on the unchanged history: the earlier
  // step's call and result stay where they were and the message is appended.
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

test("a queued prompt withdrawn before the handover commits leaves the turn working", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `answer-${session.id}`, output: [assistantMessage("All steps done.")] },
  ]);
  // The unlocked read sees a prompt, but none is queued when the settlement
  // re-checks under the session lock (it was withdrawn or claimed between).
  let phantomReads = 0;
  const read = spyOn(opengeniDb, "hasQueuedPromptBehindTurn").mockImplementation(async () => {
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

test("a turn with nothing queued behind it never hands over", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    { id: `step-2-${session.id}`, output: [functionCall("local_fixture", {}, "call-2")] },
    { id: `answer-${session.id}`, output: [assistantMessage("All steps done.")] },
  ]);
  const result = await runTurn(
    ctx,
    session.id,
    scriptedRuntime(scripted, async () => {}),
  );
  expect(result.status).toBe("idle");
  expect(scripted.calls).toBe(3);
  const timeline = await events(ctx, session.id);
  expect(timeline.some((event) => event.type === "turn.superseded")).toBe(false);
  expect(timeline.filter((event) => event.type === "turn.completed")).toHaveLength(1);
});

test("a handover after parallel tool calls keeps every call and result, even with slow persistence", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let sent = false;
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
    if (sent) return;
    sent = true;
    await send(ctx, session.id, "What is the status?");
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

test("each queued prompt gets its own model step before it can hand over to the next", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  let sent = false;
  const scripted = new ScriptedModel([
    { id: `step-1-${session.id}`, output: [functionCall("local_fixture", {}, "call-1")] },
    // The first queued prompt is answered by its own inference, although a
    // second prompt is already queued behind it.
    { id: `answer-b-${session.id}`, output: [assistantMessage("Status: step one is done.")] },
    { id: `answer-c-${session.id}`, output: [assistantMessage("Noted.")] },
  ]);
  const runtime = scriptedRuntime(scripted, async () => {
    if (sent) return;
    sent = true;
    await send(ctx, session.id, "What is the status?");
    await send(ctx, session.id, "Also keep notes");
  });

  expect((await runTurn(ctx, session.id, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(1);
  expect((await runTurn(ctx, session.id, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(2);
  expect((await runTurn(ctx, session.id, runtime)).status).toBe("idle");
  expect(scripted.calls).toBe(3);
  expect((await turns(session.id)).map((turn) => turn.status)).toEqual([
    "superseded",
    "completed",
    "completed",
  ]);
});
