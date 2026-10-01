import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { tool } from "@openai/agents";
import * as opengeniDb from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  ScriptedModel,
  functionCall,
  assistantMessage,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  bootstrapWorkspace,
  checkWorkspaceAllowance,
  claimSessionWorkForAttempt,
  applySessionTurnSettlement,
  applyCreditLedgerEntry,
  appendSessionEventsForTurnAttempt,
  createDb,
  createSession,
  getActiveSessionHistoryItemsPaged,
  getSession,
  getSessionGoal,
  getLatestStartedSessionTurn,
  getSessionTurnInitiatingHumanSubjectId,
  getWorkspaceUsage,
  initializeSessionStartAtomically,
  listOutstandingSessionSystemUpdates,
  listSessionEvents,
  requestSessionCompaction,
  setMemberAllowance,
  setWorkspaceAllowance,
  submitHumanPromptInTransaction,
  withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import * as schema from "@opengeni/db/schema";
import {
  CompactionNeededError,
  createProductionAgentRuntime,
  prepareRunInput,
  type OpenGeniRuntime,
} from "@opengeni/runtime";
import { createActivityTestHarness } from "../src/activities";
import { createGoalActivities } from "../src/activities/goals";
import type { ControlActivityServices } from "../src/activities/types";

let shared: SharedTestDatabase;
let app: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("usage-allowance-regressions");
  if (!acquired) throw new Error("Native PostgreSQL required for allowance regressions");
  shared = acquired;
  app = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await shared?.release();
}, 60_000);

async function fixture() {
  const human = `user:allowance-regression:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(app.db, {
    accountExternalSource: "allowance-regression",
    accountExternalId: crypto.randomUUID(),
    accountName: "Allowance regression",
    workspaceExternalSource: "allowance-regression",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Allowance regression",
    subjectId: human,
  });
  const grant = access.workspaceGrants[0]!;
  const personalId = crypto.randomUUID();
  await shared.admin`insert into workspaces(id,account_id,name) values(${personalId},${grant.accountId},'Personal')`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${grant.accountId},${human},'owner','active',${personalId})`;
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: human,
    actorSubjectId: human,
  };
}

test.each(["unfinished_debit", "settled_debit_delayed_admission"] as const)(
  "real PG SDK producer cannot race the next paid call past %s",
  async (delayBoundary) => {
    const ctx = await fixture();
    await applyCreditLedgerEntry(app.db, {
      ...ctx,
      type: "purchase",
      amountMicros: 10_000,
      idempotencyKey: crypto.randomUUID(),
    });
    await setWorkspaceAllowance(app.db, {
      ...ctx,
      includedCredits: 100,
      period: "monthly",
      expectedVersion: 0,
    });
    const session = await createSession(app.db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      createdBy: { kind: "subject", subjectId: ctx.subjectId },
      initialMessage: "Execute a local tool then answer",
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
      goal: { text: "Complete the task" },
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began!: () => void;
    const blocked = new Promise<void>((resolve) => {
      began = resolve;
    });
    let held = false;
    const holdOnce = async () => {
      if (held) return;
      held = true;
      began();
      await released;
    };
    const originalDebit = opengeniDb.applyCreditDebitUpToBalance;
    const debit =
      delayBoundary === "unfinished_debit"
        ? spyOn(opengeniDb, "applyCreditDebitUpToBalance").mockImplementation(async (db, input) => {
            if (input.metadata?.sessionId === session.id) await holdOnce();
            return originalDebit(db, input);
          })
        : null;
    const scripted = new ScriptedModel([
      {
        id: `paid-first-${session.id}`,
        inputTokens: 100,
        outputText: "x",
        output: [functionCall("local_fixture", {}, "local-call")],
      },
      { inputTokens: 100, output: [assistantMessage("must not dispatch")] },
    ]);
    const production = createProductionAgentRuntime({ model: scripted });
    const runtime: OpenGeniRuntime = {
      ...production,
      configure: () => {},
      resolveTurnModel: () => ({
        provider: {
          id: "test-chat",
          label: "Offline",
          kind: "api-key",
          api: "chat",
          builtin: false,
        },
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
            description: "Offline no-op",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
            execute: async () => "local result",
          }),
        );
        return agent;
      },
    };
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
      billingMode: "stripe",
      usageLimitsMode: "managed",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 0,
        },
      }),
    });
    const activities = createActivityTestHarness({
      settings,
      db: app.db,
      bus: new MemoryEventBus(),
      runtime,
      entitlements: {
        admitRun: async () => {
          const usage = await getWorkspaceUsage(app.db, ctx);
          if (delayBoundary === "settled_debit_delayed_admission" && usage.workspace.used === 100)
            await holdOnce();
          return { allowed: true };
        },
      } as NonNullable<Parameters<typeof createActivityTestHarness>[0]["entitlements"]>,
    });
    try {
      const running = activities.runAgentTurn({
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: session.id,
        workflowId: `session-${session.id}`,
        workflowRunId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        trigger: { kind: "next" },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          blocked,
          running.then(() => {
            throw new Error("Worker ended before the settlement fixture hold");
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Settlement fixture hold was not reached")),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      await Bun.sleep(25);
      expect(scripted.calls).toBe(1);
      expect((await getWorkspaceUsage(app.db, ctx)).workspace.used).toBe(
        delayBoundary === "unfinished_debit" ? 0 : 100,
      );
      release();
      expect((await running).status).toBe("idle");
      expect(scripted.calls).toBe(1);
      expect((await getWorkspaceUsage(app.db, ctx)).workspace.used).toBe(100);
      expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
        status: "paused",
        pausedReason: "allowance",
        autoContinuations: 0,
      });
      const events = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
        after: 0,
        limit: 100,
      });
      expect(events.filter((event) => event.type === "agent.model.usage")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
        segmentLimit: "budget_exhausted",
        code: "allowance_exhausted",
        scope: "workspace",
      });
    } finally {
      release();
      debit?.mockRestore();
    }
  },
  60_000,
);

