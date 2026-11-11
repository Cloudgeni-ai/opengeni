import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { tool, type Model } from "@openai/agents";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, functionCall, assistantMessage } from "@opengeni/testing/scripted-model";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  initializeSessionStartAtomically,
  listSessionEvents,
  submitHumanPromptInTransaction,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import {
  AnthropicProviderRejection,
  createProductionAgentRuntime,
  SAFETY_REFUSED_TOOL_RESULT_OMISSION,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

// A provider safety refusal must not leave a chat unusable. Ordinary turns
// build each request from the same history, so a refused tool result used to
// make every later request, including the person's next message, refused
// too. Real worker turn path and PostgreSQL in the production RLS posture,
// the real SDK call flow with an offline ScriptedModel answering exactly as
// the Claude transport does (HTTP 200, stop_reason "refusal"). No provider,
// network or paid model.
setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("safety-refusal-recovery");
  if (!acquired) throw new Error("Native PostgreSQL required for safety refusal recovery tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

/** Synthetic tool output the provider is refused over; never a real value. */
const REFUSED_OUTPUT = "decrypted credential for the sign-in: synthetic-refused-value";

function claudeRefusal() {
  return new AnthropicProviderRejection("content_policy_violation", 200, "req_synthetic_refusal");
}

async function fixture() {
  const subjectId = `user:safety-refusal-recovery:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "safety-refusal-recovery",
    accountExternalId: crypto.randomUUID(),
    accountName: "Safety refusal recovery",
    workspaceExternalSource: "safety-refusal-recovery",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Safety refusal recovery",
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
    initialMessage: "Sign in to the test app",
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
  return await withWorkspaceSessionActivityRls(app.db, ctx.workspaceId, (db) =>
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
function scriptedRuntime(scripted: Model): OpenGeniRuntime {
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
          name: "read_credentials",
          description: "Offline step that prints content the provider refuses",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
          execute: async () => REFUSED_OUTPUT,
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
  return await shared.admin<Array<{ id: string; status: string }>>`
    select id, status from session_turns where session_id = ${sessionId} order by created_at`;
}

/** The request's input items as the model received them. */
function requestInput(scripted: ScriptedModel, index: number): Array<Record<string, unknown>> {
  const input = scripted.requests[index]?.input;
  if (!Array.isArray(input)) throw new Error(`request ${index} has no item input`);
  return input as Array<Record<string, unknown>>;
}

function resultIndex(input: Array<Record<string, unknown>>, callId: string): number {
  return input.findIndex(
    (item) =>
      (item.type === "function_call_result" || item.type === "function_call_output") &&
      (item.callId === callId || item.call_id === callId),
  );
}

test("a refusal right after a tool result removes that result and the same turn continues", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([
    { id: `call-${session.id}`, output: [functionCall("read_credentials", {}, "call-1")] },
    { error: claudeRefusal() },
    { id: `answer-${session.id}`, output: [assistantMessage("Signed in another way.")] },
  ]);
  const runtime = scriptedRuntime(scripted);

  const first = await runTurn(ctx, session.id, runtime);
  expect(first.status).toBe("recovering");
  expect(scripted.calls).toBe(2);
  const afterFirst = await events(ctx, session.id);
  expect(afterFirst.some((event) => event.type === "turn.failed")).toBe(false);
  const recovery = afterFirst.filter((event) => event.type === "turn.recovery.requested");
  expect(recovery).toHaveLength(1);
  expect(recovery[0]!.payload).toMatchObject({
    reason: "provider_safety_refusal",
    code: "provider_safety_refusal",
    omittedToolResults: 1,
    omittedToolNames: ["read_credentials"],
    providerArtifactsInvalidated: 1,
    requestId: "req_synthetic_refusal",
  });

  // The stored row is never rewritten: the refusal is recorded beside it.
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  const resultRow = history.find((row) => row.item.type === "function_call_result")!;
  expect(JSON.stringify(resultRow.item)).toContain(REFUSED_OUTPUT);
  expect(resultRow.providerArtifactInvalidatedAt).not.toBeNull();
  expect(resultRow.providerArtifactInvalidationReason).toBe("provider_safety_refusal");
  // Everything else, including the person's message and the call, stays live.
  expect(
    history.filter((row) => row.providerArtifactInvalidatedAt !== null).map((row) => row.id),
  ).toEqual([resultRow.id]);

  const second = await runTurn(ctx, session.id, runtime);
  expect(second.status).toBe("idle");
  expect(scripted.calls).toBe(3);
  expect((await turns(session.id)).map((turn) => turn.status)).toEqual(["completed"]);

  const refusedInput = requestInput(scripted, 1);
  const recoveredInput = requestInput(scripted, 2);
  const refusedAt = resultIndex(refusedInput, "call-1");
  const recoveredAt = resultIndex(recoveredInput, "call-1");
  expect(refusedAt).toBeGreaterThan(0);
  expect(recoveredAt).toBe(refusedAt);
  // Cache stability: everything the provider accepted before is byte-identical.
  expect(JSON.stringify(recoveredInput.slice(0, recoveredAt))).toBe(
    JSON.stringify(refusedInput.slice(0, refusedAt)),
  );
  // The call stays settled; only its body is replaced by the short note.
  expect(JSON.stringify(refusedInput[refusedAt])).toContain(REFUSED_OUTPUT);
  expect(JSON.stringify(recoveredInput[recoveredAt])).toContain(
    JSON.stringify(SAFETY_REFUSED_TOOL_RESULT_OMISSION).slice(1, -1),
  );
  expect(JSON.stringify(recoveredInput)).not.toContain(REFUSED_OUTPUT);

  // The person's next message is sent without the refused content too.
  await send(ctx, session.id, "Thanks, what next?");
  scripted.steps.push({ id: `next-${session.id}`, output: [assistantMessage("Next step.")] });
  const third = await runTurn(ctx, session.id, runtime);
  expect(third.status).toBe("idle");
  expect(JSON.stringify(requestInput(scripted, 3))).not.toContain(REFUSED_OUTPUT);
  expect(JSON.stringify(requestInput(scripted, 3))).toContain("Thanks, what next?");
});

test("a refusal that persists after the removal fails the turn once, with no retry loop", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([
    { id: `call-${session.id}`, output: [functionCall("read_credentials", {}, "call-1")] },
    { error: claudeRefusal() },
    { error: claudeRefusal() },
  ]);
  const runtime = scriptedRuntime(scripted);

  expect((await runTurn(ctx, session.id, runtime)).status).toBe("recovering");
  expect((await runTurn(ctx, session.id, runtime)).status).toBe("failed");
  expect(scripted.calls).toBe(3);
  const recorded = await events(ctx, session.id);
  expect(recorded.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
  const failed = recorded.filter((event) => event.type === "turn.failed");
  expect(failed).toHaveLength(1);
  expect(failed[0]!.payload).toMatchObject({ code: "provider_safety_refusal", retryable: false });

  // A later message is refused as an ordinary failure: nothing new to remove,
  // and the person's own words are never removed.
  await send(ctx, session.id, "Try again please");
  const next = await runTurn(ctx, session.id, runtime);
  expect(next.status).toBe("failed");
  expect(scripted.calls).toBe(4);
  expect(JSON.stringify(requestInput(scripted, 3))).toContain("Try again please");
  const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
  expect(
    history.filter((row) => row.providerArtifactInvalidatedAt !== null).map((row) => row.item.type),
  ).toEqual(["function_call_result"]);
  const after = await events(ctx, session.id);
  expect(after.filter((event) => event.type === "turn.recovery.requested")).toHaveLength(1);
});

test("a refusal with no new tool result fails the turn as before", async () => {
  const ctx = await fixture();
  const session = await startSession(ctx);
  const scripted = new ScriptedModel([{ error: claudeRefusal() }]);
  const result = await runTurn(ctx, session.id, scriptedRuntime(scripted));
  expect(result.status).toBe("failed");
  expect(scripted.calls).toBe(1);
  const recorded = await events(ctx, session.id);
  expect(recorded.some((event) => event.type === "turn.recovery.requested")).toBe(false);
  expect(recorded.find((event) => event.type === "turn.failed")?.payload).toMatchObject({
    code: "provider_safety_refusal",
  });
});
