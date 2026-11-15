// Regression: a parent chat ran out of credits mid-turn and stopped cleanly,
// then its workers' messages woke it again. The new turn was refused at claim
// with "insufficient workspace credits", which failed the activity: the chat
// showed "Activity task failed" and the session ended as failed. A credits
// refusal at claim now stops like the mid-turn one, leaving the session idle.

import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as opengeniDb from "@opengeni/db";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSession,
  initializeSessionStartAtomically,
  listSessionEvents,
} from "@opengeni/db";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { ScriptedModel, assistantMessage } from "@opengeni/testing/scripted-model";
import { createProductionAgentRuntime, type OpenGeniRuntime } from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";

setDefaultTimeout(120_000);
let shared: RestrictedRuntimeTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("claim-credits-refusal");
  if (!acquired) throw new Error("Native PostgreSQL required for claim credits refusal tests");
  shared = acquired;
  app = createDb(shared.appUrl, { searchPath: shared.schema });
}, 600_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function startSession() {
  const subjectId = `user:claim-credits:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "claim-credits",
    accountExternalId: crypto.randomUUID(),
    accountName: "Claim credits",
    workspaceExternalSource: "claim-credits",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Claim credits",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  const ctx = { accountId: grant.accountId, workspaceId: grant.workspaceId!, subjectId };
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId },
    initialMessage: "Answer",
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
  return { ...ctx, sessionId: session.id };
}

function scriptedRuntime(scripted: ScriptedModel): OpenGeniRuntime {
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
  };
}

async function runTurnWithoutCredits(
  ctx: Awaited<ReturnType<typeof startSession>>,
  entitlements?: { admitRun: () => Promise<{ allowed: boolean; reason?: string }> },
) {
  const balance = spyOn(opengeniDb, "getSpendableCreditBalance").mockResolvedValue({
    accountId: ctx.accountId,
    balanceMicros: 0,
    currency: "usd",
    updatedAt: new Date().toISOString(),
  });
  const scripted = new ScriptedModel([{ inputTokens: 10, output: [assistantMessage("no")] }]);
  try {
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
        billingMode: "stripe",
        usageLimitsMode: "managed",
      }),
      db: app.db,
      bus: new MemoryEventBus(),
      runtime: scriptedRuntime(scripted),
      ...(entitlements ? { entitlements: entitlements as never } : {}),
    });
    const result = await activities.runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      workflowId: `session-${ctx.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    return { result, calls: scripted.calls, balanceReads: balance.mock.calls.length };
  } finally {
    balance.mockRestore();
  }
}

test("a turn claimed without credits stops as a credits stop and leaves the session idle", async () => {
  const ctx = await startSession();
  const { result, calls, balanceReads } = await runTurnWithoutCredits(ctx);
  expect(balanceReads).toBeGreaterThan(0);
  expect(result.status).toBe("idle");
  expect(calls).toBe(0);
  const timeline = await listSessionEvents(app.db, ctx.workspaceId, ctx.sessionId, {
    after: 0,
    limit: 200,
  });
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(timeline.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
    segmentLimit: "budget_exhausted",
    detail: "insufficient workspace credits",
  });
  expect(await getSession(app.db, ctx.workspaceId, ctx.sessionId)).toMatchObject({
    status: "idle",
  });
});

test("a host's entitlements deny at claim stops the same way, keeping the session idle", async () => {
  const ctx = await startSession();
  const { result, calls } = await runTurnWithoutCredits(ctx, {
    admitRun: async () => ({ allowed: false, reason: "The plan's usage is used up" }),
  });
  expect(result.status).toBe("idle");
  expect(calls).toBe(0);
  const timeline = await listSessionEvents(app.db, ctx.workspaceId, ctx.sessionId, {
    after: 0,
    limit: 200,
  });
  expect(timeline.some((event) => event.type === "turn.failed")).toBe(false);
  expect(timeline.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
    segmentLimit: "budget_exhausted",
    detail: "The plan's usage is used up",
  });
});