test.each(["workspace", "member", "recovery"] as const)(
  "real PG compaction spends last %s allowance, retains summary and refuses title/inference",
  async (scope) => {
    const ctx = await fixture();
    const allowanceScope = scope === "recovery" ? "workspace" : scope;
    await applyCreditLedgerEntry(app.db, {
      ...ctx,
      type: "purchase",
      amountMicros: 10_000,
      idempotencyKey: crypto.randomUUID(),
    });
    await setWorkspaceAllowance(app.db, {
      ...ctx,
      includedCredits: allowanceScope === "workspace" ? 100 : 1_000,
      period: "monthly",
      expectedVersion: 0,
    });
    if (allowanceScope === "member")
      await setMemberAllowance(app.db, { ...ctx, rule: { credits: 100 }, expectedVersion: 0 });
    const session = await createSession(app.db, {
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      createdBy: { kind: "subject", subjectId: ctx.subjectId },
      initialMessage: "Continue after the durable checkpoint",
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
      goal: { text: "Complete the checkpoint regression" },
    });
    await withWorkspaceRls(app.db, ctx.workspaceId, async (db) => {
      await db.insert(schema.sessionHistoryItems).values({
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: session.id,
        position: 0,
        item: {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Prior retained work ".repeat(2_000) }],
        },
      });
    });
    if (scope !== "recovery") await requestSessionCompaction(app.db, ctx.workspaceId, session.id);
    let summaries = 0;
    let paidDispatches = 0;
    let streamEntries = 0;
    const runtime = {
      configure: () => {},
      resolveTurnModel: () => ({
        client: {
          chat: {
            completions: {
              create: async () => {
                summaries++;
                return {
                  id: `offline-summary-${session.id}`,
                  usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
                  choices: [
                    { message: { content: "Completed durable summary." }, finish_reason: "stop" },
                  ],
                };
              },
            },
          },
        },
        provider: { id: "test-chat", kind: "api-key", api: "chat", builtin: false },
        configured: {
          id: "scripted-model",
          contextWindowTokens: 250_000,
          effectiveContextWindowTokens: 250_000,
          autoCompactLimitTokens: 225_000,
          hostedWebSearch: false,
        },
      }),
      prepareTools: async () => ({
        mcpServers: [],
        resolvedMcpConnectionIds: new Map(),
        codexConnectorNamespaces: new Set(),
        close: async () => {},
      }),
      buildAgent: () => ({ instructions: "" }),
      prepareInput: (
        agent: Parameters<typeof prepareRunInput>[0],
        input: Parameters<typeof prepareRunInput>[1],
      ) => prepareRunInput(agent, input),
      generateSessionTitle: async () => {
        paidDispatches++;
        throw new Error("paid title dispatched after exhaustion");
      },
      runStream: async () => {
        streamEntries++;
        if (scope === "recovery" && streamEntries === 1) {
          throw new CompactionNeededError({
            signalTokens: 250_000,
            thresholdTokens: 225_000,
            signalSource: "provider",
          });
        }
        paidDispatches++;
        throw new Error("paid inference dispatched after exhaustion");
      },
    } as unknown as OpenGeniRuntime;
    const bus = new MemoryEventBus();
    const settings = testSettings({
      databaseUrl: shared.appUrl,
      openaiModel: "scripted-model",
      sandboxBackend: "none",
      billingMode: "stripe",
      usageLimitsMode: "managed",
      modelPricingJson: JSON.stringify({
        "scripted-model": {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 1_000_000,
        },
      }),
    });
    const activities = createActivityTestHarness({ settings, db: app.db, bus, runtime });
    const result = await activities.runAgentTurn({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    const diagnosticEvents = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
      after: 0,
      limit: 100,
    });
    expect(diagnosticEvents.filter((event) => event.type === "turn.failed")).toEqual([]);
    expect(result.status).toBe("idle");
    expect(summaries).toBe(1);
    expect(paidDispatches).toBe(0);
    expect(streamEntries).toBe(scope === "recovery" ? 1 : 0);
    const usage = await getWorkspaceUsage(app.db, ctx);
    expect(usage.workspace.used).toBe(100);
    expect(usage.members.find((m) => m.subjectId === ctx.subjectId)?.used).toBe(100);
    const history = await getActiveSessionHistoryItemsPaged(app.db, ctx.workspaceId, session.id);
    expect(
      history.some((row) => String(row.item.content).includes("Completed durable summary.")),
    ).toBe(true);
    expect(await getSession(app.db, ctx.workspaceId, session.id)).toMatchObject({
      status: "idle",
      activeTurnId: null,
    });
    expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
      status: "paused",
      pausedReason: "allowance",
      autoContinuations: 0,
    });
    const events = await listSessionEvents(app.db, ctx.workspaceId, session.id, {
      after: 0,
      limit: 100,
    });
    const exhausted = events.find((event) => event.type === "usage.exhausted");
    expect(exhausted?.payload).toMatchObject({
      code: "allowance_exhausted",
      scope: allowanceScope,
      resetsAt: usage.period.end,
    });
    expect(events.find((event) => event.type === "turn.completed")?.payload).toMatchObject({
      segmentLimit: "budget_exhausted",
      code: "allowance_exhausted",
      scope: allowanceScope,
    });
    expect(events.some((event) => event.type === "session.context.compacted")).toBe(true);
  },
  60_000,
);

