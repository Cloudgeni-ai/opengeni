import {
  DEFAULT_CODEX_FLEET_POLICY_V1,
  createCodexFleetReplayRecordV1,
  type CodexFleetCandidateStatus,
  type CodexFleetDecisionInputV1,
  type CodexFleetReplayRecordV1,
} from "@opengeni/contracts";
import type { CodexLeaseAccountStatus } from "@opengeni/db";

export const CODEX_FLEET_SHADOW_MAX_PAYLOAD_BYTES = 32_768;

export type CodexFleetActualDecisionV1 = {
  outcome: "selected" | "waiting" | "none";
  candidateKey: string | null;
  reason: "lease_reused" | "pin" | "rotation" | "active" | "all_capped" | "none";
};

export type CodexFleetShadowComparisonV1 =
  | "match"
  | "different_candidate"
  | "different_outcome"
  | "not_comparable_truncated";

export type CodexFleetShadowPayloadV1 = {
  schemaVersion: 1;
  mode: "shadow";
  actual: CodexFleetActualDecisionV1;
  comparison: CodexFleetShadowComparisonV1;
  replay: CodexFleetReplayRecordV1;
};

export type CodexFleetShadowBuildInputV1 = {
  accounts: readonly CodexLeaseAccountStatus[];
  actualCredentialId: string | null;
  actualOutcome: CodexFleetActualDecisionV1["outcome"];
  actualReason: CodexFleetActualDecisionV1["reason"];
  affinityCredentialId: string | null;
  fencedInFlight: boolean;
  nearExhaustionPct: number;
  now: Date;
};

export type CodexFleetShadowPublicationResultV1 =
  | { outcome: "disabled" }
  | {
      outcome: "published";
      payload: CodexFleetShadowPayloadV1;
      payloadBytes: number;
    }
  | {
      outcome: "failed";
      stage: "build" | "serialize" | "publish";
      reason: "payload_too_large" | "unexpected";
      errorName: string;
      payloadBytes: number | null;
    };

/**
 * Default-off, bounded, fail-open runtime seam for the shadow record.
 *
 * The typed result intentionally carries no error message: provider, database,
 * or transport errors can include private metadata. Callers may count/log only
 * the bounded stage, reason, name, and size fields returned here. A failure can
 * never replace or clear the credential already selected by OPE-21.
 */
export async function publishCodexFleetShadowDecisionV1(input: {
  enabled: boolean;
  decision: CodexFleetShadowBuildInputV1;
  publish: (
    events: Array<{ type: "codex.fleet.decision"; payload: CodexFleetShadowPayloadV1 }>,
  ) => Promise<unknown>;
}): Promise<CodexFleetShadowPublicationResultV1> {
  if (!input.enabled) return { outcome: "disabled" };

  let stage: "build" | "serialize" | "publish" = "build";
  let payloadBytes: number | null = null;
  try {
    const payload = buildCodexFleetShadowPayloadV1(input.decision);
    stage = "serialize";
    payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (payloadBytes > CODEX_FLEET_SHADOW_MAX_PAYLOAD_BYTES) {
      return {
        outcome: "failed",
        stage,
        reason: "payload_too_large",
        errorName: "CodexFleetShadowPayloadTooLargeError",
        payloadBytes,
      };
    }
    stage = "publish";
    await input.publish([{ type: "codex.fleet.decision", payload }]);
    return { outcome: "published", payload, payloadBytes };
  } catch (error) {
    return {
      outcome: "failed",
      stage,
      reason: "unexpected",
      errorName: safeErrorName(error),
      payloadBytes,
    };
  }
}

