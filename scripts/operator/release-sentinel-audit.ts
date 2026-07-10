import { dbSearchPath, getSettings } from "@opengeni/config";
import type { Session, SessionEvent, SessionTurn } from "@opengeni/contracts";
import {
  createDb,
  getSession,
  getSessionHistoryItems,
  listSessionEvents,
  listSessionTurns,
} from "@opengeni/db";
import { parseArgs as parseNodeArgs } from "node:util";

const canonicalUuid =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const sentinelClientEvent = /^release-sentinel:([a-z0-9][a-z0-9._:-]{2,127}):turn:v1$/;

export interface ReleaseSentinelAuditInput {
  workspaceId: string;
  sessionId: string;
  clientEventId: string;
}

export interface ReleaseSentinelAuditDependencies {
  getSession(workspaceId: string, sessionId: string): Promise<Session | null>;
  listEvents(workspaceId: string, sessionId: string): Promise<SessionEvent[]>;
  listTurns(workspaceId: string, sessionId: string): Promise<SessionTurn[]>;
  listHistory(
    workspaceId: string,
    sessionId: string,
  ): Promise<Array<{ position: number; item: Record<string, unknown> }>>;
}

export interface ReleaseSentinelAuditResult {
  ok: boolean;
  workspaceId: string;
  sessionId: string;
  clientEventCount: number;
  logicalTurnCount: number;
  turnStartedCount: number;
  turnCompletedCount: number;
  turnFailedCount: number;
  preemptionCount: number;
  resumedAttemptCount: number;
  rolloutPreemptionCount: number;
  triggerChainMismatchCount: number;
  turnBindingMismatchCount: number;
  modelUsageCount: number;
  modelSourceCount: number;
  toolCreatedCount: number;
  unexpectedToolCallCount: number;
  toolOutputCount: number;
  matchedToolEffectCount: number;
  historyToolCallCount: number;
  historyToolOutputCount: number;
  matchedHistoryToolEffectCount: number;
  authoritativeToolEffectCount: number;
  authoritativeHistoryItemCount: number;
  duplicateHistoryEffectCount: number;
  duplicateModelSourceCount: number;
  duplicateToolEffectCount: number;
  staleAttemptEffectCount: number;
}

