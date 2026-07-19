import type { TurnPersistenceHandoff } from "./activities/types";

export const TURN_PERSISTENCE_HANDOFF_MAX_BYTES = 1_024;

type HandoffFieldState =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "valid"; handoff: TurnPersistenceHandoff };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const HANDOFF_KEYS = new Set([
  "version",
  "receiptId",
  "turnId",
  "triggerEventId",
  "executionGeneration",
  "attemptId",
  "obligationKind",
  "obligationDigest",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

/** Pure, workflow-safe validation for the bounded Temporal receipt reference. */
export function parseTurnPersistenceHandoff(value: unknown): TurnPersistenceHandoff | null {
  if (!isRecord(value)) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(serialized).byteLength > TURN_PERSISTENCE_HANDOFF_MAX_BYTES) {
    return null;
  }
  if (
    Object.keys(value).length !== HANDOFF_KEYS.size ||
    Object.keys(value).some((key) => !HANDOFF_KEYS.has(key)) ||
    value.version !== 2 ||
    !isNonEmptyString(value.receiptId) ||
    !UUID_PATTERN.test(value.receiptId) ||
    !isNonEmptyString(value.turnId) ||
    !UUID_PATTERN.test(value.turnId) ||
    !isNonEmptyString(value.triggerEventId) ||
    !UUID_PATTERN.test(value.triggerEventId) ||
    !isPositiveSafeInteger(value.executionGeneration) ||
    !isNonEmptyString(value.attemptId) ||
    !UUID_PATTERN.test(value.attemptId) ||
    !["pending_tool_call", "model_call", "context_compaction"].includes(
      String(value.obligationKind),
    ) ||
    typeof value.obligationDigest !== "string" ||
    !DIGEST_PATTERN.test(value.obligationDigest)
  ) {
    return null;
  }
  return value as TurnPersistenceHandoff;
}

/** Distinguish an absent heartbeat receipt from corrupt receipt bytes. */
export function turnPersistenceHandoffHeartbeatState(details: unknown): HandoffFieldState {
  if (!isRecord(details) || !("persistenceHandoff" in details)) return { state: "absent" };
  const handoff = parseTurnPersistenceHandoff(details.persistenceHandoff);
  return handoff ? { state: "valid", handoff } : { state: "invalid" };
}
