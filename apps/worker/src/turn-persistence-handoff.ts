import type {
  ExactTurnEventPersistenceInput,
  ModelCallPersistenceObligation,
  TurnPersistenceHandoff,
  TurnPersistenceObligation,
} from "./activities/types";
import { createHash, randomUUID } from "node:crypto";
export {
  parseTurnPersistenceHandoff,
  TURN_PERSISTENCE_HANDOFF_MAX_BYTES,
  turnPersistenceHandoffHeartbeatState,
} from "./turn-persistence-reference";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validTokenCount(value: unknown): boolean {
  return value === undefined || isNonNegativeSafeInteger(value);
}

function validTokenDetails(value: unknown): boolean {
  if (value === undefined) return true;
  const entries = Array.isArray(value) ? value : [value];
  return entries.every(
    (entry) =>
      isRecord(entry) && Object.values(entry).every((count) => isNonNegativeSafeInteger(count)),
  );
}

function validModelUsage(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    validTokenCount(value.inputTokens) &&
    validTokenCount(value.outputTokens) &&
    validTokenCount(value.totalTokens) &&
    validTokenDetails(value.inputTokensDetails) &&
    (value.requestUsageEntries === undefined ||
      (Array.isArray(value.requestUsageEntries) &&
        value.requestUsageEntries.every(validModelUsage)))
  );
}

function usageEventMatches(
  event: unknown,
  metering: ModelCallPersistenceObligation["metering"],
  turnId: string,
): event is ExactTurnEventPersistenceInput {
  if (!isRecord(event) || !isRecord(event.payload)) return false;
  return (
    event.type === "agent.model.usage" &&
    event.turnId === turnId &&
    isNonEmptyString(event.producerId) &&
    isPositiveSafeInteger(event.producerSeq) &&
    isCanonicalIsoDate(event.occurredAt) &&
    event.payload.turnId === turnId &&
    event.payload.sourceKey === metering.sourceKey &&
    event.payload.model === metering.model
  );
}

function validMetering(value: unknown): value is ModelCallPersistenceObligation["metering"] {
  if (!isRecord(value) || !validModelUsage(value.usage)) return false;
  if (
    !isNonEmptyString(value.model) ||
    typeof value.isCodexTurn !== "boolean" ||
    !isNonEmptyString(value.sourceKey)
  ) {
    return false;
  }
  return true;
}

function validPreparedCompaction(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.eventPayload)) return false;
  if (
    !isNonEmptyString(value.persistenceKey) ||
    value.eventPayload.persistenceKey !== value.persistenceKey ||
    typeof value.clearRequestedCompaction !== "boolean" ||
    !isCanonicalIsoDate(value.occurredAt) ||
    !["auto", "operator", "proactive", "overflow"].includes(String(value.eventPayload.trigger))
  ) {
    return false;
  }

  if (value.action === "skip") {
    return (
      (value.reason === "replacement_not_smaller" || value.reason === "replacement_unchanged") &&
      value.eventPayload.reason === value.reason &&
      isNonEmptyString(value.eventPayload.replacementFingerprint)
    );
  }
  if (
    value.action !== "apply" ||
    !Array.isArray(value.replacementItems) ||
    !value.replacementItems.every(isRecord) ||
    !isRecord(value.summaryItem) ||
    !isNonNegativeSafeInteger(value.replacementInputTokens) ||
    !isRecord(value.result)
  ) {
    return false;
  }
  const result = value.result;
  return (
    isNonNegativeSafeInteger(result.signalTokens) &&
    isNonNegativeSafeInteger(result.thresholdTokens) &&
    isNonNegativeSafeInteger(result.estimatedTokensBefore) &&
    isNonNegativeSafeInteger(result.estimatedTokensAfter) &&
    result.estimatedTokensAfter === value.replacementInputTokens &&
    isNonEmptyString(result.replacementFingerprint) &&
    value.eventPayload.replacementFingerprint === result.replacementFingerprint
  );
}

/** Validate the full PostgreSQL-only obligation and all cross-field identity. */
export function parseTurnPersistenceObligation(
  value: unknown,
  turnId: string,
): TurnPersistenceObligation | null {
  if (!isRecord(value)) return null;
  const obligation = value;
  if (obligation.kind === "pending_tool_call") {
    if (
      !isNonEmptyString(obligation.callId) ||
      !isNonEmptyString(obligation.callType) ||
      !isRecord(obligation.callItem) ||
      obligation.callItem.callId !== obligation.callId ||
      obligation.callItem.type !== obligation.callType
    ) {
      return null;
    }
  } else if (obligation.kind === "model_call") {
    if (
      !isRecord(obligation.history) ||
      !Array.isArray(obligation.history.items) ||
      !obligation.history.items.every(
        (item, index, items) =>
          isRecord(item) &&
          isNonNegativeSafeInteger(item.position) &&
          isRecord(item.item) &&
          (index === 0 || item.position > Number(items[index - 1]?.position)),
      ) ||
      !(
        obligation.history.producerCodexCredentialId === null ||
        isNonEmptyString(obligation.history.producerCodexCredentialId)
      ) ||
      !isNonNegativeSafeInteger(obligation.history.modelToolOutputTruncationTokens) ||
      !validMetering(obligation.metering) ||
      !usageEventMatches(obligation.event, obligation.metering, turnId)
    ) {
      return null;
    }
  } else if (obligation.kind === "context_compaction") {
    const pairedUsage = obligation.metering !== null && obligation.event !== null;
    if (
      !validPreparedCompaction(obligation.compaction) ||
      !(
        (obligation.metering === null && obligation.event === null) ||
        (pairedUsage &&
          validMetering(obligation.metering) &&
          usageEventMatches(obligation.event, obligation.metering, turnId))
      )
    ) {
      return null;
    }
  } else {
    return null;
  }
  return obligation as TurnPersistenceObligation;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Persistence obligation contains non-finite data");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) throw new Error("Persistence obligation is not JSON-compatible");
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function turnPersistenceObligationDigest(obligation: TurnPersistenceObligation): string {
  return createHash("sha256").update(canonicalJson(obligation), "utf8").digest("hex");
}

/** Normalize exactly as JSONB transport will, then validate and hash those bytes. */
export function normalizeTurnPersistenceObligation(
  value: TurnPersistenceObligation,
  turnId: string,
): { obligation: TurnPersistenceObligation; digest: string } {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Persistence obligation is not JSON-compatible");
  const obligation = parseTurnPersistenceObligation(JSON.parse(serialized), turnId);
  if (!obligation) throw new Error("Invalid turn persistence obligation");
  return { obligation, digest: turnPersistenceObligationDigest(obligation) };
}

export function prepareTurnPersistenceHandoff(input: {
  turnId: string;
  triggerEventId: string;
  executionGeneration: number;
  attemptId: string;
  obligation: TurnPersistenceObligation;
}): { handoff: TurnPersistenceHandoff; obligation: TurnPersistenceObligation } {
  const normalized = normalizeTurnPersistenceObligation(input.obligation, input.turnId);
  return {
    handoff: {
      version: 2,
      receiptId: randomUUID(),
      turnId: input.turnId,
      triggerEventId: input.triggerEventId,
      executionGeneration: input.executionGeneration,
      attemptId: input.attemptId,
      obligationKind: normalized.obligation.kind,
      obligationDigest: normalized.digest,
    },
    obligation: normalized.obligation,
  };
}
