import type { Session, SessionEvent, SessionTurn } from "@opengeni/contracts";
import { describe, expect, it } from "bun:test";
import {
  auditReleaseSentinel,
  validateInput,
  type ReleaseSentinelAuditDependencies,
} from "./release-sentinel-audit";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const clientEventId = "release-sentinel:ope-25:test:turn:v1";

describe("release sentinel read-only audit", () => {
  it("proves one logical turn/history effect across one preemption", async () => {
    const result = await auditReleaseSentinel(fixture(), { workspaceId, sessionId, clientEventId });
    expect(result).toMatchObject({
      ok: true,
      clientEventCount: 1,
      logicalTurnCount: 1,
      turnStartedCount: 2,
      turnCompletedCount: 1,
      turnFailedCount: 0,
      preemptionCount: 1,
      resumedAttemptCount: 1,
      rolloutPreemptionCount: 1,
      triggerChainMismatchCount: 0,
      turnBindingMismatchCount: 0,
      modelUsageCount: 1,
      modelSourceCount: 1,
      toolCreatedCount: 1,
      unexpectedToolCallCount: 0,
      toolOutputCount: 1,
      matchedToolEffectCount: 1,
      historyToolCallCount: 1,
      historyToolOutputCount: 1,
      matchedHistoryToolEffectCount: 1,
      authoritativeToolEffectCount: 1,
      authoritativeHistoryEffectCount: 1,
      authoritativeHistoryItemCount: 1,
      duplicateHistoryEffectCount: 0,
      duplicateModelSourceCount: 0,
      duplicateToolEffectCount: 0,
      staleAttemptEffectCount: 0,
    });
  });

  it("fails evidence on duplicate model/tool/history or post-terminal effects", async () => {
    const deps = fixture();
    const events = await deps.listEvents(workspaceId, sessionId);
    const usage = events.find((event) => event.type === "agent.model.usage")!;
    events.push({ ...usage, id: "99999999-9999-4999-8999-999999999999", sequence: 9 });
    deps.listEvents = async () => events;
    const history = await deps.listHistory(workspaceId, sessionId);
    history.push({ position: 3, item: { type: "function_call_result", callId: "call-1" } });
    deps.listHistory = async () => history;
    const result = await auditReleaseSentinel(deps, { workspaceId, sessionId, clientEventId });
    expect(result.ok).toBe(false);
    expect(result.duplicateModelSourceCount).toBeGreaterThan(0);
    expect(result.duplicateHistoryEffectCount).toBeGreaterThan(0);
    expect(result.staleAttemptEffectCount).toBeGreaterThan(0);
  });

  it("keeps the operation-bound trigger separate from the authoritative history pair", async () => {
    const deps = fixture();
    const history = await deps.listHistory(workspaceId, sessionId);
    history.push({ position: 3, item: { type: "message", role: "user", content: "unrelated" } });
    deps.listHistory = async () => history;
    const result = await auditReleaseSentinel(deps, { workspaceId, sessionId, clientEventId });
    expect(result.authoritativeHistoryEffectCount).toBe(1);
    expect(result.authoritativeHistoryItemCount).toBe(1);
    expect(result.ok).toBe(true);
  });

  it("rejects non-canonical tenant/session/event scope", () => {
    expect(() => validateInput({ workspaceId: "bad", sessionId, clientEventId })).toThrow();
    expect(() => validateInput({ workspaceId, sessionId, clientEventId: "unrelated" })).toThrow();
  });

  it("fails closed when a model usage effect lacks its idempotency source identity", async () => {
    const deps = fixture();
    const events = await deps.listEvents(workspaceId, sessionId);
    const usage = events.find((event) => event.type === "agent.model.usage")!;
    usage.payload = { inputTokens: 1, outputTokens: 1 };
    deps.listEvents = async () => events;
    const result = await auditReleaseSentinel(deps, { workspaceId, sessionId, clientEventId });
    expect(result.ok).toBe(false);
    expect(result.modelUsageCount).toBe(1);
    expect(result.modelSourceCount).toBe(0);
  });

  it("rejects another turn's effects and a non-rollout preemption", async () => {
    const deps = fixture();
    const events = await deps.listEvents(workspaceId, sessionId);
    const preemption = events.find((event) => event.type === "turn.preempted")!;
    preemption.payload = {
      triggerEventId: eventId(1),
      reason: "context_compacted",
      resumeWithNotice: true,
    };
    events.push({
      ...events.find((event) => event.type === "agent.model.usage")!,
      id: "99999999-9999-4999-8999-999999999999",
      sequence: 9,
      turnId: "88888888-8888-4888-8888-888888888888",
      payload: { sourceKey: "other-turn-model" },
    });
    deps.listEvents = async () => events;
    const result = await auditReleaseSentinel(deps, { workspaceId, sessionId, clientEventId });
    expect(result.ok).toBe(false);
    expect(result.rolloutPreemptionCount).toBe(0);
    expect(result.turnBindingMismatchCount).toBe(1);
  });

  it("rejects a broken trigger chain or unmatched tool/history effects", async () => {
    const deps = fixture();
    const events = await deps.listEvents(workspaceId, sessionId);
    events.find((event) => event.type === "turn.started")!.payload = {
      triggerEventId: "77777777-7777-4777-8777-777777777777",
    };
    events.find((event) => event.type === "agent.toolCall.created")!.payload = {
      id: "call-1",
      name: "another_tool",
    };
    events.find((event) => event.type === "agent.toolCall.output")!.payload = { id: "other-call" };
    deps.listEvents = async () => events;
    const history = await deps.listHistory(workspaceId, sessionId);
    history.find((entry) => entry.item.type === "function_call_result")!.item.callId = "other-call";
    deps.listHistory = async () => history;
    const result = await auditReleaseSentinel(deps, { workspaceId, sessionId, clientEventId });
    expect(result.ok).toBe(false);
    expect(result.triggerChainMismatchCount).toBeGreaterThan(0);
    expect(result.unexpectedToolCallCount).toBe(1);
    expect(result.matchedToolEffectCount).toBe(0);
    expect(result.matchedHistoryToolEffectCount).toBe(0);
  });
});

