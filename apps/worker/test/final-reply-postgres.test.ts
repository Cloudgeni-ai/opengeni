import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  bootstrapWorkspace,
  applyCreditLedgerEntry,
  sumUsageQuantity,
  openUsageReservationQuantity,
  createSessionGoal,
  getSessionGoal,
  materializeGoalContinuation,
  addSessionSystemUpdate,
  createDb,
  createSession,
  getSessionHistoryItems,
  initializeSessionStartAtomically,
  listSessionEvents,
  setSessionGoalStatus,
  setSessionGoalStatusWithEvent,
  getSessionTurn,
  sessionTurnHasFinalReplyNudge,
  withWorkspaceRls,
} from "@opengeni/db";
import { and, eq } from "drizzle-orm";
import * as schema from "@opengeni/db/schema";
import { tool } from "@openai/agents";
import { z } from "zod";
import { createProductionAgentRuntime } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  assistantMessage,
  functionCall,
  MemoryEventBus,
  ScriptedModel,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { createActivityTestHarness } from "../src/activities";
import { finalReplyNudge, hasFinalReplyNudge } from "../src/activities/agent-turn/final-reply";

describe("empty final reply production runtime with PostgreSQL", () => {
  let shared: SharedTestDatabase;
  let client: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const acquired = await acquireSharedTestDatabase("final-reply");
    if (!acquired) throw new Error("Real PostgreSQL is required");
    shared = acquired;
    client = createDb(shared.appUrl);
  }, 180_000);
  afterAll(async () => {
    await client?.close();
    await shared?.release();
  }, 60_000);

  async function run(
    steps: ConstructorParameters<typeof ScriptedModel>[0],
    completedGoal = true,
    unrelatedGoal = false,
    aggregateOnlyBilling = false,
  ) {
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "final-reply",
      accountExternalId: suffix,
      accountName: "Final reply",
      workspaceExternalSource: "final-reply",
      workspaceExternalId: suffix,
      workspaceName: "Final reply",
      subjectId: `user:${suffix}`,
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      initialMessage: "Deliver the completed result.",
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      createdBy: { kind: "subject", subjectId: grant.subjectId },
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      clientEventId: `initial:${suffix}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
      goal: unrelatedGoal ? null : { text: "Deliver the result." },
    });
    const model = new ScriptedModel(steps);
    const production = createProductionAgentRuntime({ model });
    if (aggregateOnlyBilling) {
      await applyCreditLedgerEntry(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId!,
        type: "test_credit",
        amountMicros: 5_000_000,
        sourceType: "test",
        sourceId: session.id,
        idempotencyKey: `aggregate-stream-credit:${session.id}`,
      });
    }
    let toolCalls = 0;
    const runtime = {
      ...production,
      runStream: async (...args: Parameters<typeof production.runStream>) => {
        if (unrelatedGoal && model.calls === 0) {
          await createSessionGoal(client.db, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId!,
            sessionId: session.id,
            text: "Unrelated later goal",
            createdBy: "api",
          });
          await setSessionGoalStatus(client.db, grant.workspaceId!, session.id, {
            status: "completed",
            evidence: "Unrelated proof.",
          });
        }
        if (completedGoal && model.calls === 0) {
          const active = await import("@opengeni/db").then(({ getSession }) =>
            getSession(client.db, grant.workspaceId!, session.id),
          );
          if (!active?.activeTurnId) throw new Error("Expected active turn");
          // Same-turn completion has exact event authority, like goal_complete.
          const current = await getSessionTurn(client.db, grant.workspaceId!, active.activeTurnId);
          await setSessionGoalStatusWithEvent(client.db, grant.workspaceId!, session.id, {
            status: "completed",
            evidence: "Verified result.",
            event: { type: "goal.completed", evidence: "Verified result." },
            commandActor: {
              type: "agent_attempt",
              sessionId: session.id,
              turnId: active.activeTurnId,
              attemptId: current!.activeAttemptId!,
              executionGeneration: current!.executionGeneration,
            },
          });
        }
        const stream = await production.runStream(...args);
        if (aggregateOnlyBilling) {
          // This runtime reports billing only through its final SDK aggregate.
          // Keep the production producer, model admission, usage accumulator,
          // history events, and final output; omit worker-facing terminal frames.
          const toStream = stream.toStream.bind(stream);
          stream.toStream = () =>
            toStream().pipeThrough(
              new TransformStream({
                transform(event, controller) {
                  if (
                    event.type === "raw_model_stream_event" &&
                    event.data.type === "response_done"
                  )
                    return;
                  controller.enqueue(event);
                },
              }),
            );
        }
        return stream;
      },
      buildAgent: (...args: Parameters<typeof production.buildAgent>) => {
        const agent = production.buildAgent(...args);
        agent.tools.push(
          tool({
            name: "verified_result",
            description: "Verify the result.",
            parameters: z.object({}),
            execute: async () => {
              toolCalls += 1;
              return "Verified result.";
            },
          }),
        );
        return agent;
      },
    };
    const activities = createActivityTestHarness({
      settings: testSettings({
        databaseUrl: shared.appUrl,
        openaiModel: "scripted-model",
        sandboxBackend: "none",
        ...(aggregateOnlyBilling
          ? {
              billingMode: "stripe" as const,
              usageLimitsMode: "static" as const,
              staticUsageLimitsJson: JSON.stringify({
                maxMonthlyTokensPerWorkspace: 10_000_000,
                maxMonthlyCostMicrosPerAccount: 10_000_000,
              }),
              modelPricingJson: JSON.stringify({
                "scripted-model": {
                  inputMicrosPerMillionTokens: 1_000_000,
                  outputMicrosPerMillionTokens: 2_000_000,
                  marginBps: 0,
                },
              }),
            }
          : {}),
      }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
    });
    const result = await activities.runAgentTurn({
      accountId: grant.accountId,
      workspaceId: grant.workspaceId!,
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (result.status === "unclaimed") throw new Error("Expected a claimed turn");
    return {
      result,
      model,
      toolCalls,
      grant,
      session,
      activities,
      turn: await getSessionTurn(client.db, grant.workspaceId!, result.turnId),
      history: await getSessionHistoryItems(client.db, grant.workspaceId!, session.id),
      events: await listSessionEvents(client.db, grant.workspaceId!, session.id),
    };
  }
  test("delivers a final after one nudge without rewriting history or creating another turn", async () => {
    const actual = await run([
      { output: [assistantMessage("")] },
      { outputText: "Completed result: verified." },
    ]);
    expect(actual.model.calls).toBe(2);
    expect(actual.turn?.status).toBe("completed");
    expect(
      hasFinalReplyNudge(
        actual.history.map((r) => r.item),
        actual.result.turnId,
      ),
    ).toBe(true);
    expect(JSON.stringify(actual.model.requests[1]?.input)).toContain(
      "Runtime final-reply handoff",
    );
    expect(actual.events.filter((e) => e.type === "turn.completed").map((e) => e.payload)).toEqual([
      { output: "Completed result: verified." },
    ]);
    expect(actual.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  }, 60_000);
  test("aggregate-only usage bills both streams of a same-turn final-reply handoff", async () => {
    const answer = "Completed result: verified.";
    const actual = await run(
      [
        { inputTokens: 100, outputText: " ", output: [assistantMessage("")] },
        { inputTokens: 200, outputText: answer },
      ],
      true,
      false,
      true,
    );
    expect(actual.model.calls).toBe(2);
    expect(actual.turn?.status).toBe("completed");
    expect(actual.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    expect(JSON.stringify(actual.model.requests[1]?.input)).toContain(
      "Runtime final-reply handoff",
    );
    const expectedCost = 302 + answer.length * 2;
    const debits = await shared.admin<Array<{ amount_micros: string; idempotency_key: string }>>`
      select amount_micros, idempotency_key from credit_ledger_entries
      where account_id = ${actual.grant.accountId} and type = 'model_usage_debit'`;
    expect(debits).toHaveLength(2);
    expect(new Set(debits.map((row) => row.idempotency_key)).size).toBe(2);
    expect(debits.reduce((sum, row) => sum + Number(row.amount_micros), 0)).toBe(-expectedCost);
    const facts = actual.events.filter((event) => event.type === "agent.model.usage");
    expect(facts).toHaveLength(2);
    expect(new Set(facts.map((event) => event.payload.sourceKey)).size).toBe(2);
    expect(facts.map((event) => event.payload.inputTokens)).toEqual([100, 200]);
    const rows = await shared.admin<
      Array<{ event_type: string; quantity: string; idempotency_key: string }>
    >`
      select event_type, quantity, idempotency_key from usage_events
      where workspace_id = ${actual.grant.workspaceId!}
        and turn_id = ${actual.result.turnId}
        and event_type in ('model.tokens', 'model.cost')`;
    expect(
      rows
        .filter((row) => row.event_type === "model.tokens")
        .map((row) => Number(row.quantity))
        .sort((a, b) => a - b),
    ).toEqual([101, 200 + answer.length]);
    expect(new Set(rows.map((row) => row.idempotency_key)).size).toBe(4);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: actual.grant.accountId,
        workspaceId: actual.grant.workspaceId!,
        eventType: "model.tokens",
        since: new Date(0),
      }),
    ).toBe(301 + answer.length);
    expect(
      await sumUsageQuantity(client.db, {
        accountId: actual.grant.accountId,
        workspaceId: actual.grant.workspaceId!,
        eventType: "model.cost",
        since: new Date(0),
      }),
    ).toBe(expectedCost);
    expect(
      await openUsageReservationQuantity(client.db, {
        accountId: actual.grant.accountId,
        workspaceId: actual.grant.workspaceId!,
        eventType: "model.tokens.reserved",
        since: new Date(0),
        holdSince: new Date(0),
      }),
    ).toBe(0);
  }, 60_000);
  test("a second empty reply completes with a typed notice and never loops", async () => {
    const actual = await run([{ output: [assistantMessage("")] }]);
    expect(actual.model.calls).toBe(2);
    expect(actual.turn?.status).toBe("completed");
    expect(actual.events.filter((e) => e.type === "turn.completed").at(-1)?.payload).toEqual({
      output: "",
      emptyFinalReply: true,
    });
    expect(actual.events.filter((e) => e.type === "turn.failed")).toHaveLength(0);
  }, 60_000);
  test("a nonempty final needs no handoff call", async () => {
    const actual = await run("Completed result.");
    expect(actual.model.calls).toBe(1);
    expect(
      hasFinalReplyNudge(
        actual.history.map((r) => r.item),
        actual.result.turnId,
      ),
    ).toBe(false);
    expect(actual.turn?.status).toBe("completed");
  }, 60_000);
  test("review: empty final after completed hosted search receives the handoff", async () => {
    const actual = await run(
      [
        {
          output: [
            {
              type: "hosted_tool_call",
              id: "hosted-search-review",
              name: "web_search_call",
              status: "completed",
              providerData: { action: { type: "search", query: "review" } },
            } as ReturnType<typeof assistantMessage>,
            assistantMessage(""),
          ],
        },
        { outputText: "Search result delivered." },
      ],
      false,
    );
    expect(actual.model.calls).toBe(2);
    expect(
      hasFinalReplyNudge(
        actual.history.map((row) => row.item),
        actual.result.turnId,
      ),
    ).toBe(true);
  }, 60_000);
  test("unfinished hosted activity alone does not qualify for a final-reply handoff", async () => {
    const actual = await run(
      [
        {
          output: [
            {
              type: "hosted_tool_call",
              id: "hosted-unfinished",
              name: "web_search_call",
              status: "failed",
              providerData: { action: { type: "search", query: "unfinished" } },
            } as ReturnType<typeof assistantMessage>,
            assistantMessage(""),
          ],
        },
      ],
      false,
    );
    expect(actual.model.calls).toBe(1);
    expect(
      hasFinalReplyNudge(
        actual.history.map((row) => row.item),
        actual.result.turnId,
      ),
    ).toBe(false);
  }, 60_000);
  test("an empty final after a tool is corrected without replaying the tool", async () => {
    const actual = await run(
      [
        { output: [functionCall("verified_result", {})] },
        { output: [assistantMessage("")] },
        { outputText: "Verified deliverable." },
      ],
      false,
    );
    expect(actual.model.calls).toBe(3);
    expect(actual.toolCalls).toBe(1);
    expect(actual.turn?.status).toBe("completed");
    expect(actual.events.filter((e) => e.type === "agent.toolCall.output")).toHaveLength(1);
  }, 60_000);
  test("the bounded ledger probe retains its once-only fence through compaction", async () => {
    const actual = await run([{ output: [assistantMessage("")] }, { outputText: "Delivered." }]);
    const { workspaceId } = actual.grant;
    const marker = finalReplyNudge(actual.result.turnId).content[0]!.text;
    expect(
      await sessionTurnHasFinalReplyNudge(
        client.db,
        workspaceId!,
        actual.session.id,
        actual.result.turnId,
        marker,
      ),
    ).toBe(true);
    await withWorkspaceRls(client.db, workspaceId!, async (scoped) => {
      await scoped
        .update(schema.sessionHistoryItems)
        .set({ active: false })
        .where(
          and(
            eq(schema.sessionHistoryItems.sessionId, actual.session.id),
            eq(schema.sessionHistoryItems.turnId, actual.result.turnId),
          ),
        );
    });
    expect(
      await sessionTurnHasFinalReplyNudge(
        client.db,
        workspaceId!,
        actual.session.id,
        actual.result.turnId,
        marker,
      ),
    ).toBe(true);
    expect(
      await sessionTurnHasFinalReplyNudge(
        client.db,
        workspaceId!,
        actual.session.id,
        crypto.randomUUID(),
        marker,
      ),
    ).toBe(false);
  }, 60_000);
  test("a late machine update after completion gets its missing final handoff", async () => {
    const actual = await run("Original deliverable.");
    actual.model.steps.push(
      { output: [assistantMessage("")] },
      { outputText: "Late finding: the deliverable remains verified." },
    );
    await addSessionSystemUpdate(client.db, {
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      kind: "agent_message",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      summary: "Late child finding",
      payload: {
        type: "agent_message",
        operationId: crypto.randomUUID(),
        text: "Late child finding: verification passed.",
      },
    });
    const result = await actual.activities.runAgentTurn({
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(result.status).toBe("idle");
    expect(actual.model.calls).toBe(3);
    expect(JSON.stringify(actual.model.requests[1]?.input)).toContain(
      "not an instruction to stay silent",
    );
    expect(JSON.stringify(actual.model.requests[2]?.input)).toContain(
      "Runtime final-reply handoff",
    );
    const events = await listSessionEvents(client.db, actual.grant.workspaceId!, actual.session.id);
    expect(events.filter((e) => e.type === "turn.completed").at(-1)?.payload).toEqual({
      output: "Late finding: the deliverable remains verified.",
    });
  }, 60_000);
  test("a replacement attempt cannot spend a second nudge after provider recovery", async () => {
    const failure = Object.assign(new Error("Service unavailable"), { status: 503 });
    const actual = await run([
      { output: [assistantMessage("")] },
      { error: failure },
      { output: [assistantMessage("")] },
    ]);
    expect(actual.result.status).toBe("recovering");
    const result = await actual.activities.runAgentTurn({
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(actual.model.calls).toBe(3);
    expect(result.status).toBe("idle");
    if (result.status === "unclaimed") throw new Error("Expected recovery claim");
    expect(result.turnId).toBe(actual.result.turnId);
    const turn = await getSessionTurn(client.db, actual.grant.workspaceId!, result.turnId);
    expect(turn?.executionGeneration).toBe(2);
    expect(turn?.status).toBe("completed");
    const history = await getSessionHistoryItems(
      client.db,
      actual.grant.workspaceId!,
      actual.session.id,
    );
    expect(history.filter((r) => hasFinalReplyNudge([r.item], result.turnId))).toHaveLength(1);
  }, 60_000);
  test("recovery before the first nudge retains durable tool eligibility", async () => {
    const actual = await run(
      [
        { output: [functionCall("verified_result", {})] },
        { error: Object.assign(new Error("Service unavailable"), { status: 503 }) },
        { output: [assistantMessage("")] },
        { outputText: "Recovered deliverable." },
      ],
      false,
    );
    expect(actual.result.status).toBe("recovering");
    const result = await actual.activities.runAgentTurn({
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(result.status).toBe("idle");
    expect(actual.model.calls).toBe(4);
    expect(actual.toolCalls).toBe(1);
  }, 60_000);
  test("a completed hosted tool survives provider recovery as final-reply eligibility", async () => {
    const actual = await run(
      [
        {
          output: [
            {
              type: "hosted_tool_call",
              id: "hosted-recovery",
              name: "web_search_call",
              status: "completed",
              providerData: { action: { type: "search", query: "recovery" } },
            } as ReturnType<typeof assistantMessage>,
          ],
        },
        { error: Object.assign(new Error("Service unavailable"), { status: 503 }) },
        { output: [assistantMessage("")] },
        { outputText: "Recovered hosted result." },
      ],
      false,
    );
    expect(actual.result.status).toBe("recovering");
    const result = await actual.activities.runAgentTurn({
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(result.status).toBe("idle");
    expect(actual.model.calls).toBe(4);
  }, 60_000);
  test("an unrelated later goal cannot change a no-goal turn's handoff eligibility", async () => {
    const actual = await run([{ output: [assistantMessage("")] }], false, true);
    expect(actual.model.calls).toBe(1);
    expect(
      hasFinalReplyNudge(
        actual.history.map((r) => r.item),
        actual.result.turnId,
      ),
    ).toBe(false);
    expect(actual.turn?.status).toBe("completed");
  }, 60_000);
  async function emptyActiveGoal() {
    return run(
      [
        { output: [functionCall("verified_result", {})] },
        { output: [assistantMessage("")] },
        { output: [assistantMessage("")] },
      ],
      false,
    );
  }
  test("typed empty completion never pauses the active goal or suppresses continuation", async () => {
    const actual = await emptyActiveGoal();
    expect(actual.turn?.status).toBe("completed");
    expect(
      (await getSessionGoal(client.db, actual.grant.workspaceId!, actual.session.id))?.status,
    ).toBe("active");
    const continuation = await materializeGoalContinuation(client.db, {
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      defaultMaxAutoContinuations: null,
      budgetBlocked: null,
      policy: {
        model: "scripted-model",
        reasoningEffort: "low",
        latencyMode: "standard",
        tools: [],
        sandboxBackend: "none",
      },
      prompt: () => "Continue unfinished work.",
    });
    expect(continuation.action).toBe("continue");
  }, 60_000);
  test("a later child-result wake remains deliverable after typed empty completion", async () => {
    const actual = await emptyActiveGoal();
    actual.model.steps.push({ outputText: "Child result integrated." });
    await addSessionSystemUpdate(client.db, {
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      kind: "child_terminal_result",
      classification: "info",
      sourceId: crypto.randomUUID(),
      dedupeKey: crypto.randomUUID(),
      summary: "Child finished",
      payload: {
        type: "child_terminal_result",
        childSessionId: crypto.randomUUID(),
        status: "idle",
      },
    });
    const result = await actual.activities.runAgentTurn({
      accountId: actual.grant.accountId,
      workspaceId: actual.grant.workspaceId!,
      sessionId: actual.session.id,
      workflowId: `session-${actual.session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(result.status).toBe("idle");
    expect(actual.model.calls).toBe(4);
    expect(
      (await getSessionGoal(client.db, actual.grant.workspaceId!, actual.session.id))?.status,
    ).toBe("active");
    const events = await listSessionEvents(client.db, actual.grant.workspaceId!, actual.session.id);
    expect(events.filter((e) => e.type === "turn.completed").at(-1)?.payload).toEqual({
      output: "Child result integrated.",
    });
  }, 60_000);
});