export function buildCodexFleetShadowPayloadV1(
  input: CodexFleetShadowBuildInputV1,
): CodexFleetShadowPayloadV1 {
  // OPE-21 returns candidates in stable created_at/id order. Alias only by that
  // event-local ordinal: no raw id or stable cross-event account tag is persisted.
  const aliases = new Map(
    input.accounts.map((account, index) => [account.id, candidateAlias(index)] as const),
  );
  const actualCandidateKey = input.actualCredentialId
    ? (aliases.get(input.actualCredentialId) ?? null)
    : null;
  const currentCandidateKey = input.affinityCredentialId
    ? (aliases.get(input.affinityCredentialId) ?? null)
    : null;
  const decisionInput: CodexFleetDecisionInputV1 = {
    observedAtMs: input.now.getTime(),
    request: {
      placement: input.fencedInFlight ? "fenced_in_flight" : "new",
      priority: "standard",
      currentCandidateKey: input.fencedInFlight ? actualCandidateKey : currentCandidateKey,
      waitAgeMs: 0,
      overlayKey: null,
      overlayMode: "none",
    },
    admission: {
      // OPE-32 does not invent hard capacity from account count. A later typed
      // admission snapshot supplies dynamic capacity; shadow v1 records unknown.
      dynamicCapacityUnits: null,
      inUseUnits: input.accounts.reduce((sum, account) => sum + account.activeLeaseCount, 0),
      queuedManagerCount: 0,
      emergencyFuseActive: false,
    },
    candidates: input.accounts.map((account, index) => ({
      key: candidateAlias(index),
      status: normalizeStatus(account.status),
      allocatorEnabled: account.allocatorEnabled,
      cooldownRemainingMs: remainingMs(account.exhaustedUntil, input.now),
      activeLeaseCount: account.activeLeaseCount,
      quota: {
        primary: {
          usedPercent: account.primaryUsedPercent,
          resetRemainingMs: remainingMs(account.primaryResetAt, input.now),
        },
        secondary: {
          usedPercent: account.secondaryUsedPercent,
          resetRemainingMs: remainingMs(account.secondaryResetAt, input.now),
        },
        checkedAgeMs: ageMs(account.usageCheckedAt, input.now),
        confidence: account.usageCheckedAt ? "high" : "unknown",
      },
      // Current production cache evidence is aggregate metric + opaque log data,
      // not allocator state. Preserve that gap as unknown instead of fabricating 0.
      cache: {
        hitRatio: null,
        sampledTokens: null,
        checkedAgeMs: null,
        confidence: "unknown",
      },
      // OPE-24/provider accounting has not supplied a typed burn observation yet.
      // Unknown inference is explicit and contributes no fabricated tenant truth.
      inferredUnexplainedBurn: { percentPerHour: null, confidence: "unknown" },
      overlayKeys: [],
    })),
  };
  const replay = createCodexFleetReplayRecordV1(decisionInput, {
    ...DEFAULT_CODEX_FLEET_POLICY_V1,
    placementUsageCeilingPercent: input.nearExhaustionPct,
  });
  const actual: CodexFleetActualDecisionV1 = {
    outcome: input.actualOutcome,
    candidateKey: actualCandidateKey,
    reason: input.actualReason,
  };
  return {
    schemaVersion: 1,
    mode: "shadow",
    actual,
    comparison: compareDecision(actual, replay),
    replay,
  };
}

function compareDecision(
  actual: CodexFleetActualDecisionV1,
  replay: CodexFleetReplayRecordV1,
): CodexFleetShadowComparisonV1 {
  if (
    replay.truncatedCandidateCount > 0 &&
    actual.candidateKey !== null &&
    !replay.input.candidates.some((candidate) => candidate.key === actual.candidateKey)
  ) {
    return "not_comparable_truncated";
  }
  const shadowOutcome = replay.decision.outcome === "selected" ? "selected" : "none";
  const actualComparableOutcome = actual.outcome === "selected" ? "selected" : "none";
  if (shadowOutcome !== actualComparableOutcome) return "different_outcome";
  if (shadowOutcome === "selected") {
    return replay.decision.selectedCandidateKey === actual.candidateKey
      ? "match"
      : "different_candidate";
  }
  return "match";
}

function normalizeStatus(status: string): CodexFleetCandidateStatus {
  if (status === "active" || status === "needs_relogin" || status === "error") return status;
  return "unknown";
}

function candidateAlias(index: number): string {
  return `c${index.toString(36).padStart(2, "0")}`;
}

function remainingMs(value: Date | null, now: Date): number | null {
  return value ? Math.max(0, value.getTime() - now.getTime()) : null;
}

function ageMs(value: Date | null, now: Date): number | null {
  return value ? Math.max(0, now.getTime() - value.getTime()) : null;
}

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name) ? error.name : "Error";
}