test("real PG latest-started A exhausted does not pause latest-finished B continuation", async () => {
  const ctx = await fixture();
  const a = await bootstrapWorkspace(app.db, {
    accountExternalSource: "allowance-regression",
    accountExternalId: crypto.randomUUID(),
    accountName: "A",
    workspaceExternalSource: "allowance-regression",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "A",
    subjectId: `user:A:${crypto.randomUUID()}`,
  });
  const humanA = a.workspaceGrants[0]!.subjectId;
  await shared.admin`insert into workspace_memberships(account_id,workspace_id,subject_id)
    values(${ctx.accountId},${ctx.workspaceId},${humanA})`;
  await shared.admin`insert into organization_memberships(account_id,subject_id,role,status,personal_workspace_id)
    values(${ctx.accountId},${humanA},'member','active',${ctx.workspaceId})`;
  await setWorkspaceAllowance(app.db, {
    ...ctx,
    includedCredits: 1_000,
    period: "monthly",
    expectedVersion: 0,
  });
  await setMemberAllowance(app.db, {
    ...ctx,
    subjectId: humanA,
    rule: { credits: 0 },
    expectedVersion: 0,
  });
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "subject", subjectId: ctx.subjectId },
    initialMessage: "B's causal work",
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
    goal: { text: "Continue B" },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("B fixture did not claim");
  await applySessionTurnSettlement(app.db, ctx.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    triggerEventId: claimed.turn.triggerEventId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "B" } }],
  });
  const acceptedA = await withWorkspaceSubjectSessionActivityRls(
    app.db,
    ctx.workspaceId,
    humanA,
    (db) =>
      submitHumanPromptInTransaction(db, {
        accountId: ctx.accountId,
        workspaceId: ctx.workspaceId,
        sessionId: session.id,
        subjectId: humanA,
        actor: { type: "human", subjectId: humanA },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "A previous task",
        resources: [],
        tools: [],
        reasoningEffort: "low",
        reasoningEffortFallback: "low",
        source: "user",
      }),
  );
  const attemptA = crypto.randomUUID();
  const claimedA = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: attemptA,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimedA.action !== "claimed") throw new Error("A fixture did not claim");
  expect(claimedA.turn.id).toBe(acceptedA.turnId);
  expect(
    (
      await appendSessionEventsForTurnAttempt(
        app.db,
        ctx.workspaceId,
        session.id,
        claimedA.turn.id,
        claimedA.turn.executionGeneration,
        attemptA,
        [{ type: "turn.started", payload: { turnId: claimedA.turn.id } }],
      )
    ).accepted,
  ).toBe(true);
  await applySessionTurnSettlement(app.db, ctx.workspaceId, {
    sessionId: session.id,
    turnId: claimedA.turn.id,
    attemptId: attemptA,
    triggerEventId: claimedA.turn.triggerEventId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "A" } }],
  });
  // Retain real acceptance/claim/settlement truth, but make finish order diverge
  // from start order (as legacy/recovered histories can). A influences policy,
  // never the exact latest-finished B causal human.
  await shared.admin`update session_turns set finished_at=now()-interval '1 hour',position=999
    where id=${claimedA.turn.id}`;
  expect((await getLatestStartedSessionTurn(app.db, ctx.workspaceId, session.id))?.id).toBe(
    claimedA.turn.id,
  );
  expect(await checkWorkspaceAllowance(app.db, { ...ctx, subjectId: humanA })).toMatchObject({
    code: "allowance_exhausted",
    scope: "member",
    subjectId: humanA,
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    billingMode: "disabled",
    usageLimitsMode: "none",
    goalIdleBackoffMs: [0],
    goalIdleBackoffMaxMs: 0,
  });
  const services = {
    db: app.db,
    bus: new MemoryEventBus(),
    settings,
    entitlements: null,
  } as unknown as ControlActivityServices;
  expect(
    await createGoalActivities(async () => services).maybeContinueGoal({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    }),
  ).toEqual({ action: "continue" });
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "active",
    autoContinuations: 1,
  });
  const updates = await listOutstandingSessionSystemUpdates(app.db, ctx.workspaceId, session.id);
  const continuation = updates.find((update) => update.kind === "goal_continuation");
  expect(continuation?.lineage.causalTurnId).toBe(claimed.turn.id);
  expect(continuation?.payload).toMatchObject({
    policy: { model: claimedA.turn.model, reasoningEffort: claimedA.turn.reasoningEffort },
  });
  const continuationAttemptId = crypto.randomUUID();
  const next = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: continuationAttemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (next.action !== "claimed") throw new Error("Continuation fixture did not claim");
  expect(await getSessionTurnInitiatingHumanSubjectId(app.db, ctx.workspaceId, next.turn.id)).toBe(
    ctx.subjectId,
  );
  await applySessionTurnSettlement(app.db, ctx.workspaceId, {
    sessionId: session.id,
    turnId: next.turn.id,
    attemptId: continuationAttemptId,
    triggerEventId: next.turn.triggerEventId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "B continuation" } }],
  });
  await setMemberAllowance(app.db, { ...ctx, rule: { credits: 0 }, expectedVersion: 0 });
  expect(
    await createGoalActivities(async () => services).maybeContinueGoal({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    }),
  ).toEqual({ action: "paused" });
  expect(await getSessionGoal(app.db, ctx.workspaceId, session.id)).toMatchObject({
    status: "paused",
    pausedReason: "allowance",
    autoContinuations: 1,
  });
  expect(
    (await listOutstandingSessionSystemUpdates(app.db, ctx.workspaceId, session.id)).filter(
      (update) => update.kind === "goal_continuation",
    ),
  ).toEqual([]);
}, 60_000);

