import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  Agent,
  Runner,
  tool,
  type AgentInputItem,
  type ModelRequest,
  type StreamEvent,
} from "@openai/agents";
import {
  acquireSharedTestDatabase,
  ScriptedModel,
  assistantMessage,
  functionCall,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  appendSessionHistoryItems,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
} from "@opengeni/db";
import { HistoryPrefixGuard } from "../src/activities/agent-turn/history-prefix";
import {
  createTurnHistorySink,
  type TurnHistorySinkDeps,
} from "../src/activities/agent-turn/history-sink";
import { checkpointHistoryBeforeProviderDispatch } from "../src/activities/agent-turn/provider-dispatch-barrier";
import { prepareRunInput } from "@opengeni/runtime";

const checkpoint = { type: "compaction", encrypted_content: "offline-checkpoint" };
const message = (content: string) => ({ type: "message", role: "user", content });
const seed = [
  ...Array.from({ length: 125 }, (_, i) => message(`Keep instruction ${i}`)),
  checkpoint,
  message("Investigate"),
];

test("legacy approval resume establishes ownership before measuring the saved prefix", async () => {
  let executions = 0;
  const gated = tool({
    name: "gated",
    description: "Approval fixture",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: false,
    needsApproval: true,
    execute: async () => {
      executions++;
      return "approved result";
    },
  });
  const model = new ScriptedModel([
    { output: [functionCall("gated", {}, "approval-call")] },
    { output: [assistantMessage("approved answer")] },
  ]);
  const agent = new Agent({ name: "approval-resume", model, tools: [gated] });
  const runner = new Runner({ tracingDisabled: true });
  const first = await runner.run(agent, seed as AgentInputItem[], { historyOwnership: "external" });
  expect(executions).toBe(0);
  const legacy = JSON.parse(first.state.toString());
  delete legacy.historyOwnership;
  const prepared = await prepareRunInput(agent, {
    kind: "approval",
    serializedRunState: JSON.stringify(legacy),
    approvalId: "approval-call",
    decision: "approve",
  });
  expect(prepared.persistedHistoryCount).toBe(seed.length);
  const guard = new HistoryPrefixGuard();
  guard.seed(seed, seed.length);
  const result = await runner.run(agent, prepared.input, { historyOwnership: "external" });
  expect(executions).toBe(1);
  expect(() => guard.verify(result.history as Array<Record<string, unknown>>)).not.toThrow();
  expect(result.history.slice(0, seed.length)).toEqual(seed);
});

test("a first message may seed an empty durable prefix", () => {
  const sink = createTurnHistorySink({
    getModelRunSettings: () => testSettings(),
  } as TurnHistorySinkDeps);
  expect(() => sink.seedHistory("first message", 0)).not.toThrow();
  expect(() => sink.seedHistory("first message", 1)).toThrow("seed is unavailable");
});

test("rejects history shrinkage and same-length replacement, including a long turn hiding the shrinkage", () => {
  const guard = new HistoryPrefixGuard();
  guard.seed(seed, seed.length);
  expect(() => guard.verify(seed.slice(125))).toThrow("durable prefix changed");
  expect(() => guard.verify([...seed.slice(125), ...seed])).toThrow("durable prefix changed");
  expect(() => guard.verify([message("changed"), ...seed.slice(1)])).toThrow(
    "durable prefix changed",
  );
  const next = [...seed, assistantMessage("answer")];
  const keys = guard.verify(next);
  guard.acknowledge(keys, next.length);
  expect(guard.verify(next)).toEqual(keys);
});

for (const ownership of ["external", "sdk"] as const) {
  test(`${ownership} ownership preserves its compaction contract in input and history`, async () => {
    const model = new ScriptedModel("answer");
    const result = await new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "contract", model }),
      seed as AgentInputItem[],
      { historyOwnership: ownership },
    );
    const expected = ownership === "external" ? seed : seed.slice(125);
    expect(model.requests[0]!.input).toEqual(expected);
    expect(result.history.slice(0, expected.length)).toEqual(expected);
  });
}

let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof createDb> | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("compaction-history-durability");
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