export async function auditReleaseSentinel(
  deps: ReleaseSentinelAuditDependencies,
  input: ReleaseSentinelAuditInput,
): Promise<ReleaseSentinelAuditResult> {
  validateInput(input);
  const match = sentinelClientEvent.exec(input.clientEventId)!;
  const operationKey = match[1]!;
  const [session, events, turns, history] = await Promise.all([
    deps.getSession(input.workspaceId, input.sessionId),
    deps.listEvents(input.workspaceId, input.sessionId),
    deps.listTurns(input.workspaceId, input.sessionId),
    deps.listHistory(input.workspaceId, input.sessionId),
  ]);
  if (!session || session.workspaceId !== input.workspaceId || session.id !== input.sessionId) {
    throw new Error("release sentinel session is not in the requested workspace");
  }
  if (
    events.some(
      (event) => event.workspaceId !== input.workspaceId || event.sessionId !== input.sessionId,
    )
  ) {
    throw new Error("release sentinel event scope mismatch");
  }
  if (
    turns.some(
      (turn) => turn.workspaceId !== input.workspaceId || turn.sessionId !== input.sessionId,
    )
  ) {
    throw new Error("release sentinel turn scope mismatch");
  }

  const turn = turns.length === 1 ? turns[0]! : null;
  const clientEvents = events.filter((event) => event.clientEventId === input.clientEventId);
  const trigger =
    clientEvents.length === 1 && clientEvents[0]?.type === "user.message" ? clientEvents[0] : null;
  const turnEvents = turn ? events.filter((event) => event.turnId === turn.id) : [];
  const significantTypes = new Set([
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "turn.preempted",
    "agent.message.completed",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.model.usage",
  ]);
  const significantEvents = events.filter((event) => significantTypes.has(event.type));
  const completed = turnEvents.filter((event) => event.type === "turn.completed");
  const terminalSequence = completed[0]?.sequence ?? Number.POSITIVE_INFINITY;
  const staleTypes = new Set([
    "agent.message.completed",
    "agent.toolCall.created",
    "agent.toolCall.output",
    "agent.model.usage",
  ]);
  const modelUsageEvents = turnEvents.filter((event) => event.type === "agent.model.usage");
  const modelSources = modelUsageEvents
    .map((event) => stringField(event.payload, "sourceKey"))
    .filter((value): value is string => Boolean(value));
  const toolCreated = turnEvents.filter((event) => event.type === "agent.toolCall.created");
  const toolOutputs = turnEvents.filter((event) => event.type === "agent.toolCall.output");
  const toolCreatedKeys = toolCreated
    .map((event) => stringField(event.payload, "id") ?? stringField(event.payload, "callId"))
    .filter((value): value is string => Boolean(value));
  const toolEffects = toolOutputs
    .map((event) => stringField(event.payload, "id") ?? stringField(event.payload, "callId"))
    .filter((value): value is string => Boolean(value));
  const historyCalls = history
    .filter((entry) => isToolCall(entry.item))
    .map((entry) => historyCallId(entry.item))
    .filter((value): value is string => Boolean(value));
  const historyOutputs = history
    .filter((entry) => isToolOutput(entry.item))
    .map((entry) => historyCallId(entry.item))
    .filter((value): value is string => Boolean(value));
  const historyEffectKeys = history.flatMap((entry) => historyEffectKey(entry.item));
  const authoritativeHistoryItemCount = history.filter(
    (entry) => isUserMessage(entry.item) && JSON.stringify(entry.item).includes(operationKey),
  ).length;
  const starts = turnEvents.filter((event) => event.type === "turn.started");
  const preemptions = turnEvents.filter((event) => event.type === "turn.preempted");
  const preemption = preemptions.length === 1 ? preemptions[0]! : null;
  const triggerChainChecks = [
    Boolean(
      trigger && starts[0] && stringField(starts[0].payload, "triggerEventId") === trigger.id,
    ),
    Boolean(
      trigger && preemption && stringField(preemption.payload, "triggerEventId") === trigger.id,
    ),
    Boolean(
      preemption && starts[1] && stringField(starts[1].payload, "triggerEventId") === preemption.id,
    ),
    Boolean(turn && preemption && turn.triggerEventId === preemption.id),
    Boolean(
      trigger &&
      starts[0] &&
      preemption &&
      starts[1] &&
      completed[0] &&
      trigger.sequence < starts[0].sequence &&
      starts[0].sequence < preemption.sequence &&
      preemption.sequence < starts[1].sequence &&
      starts[1].sequence < completed[0].sequence,
    ),
    Boolean(
      toolCreated[0] &&
      preemption &&
      starts[1] &&
      toolOutputs[0] &&
      completed[0] &&
      toolCreated[0].sequence < preemption.sequence &&
      starts[1].sequence < toolOutputs[0].sequence &&
      toolOutputs[0].sequence < completed[0].sequence,
    ),
  ];
  const result: ReleaseSentinelAuditResult = {
    ok: false,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    clientEventCount: clientEvents.length,
    logicalTurnCount: turns.length,
    turnStartedCount: starts.length,
    turnCompletedCount: completed.length,
    turnFailedCount: turnEvents.filter((event) => event.type === "turn.failed").length,
    preemptionCount: preemptions.length,
    resumedAttemptCount: Math.max(0, starts.length - 1),
    rolloutPreemptionCount: preemptions.filter(
      (event) =>
        stringField(event.payload, "reason") === "worker_shutdown" &&
        booleanField(event.payload, "resumeWithNotice") === true,
    ).length,
    triggerChainMismatchCount: triggerChainChecks.filter((valid) => !valid).length,
    turnBindingMismatchCount: significantEvents.filter((event) => event.turnId !== turn?.id).length,
    modelUsageCount: modelUsageEvents.length,
    modelSourceCount: modelSources.length,
    toolCreatedCount: toolCreated.length,
    unexpectedToolCallCount: toolCreated.filter(
      (event) => stringField(event.payload, "name") !== "exec_command",
    ).length,
    toolOutputCount: toolOutputs.length,
    matchedToolEffectCount: intersectionCount(toolCreatedKeys, toolEffects),
    historyToolCallCount: historyCalls.length,
    historyToolOutputCount: historyOutputs.length,
    matchedHistoryToolEffectCount: intersectionCount(historyCalls, historyOutputs),
    authoritativeToolEffectCount: toolEffects.length,
    authoritativeHistoryItemCount,
    duplicateHistoryEffectCount: duplicateCount(historyEffectKeys),
    duplicateModelSourceCount: duplicateCount(modelSources),
    duplicateToolEffectCount: duplicateCount(toolEffects),
    staleAttemptEffectCount: turnEvents.filter(
      (event) => event.sequence > terminalSequence && staleTypes.has(event.type),
    ).length,
  };
  result.ok =
    session.status === "idle" &&
    session.createIdempotencyKey === `release-sentinel:${operationKey}` &&
    result.clientEventCount === 1 &&
    result.logicalTurnCount === 1 &&
    turns[0]?.status === "completed" &&
    // This sentinel is intentionally held inside exec_command before rollout,
    // so its first attempt has visibly started. One graceful worker
    // preemption then produces exactly one resumed attempt on the SAME turn.
    result.turnStartedCount === 2 &&
    result.turnCompletedCount === 1 &&
    result.turnFailedCount === 0 &&
    result.preemptionCount === 1 &&
    result.resumedAttemptCount === 1 &&
    result.rolloutPreemptionCount === 1 &&
    result.triggerChainMismatchCount === 0 &&
    result.turnBindingMismatchCount === 0 &&
    result.modelUsageCount >= 1 &&
    // A missing sourceKey is not evidence of uniqueness. Every persisted model
    // usage effect must carry its billing/history idempotency identity.
    result.modelSourceCount === result.modelUsageCount &&
    result.toolCreatedCount === 1 &&
    result.unexpectedToolCallCount === 0 &&
    result.toolOutputCount === 1 &&
    result.matchedToolEffectCount === 1 &&
    result.historyToolCallCount === 1 &&
    result.historyToolOutputCount === 1 &&
    result.matchedHistoryToolEffectCount === 1 &&
    result.authoritativeToolEffectCount === 1 &&
    result.authoritativeHistoryItemCount === 1 &&
    result.duplicateHistoryEffectCount === 0 &&
    result.duplicateModelSourceCount === 0 &&
    result.duplicateToolEffectCount === 0 &&
    result.staleAttemptEffectCount === 0;
  return result;
}