function fixture(): ReleaseSentinelAuditDependencies {
  const session = {
    id: sessionId,
    workspaceId,
    status: "idle",
    createIdempotencyKey: "release-sentinel:ope-25:test",
  } as Session;
  const turn = {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId,
    sessionId,
    triggerEventId: eventId(5),
    status: "completed",
  } as SessionTurn;
  const event = (
    sequence: number,
    type: SessionEvent["type"],
    payload: unknown = {},
  ): SessionEvent => ({
    id: eventId(sequence),
    workspaceId,
    sessionId,
    sequence,
    type,
    payload,
    occurredAt: "2026-07-10T00:00:00Z",
    turnId: turn.id,
  });
  const events: SessionEvent[] = [
    { ...event(1, "user.message"), clientEventId, turnId: null },
    event(2, "turn.started", { triggerEventId: eventId(1) }),
    event(3, "agent.model.usage", { sourceKey: "model-step-1" }),
    event(4, "agent.toolCall.created", { id: "call-1", name: "exec_command" }),
    event(5, "turn.preempted", {
      triggerEventId: eventId(1),
      reason: "worker_shutdown",
      resumeWithNotice: true,
    }),
    event(6, "turn.started", { triggerEventId: eventId(5) }),
    event(7, "agent.toolCall.output", { id: "call-1" }),
    event(8, "turn.completed"),
  ];
  const history = [
    { position: 0, item: { type: "message", role: "user", content: "sentinel ope-25:test" } },
    { position: 1, item: { type: "function_call", call_id: "call-1" } },
    { position: 2, item: { type: "function_call_result", callId: "call-1" } },
  ];
  return {
    getSession: async () => session,
    listEvents: async () => [...events],
    listTurns: async () => [turn],
    listHistory: async () => history.map((item) => ({ ...item })),
  };
}

function eventId(sequence: number): string {
  return `${String(sequence).padStart(8, "0")}-4444-4444-8444-444444444444`;
}