for (const callCount of [1, 45]) {
  test(`real SDK and PostgreSQL retain ${callCount} tool pairs and answer across reloads`, async () => {
    if (!app || !shared) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(app.db, {
      accountExternalSource: "history-durability-test",
      accountExternalId: suffix,
      accountName: "Test",
      workspaceExternalSource: "history-durability-test",
      workspaceExternalId: suffix,
      workspaceName: "Test",
      subjectId: suffix,
    });
    const { accountId, workspaceId: grantedWorkspace } = access.workspaceGrants[0]!;
    const workspaceId = grantedWorkspace!;
    const session = await createSession(app.db, {
      accountId,
      workspaceId,
      initialMessage: "Start",
      resources: [],
      metadata: {},
      model: "scripted",
      reasoningEffort: "low",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(app.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(app.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: suffix,
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Could not claim fixture turn");
    const write = {
      accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      expectedExecutionGeneration: claim.turn.executionGeneration,
      expectedAttemptId: attemptId,
    };
    await appendSessionHistoryItems(app.db, {
      ...write,
      items: seed.map((item, i) => ({ position: i + 1, item })),
    });
    let stream: Awaited<ReturnType<Runner["run"]>> | undefined;
    const sink = createTurnHistorySink({
      db: app.db,
      accountId,
      workspaceId,
      sessionId: session.id,
      attemptId,
      media: {
        retainNativeGeneratedImagesFromHistory: async () => {},
        retainedScreenshotReceiptsByCallId: new Map(),
        generatedImageReceiptsByProviderItemId: new Map(),
      } as TurnHistorySinkDeps["media"],
      getTurnId: () => claim.turn.id,
      getStream: () => stream as ReturnType<TurnHistorySinkDeps["getStream"]>,
      getModelRunSettings: () => testSettings(),
      getExecutionGeneration: () => claim.turn.executionGeneration,
    });
    const initial = (await getActiveSessionHistoryItemsPaged(app.db, workspaceId, session.id)).map(
      (row) => row.item,
    );
    sink.seedHistory(initial, initial.length);
    sink.nextHistoryPosition = initial.length;
    class CheckedModel extends ScriptedModel {
      override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
        await checkpointHistoryBeforeProviderDispatch(sink);
        if (this.calls > 0) {
          const saved = await getActiveSessionHistoryItemsPaged(app!.db, workspaceId, session.id);
          expect(saved.filter((row) => row.item.type === "function_call_result")).toHaveLength(
            this.calls,
          );
        }
        yield* super.getStreamedResponse(request);
      }
    }
    let executions = 0;
    const echo = tool({
      name: "echo",
      description: "Local fixture",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => {
        executions++;
        return "evidence";
      },
    });
    const model = new CheckedModel([
      ...Array.from({ length: callCount }, (_, i) => ({
        output: [functionCall("echo", {}, `call-${i}`)],
      })),
      { output: [assistantMessage("Verified answer", "answer-id")] },
    ]);
    const result = await new Runner({ tracingDisabled: true }).run(
      new Agent({ name: "durability", model, tools: [echo] }),
      initial as AgentInputItem[],
      { stream: true, historyOwnership: "external", maxTurns: 100 },
    );
    stream = result;
    for await (const _ of result.toStream()) {
      /* barriers persist complete pairs */
    }
    await result.completed;
    await sink.reconcileConversationTruth({ requireDurable: true });
    await sink.reconcileConversationTruth({ requireDurable: true });
    const reloaded = (await getActiveSessionHistoryItemsPaged(app.db, workspaceId, session.id)).map(
      (row) => row.item,
    );
    expect(reloaded).toHaveLength(initial.length + callCount * 2 + 1);
    expect(executions).toBe(callCount);
    expect(reloaded.filter((item) => item.type === "function_call")).toHaveLength(callCount);
    expect(reloaded.filter((item) => item.type === "function_call_result")).toHaveLength(callCount);
    expect(reloaded.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "output_text", text: "Verified answer" }],
    });
    for (let continuation = 0; continuation < 3; continuation++) {
      const followup = new ScriptedModel("Already investigated");
      await new Runner({ tracingDisabled: true }).run(
        new Agent({ name: "reload", model: followup }),
        reloaded as AgentInputItem[],
        { historyOwnership: "external" },
      );
      expect(followup.requests[0]!.input).toEqual(reloaded);
    }
    const answerPosition = reloaded.length - 1;
    await expect(
      appendSessionHistoryItems(app.db, {
        ...write,
        items: [{ position: answerPosition, item: reloaded.at(-1)! }],
      }),
    ).resolves.toBeTrue();
    await expect(
      appendSessionHistoryItems(app.db, {
        ...write,
        items: [{ position: answerPosition, item: message("different") }],
      }),
    ).rejects.toThrow("persistence conflict");
  }, 180_000);
}