test("real PG pure-service continuation retains nullable causal human despite exhausted member rules", async () => {
  const ctx = await fixture();
  await setWorkspaceAllowance(app.db, {
    ...ctx,
    includedCredits: 1_000,
    period: "monthly",
    memberDefault: { credits: 0 },
    expectedVersion: 0,
  });
  const session = await createSession(app.db, {
    accountId: ctx.accountId,
    workspaceId: ctx.workspaceId,
    createdBy: { kind: "service", subjectId: "service:pure-regression" },
    initialMessage: "Pure service task",
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
    goal: { text: "Continue pure service" },
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error("Pure service fixture did not claim");
  await applySessionTurnSettlement(app.db, ctx.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turn.id,
    attemptId,
    triggerEventId: claimed.turn.triggerEventId,
    turnStatus: "completed",
    sessionStatus: "idle",
    activeTurnId: null,
    events: [{ type: "turn.completed", payload: { output: "Service result" } }],
  });
  const settings = testSettings({
    databaseUrl: shared.appUrl,
    billingMode: "disabled",
    usageLimitsMode: "none",
  });
  const services = {
    db: app.db,
    bus: new MemoryEventBus(),
    settings,
    entitlements: null,
  } as unknown as ControlActivityServices;
  expect(
    await createGoalActivities(async () => services).maybeContinueGoal({
      accountId: ctx.accountId,
      workspaceId: ctx.workspaceId,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
    }),
  ).toEqual({ action: "continue" });
  const nextAttempt = crypto.randomUUID();
  const next = await claimSessionWorkForAttempt(app.db, ctx.workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: nextAttempt,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (next.action !== "claimed") throw new Error("Pure service continuation did not claim");
  const [row] =
    await shared.admin`select initiating_human_subject_id from session_turns where id=${next.turn.id}`;
  expect(row!.initiating_human_subject_id).toBeNull();
});