export function validateInput(input: ReleaseSentinelAuditInput): void {
  for (const [label, value] of [
    ["workspace", input.workspaceId],
    ["session", input.sessionId],
  ] as const) {
    if (!canonicalUuid.test(value))
      throw new Error(`${label} ID must be a canonical lowercase UUID`);
  }
  if (!sentinelClientEvent.test(input.clientEventId)) {
    throw new Error("client event ID is not a release sentinel identity");
  }
}

async function main(): Promise<void> {
  let safeInput: ReleaseSentinelAuditInput | undefined;
  let dbClient: ReturnType<typeof createDb> | undefined;
  try {
    const { values } = parseNodeArgs({
      args: process.argv.slice(2),
      allowPositionals: false,
      strict: true,
      options: {
        "workspace-id": { type: "string" },
        "session-id": { type: "string" },
        "client-event-id": { type: "string" },
      },
    });
    safeInput = {
      workspaceId: required(values["workspace-id"], "--workspace-id"),
      sessionId: required(values["session-id"], "--session-id"),
      clientEventId: required(values["client-event-id"], "--client-event-id"),
    };
    validateInput(safeInput);
    const settings = getSettings();
    const searchPath = dbSearchPath(settings);
    dbClient = createDb(settings.databaseUrl, {
      ...(searchPath ? { searchPath } : {}),
      rlsStrategy: settings.rlsStrategy,
    });
    const db = dbClient.db;
    const result = await auditReleaseSentinel(
      {
        getSession: async (workspaceId, sessionId) => await getSession(db, workspaceId, sessionId),
        listEvents: async (workspaceId, sessionId) =>
          await listSessionEvents(db, workspaceId, sessionId, { after: 0, limit: 5000 }),
        listTurns: async (workspaceId, sessionId) =>
          await listSessionTurns(db, workspaceId, sessionId, 100),
        listHistory: async (workspaceId, sessionId) =>
          await getSessionHistoryItems(db, workspaceId, sessionId),
      },
      safeInput,
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(
      JSON.stringify({
        operation: "release_sentinel_audit",
        status: "error",
        ...(safeInput ? safeInput : {}),
      }),
    );
    process.exitCode = 1;
  } finally {
    await dbClient?.close();
  }
}

function historyEffectKey(item: Record<string, unknown>): string[] {
  const type = typeof item.type === "string" ? item.type : "";
  if (!isToolCall(item) && !isToolOutput(item)) return [];
  const callId = historyCallId(item);
  return callId ? [`${type}:${callId}`] : [];
}

function isToolCall(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  return type === "function_call" || type === "tool_call" || type.endsWith("_call");
}

function isToolOutput(item: Record<string, unknown>): boolean {
  const type = typeof item.type === "string" ? item.type : "";
  return (
    type === "function_call_output" ||
    type === "tool_call_output" ||
    type.endsWith("_call_output") ||
    type.endsWith("_call_result")
  );
}

function historyCallId(item: Record<string, unknown>): string | null {
  return stringField(item, "callId") ?? stringField(item, "call_id") ?? stringField(item, "id");
}

function isUserMessage(item: Record<string, unknown>): boolean {
  return item.type === "message" && item.role === "user";
}

function duplicateCount(values: string[]): number {
  return values.length - new Set(values).size;
}

function intersectionCount(left: string[], right: string[]): number {
  const rightValues = new Set(right);
  return new Set(left.filter((value) => rightValues.has(value))).size;
}

function stringField(value: unknown, field: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function booleanField(value: unknown, field: string): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "boolean" ? candidate : null;
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

if (import.meta.main) {
  await main();
}
