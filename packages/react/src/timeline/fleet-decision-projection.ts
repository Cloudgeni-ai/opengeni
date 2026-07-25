import type { SessionEvent } from "@opengeni/sdk";
import type { FleetDecisionItem, FleetDecisionScoreItem } from "./types";
import FleetDecisionRow from "./fleet-decision-row";

export { FleetDecisionRow };

const FLEET_ACTUAL_OUTCOMES = ["selected", "waiting", "none"] as const;
const FLEET_ACTUAL_REASONS = [
  "lease_reused",
  "pin",
  "rotation",
  "active",
  "all_capped",
  "none",
] as const;
const FLEET_SHADOW_OUTCOMES = ["selected", "paced", "none"] as const;
const FLEET_SHADOW_REASONS = [
  "fenced_in_flight",
  "fenced_candidate_missing",
  "admission_paced",
  "no_eligible_candidate",
  "overlay_isolated_empty",
  "best_score",
  "affinity_best",
  "hysteresis_hold",
] as const;
const FLEET_COMPARISONS = [
  "match",
  "different_candidate",
  "different_outcome",
  "not_comparable_truncated",
] as const;
const FLEET_CONFIDENCES = ["unknown", "low", "medium", "high"] as const;
const FLEET_ADMISSION_OUTCOMES = ["admit", "pace"] as const;
const FLEET_ADMISSION_REASONS = [
  "fenced_in_flight",
  "pacing_disabled",
  "capacity_unknown",
  "capacity_available",
  "work_conserving_borrow",
  "manager_priority",
  "standard_starvation_bound",
  "capacity_saturated",
  "emergency_fuse",
] as const;
const FLEET_PACED_ADMISSION_REASONS = new Set([
  "manager_priority",
  "capacity_saturated",
  "emergency_fuse",
]);
const FLEET_REJECTION_REASONS = [
  "allocator_disabled",
  "unavailable",
  "cooling",
  "quota_ceiling",
  "overlay_isolation",
] as const;
const FLEET_MAX_CANDIDATES = 32;
const FLEET_MAX_COUNT = 1_000_000;

/**
 * Project the identity-free fleet event into the deliberately smaller UI
 * contract. This is a trust boundary: session event payloads are untyped, so
 * arbitrary strings (fingerprints, provider errors, future metadata) must never
 * become renderable copy. Only fixed enums and event-local aliases cross it.
 */
export default function fleetDecisionItem(
  event: SessionEvent,
  payload: Record<string, unknown>,
): FleetDecisionItem | null {
  const actual = asRecord(payload.actual);
  const replay = asRecord(payload.replay);
  const input = asRecord(replay.input);
  const decision = asRecord(replay.decision);
  const admission = asRecord(decision.admission);
  if (
    payload.schemaVersion !== 1 ||
    payload.mode !== "shadow" ||
    replay.schemaVersion !== 1 ||
    replay.mode !== "shadow" ||
    replay.policyVersion !== "adaptive-shadow-v1"
  ) {
    return null;
  }

  const actualOutcome = fleetEnum(actual.outcome, FLEET_ACTUAL_OUTCOMES);
  const actualReason = fleetEnum(actual.reason, FLEET_ACTUAL_REASONS);
  const shadowOutcome = fleetEnum(decision.outcome, FLEET_SHADOW_OUTCOMES);
  const shadowReason = fleetEnum(decision.reason, FLEET_SHADOW_REASONS);
  const comparison = fleetEnum(payload.comparison, FLEET_COMPARISONS);
  const confidence = fleetEnum(decision.confidence, FLEET_CONFIDENCES);
  const admissionOutcome = fleetEnum(admission.outcome, FLEET_ADMISSION_OUTCOMES);
  const admissionReason = fleetEnum(admission.reason, FLEET_ADMISSION_REASONS);
  if (
    !actualOutcome ||
    !actualReason ||
    !shadowOutcome ||
    !shadowReason ||
    !comparison ||
    !confidence ||
    !admissionOutcome ||
    !admissionReason
  ) {
    return null;
  }
  if (
    typeof admission.borrowedIdleCapacity !== "boolean" ||
    typeof decision.borrowedOverlayCapacity !== "boolean"
  ) {
    return null;
  }

  const actualCandidateKey = fleetCandidateKey(actual.candidateKey);
  const shadowCandidateKey = fleetCandidateKey(decision.selectedCandidateKey);
  if (actualCandidateKey === undefined || shadowCandidateKey === undefined) {
    return null;
  }
  if (
    (actualOutcome === "selected") !== (actualCandidateKey !== null) ||
    (shadowOutcome === "selected") !== (shadowCandidateKey !== null)
  ) {
    return null;
  }

  const candidates = input.candidates;
  if (!Array.isArray(candidates) || candidates.length > FLEET_MAX_CANDIDATES) {
    return null;
  }
  const candidateKeys = new Set<string>();
  for (const candidate of candidates) {
    const key = asRecord(candidate).key;
    if (!isFleetCandidateAlias(key) || candidateKeys.has(key)) {
      return null;
    }
    candidateKeys.add(key);
  }

  const truncatedCandidateCount = fleetCount(replay.truncatedCandidateCount);
  const strandedEligibleCount = fleetCount(decision.strandedEligibleCount);
  if (
    truncatedCandidateCount === null ||
    strandedEligibleCount === null ||
    strandedEligibleCount > candidates.length ||
    !fleetDecisionSemanticsAreConsistent({
      actualOutcome,
      actualReason,
      shadowOutcome,
      shadowReason,
      admissionOutcome,
      admissionReason,
      borrowedIdleCapacity: admission.borrowedIdleCapacity,
      borrowedOverlayCapacity: decision.borrowedOverlayCapacity,
      strandedEligibleCount,
    })
  ) {
    return null;
  }
  if (shadowCandidateKey !== null && !candidateKeys.has(shadowCandidateKey)) {
    return null;
  }
  if (
    actualCandidateKey !== null &&
    !candidateKeys.has(actualCandidateKey) &&
    !(comparison === "not_comparable_truncated" && truncatedCandidateCount > 0)
  ) {
    return null;
  }
  if (
    comparison === "not_comparable_truncated" &&
    (truncatedCandidateCount === 0 ||
      actualCandidateKey === null ||
      candidateKeys.has(actualCandidateKey))
  ) {
    return null;
  }

  if (
    !fleetComparisonIsConsistent(
      comparison,
      actualOutcome,
      actualCandidateKey,
      shadowOutcome,
      shadowCandidateKey,
    )
  ) {
    return null;
  }

  const rawScores = decision.scores;
  if (!Array.isArray(rawScores)) {
    return null;
  }
  const scores: FleetDecisionScoreItem[] = [];
  const scoreKeys = new Set<string>();
  for (const value of rawScores.slice(0, FLEET_MAX_CANDIDATES)) {
    const score = asRecord(value);
    const candidateKey = score.candidateKey;
    const parsedRejectionReason =
      score.rejectionReason === null
        ? null
        : fleetEnum(score.rejectionReason, FLEET_REJECTION_REASONS);
    if (score.rejectionReason !== null && parsedRejectionReason === null) {
      return null;
    }
    const rejectionReason = parsedRejectionReason;
    const total = fleetFiniteNumber(score.total);
    const scoreConfidence = fleetEnum(score.confidence, FLEET_CONFIDENCES);
    if (
      !isFleetCandidateAlias(candidateKey) ||
      !candidateKeys.has(candidateKey) ||
      scoreKeys.has(candidateKey) ||
      typeof score.eligible !== "boolean" ||
      total === null ||
      !scoreConfidence ||
      (score.eligible ? rejectionReason !== null : rejectionReason === null)
    ) {
      return null;
    }
    scoreKeys.add(candidateKey);
    scores.push({
      candidateKey,
      eligible: score.eligible,
      rejectionReason,
      total,
      confidence: scoreConfidence,
    });
  }
  if (shadowCandidateKey !== null && !scoreKeys.has(shadowCandidateKey)) {
    return null;
  }

  return {
    kind: "fleet-decision",
    id: event.id,
    turnId: event.turnId ?? null,
    policyVersion: "adaptive-shadow-v1",
    actualOutcome,
    actualCandidateKey,
    actualReason,
    shadowOutcome,
    shadowCandidateKey,
    shadowReason,
    comparison,
    confidence,
    admissionOutcome,
    admissionReason,
    borrowedIdleCapacity: admission.borrowedIdleCapacity,
    borrowedOverlayCapacity: decision.borrowedOverlayCapacity,
    strandedEligibleCount,
    candidateCount: candidates.length,
    truncatedCandidateCount,
    scoreRowsTruncatedCount: Math.max(0, rawScores.length - FLEET_MAX_CANDIDATES),
    scores,
    occurredAt: event.occurredAt,
  };
}

function fleetEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as Values[number])
    : null;
}

/** c00..czz: ordinal aliases scoped to one event, never stable account ids. */
function isFleetCandidateAlias(value: unknown): value is string {
  return typeof value === "string" && /^c[0-9a-z]{2}$/.test(value);
}

/** `undefined` denotes malformed; `null` is a valid no-selection value. */
function fleetCandidateKey(value: unknown): string | null | undefined {
  return value === null ? null : isFleetCandidateAlias(value) ? value : undefined;
}

function fleetCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= FLEET_MAX_COUNT
    ? value
    : null;
}

function fleetFiniteNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function fleetComparisonIsConsistent(
  comparison: FleetDecisionItem["comparison"],
  actualOutcome: FleetDecisionItem["actualOutcome"],
  actualCandidateKey: string | null,
  shadowOutcome: FleetDecisionItem["shadowOutcome"],
  shadowCandidateKey: string | null,
): boolean {
  if (comparison === "not_comparable_truncated") {
    return actualOutcome === "selected" && actualCandidateKey !== null;
  }
  const comparableActualOutcome = actualOutcome === "selected" ? "selected" : "none";
  const comparableShadowOutcome = shadowOutcome === "selected" ? "selected" : "none";
  if (comparison === "different_outcome") {
    return comparableActualOutcome !== comparableShadowOutcome;
  }
  if (comparableActualOutcome !== comparableShadowOutcome) {
    return false;
  }
  if (comparison === "different_candidate") {
    return comparableActualOutcome === "selected" && actualCandidateKey !== shadowCandidateKey;
  }
  return comparableActualOutcome !== "selected" || actualCandidateKey === shadowCandidateKey;
}

function fleetDecisionSemanticsAreConsistent(input: {
  actualOutcome: FleetDecisionItem["actualOutcome"];
  actualReason: FleetDecisionItem["actualReason"];
  shadowOutcome: FleetDecisionItem["shadowOutcome"];
  shadowReason: FleetDecisionItem["shadowReason"];
  admissionOutcome: FleetDecisionItem["admissionOutcome"];
  admissionReason: FleetDecisionItem["admissionReason"];
  borrowedIdleCapacity: boolean;
  borrowedOverlayCapacity: boolean;
  strandedEligibleCount: number;
}): boolean {
  const actualConsistent =
    input.actualOutcome === "selected"
      ? ["lease_reused", "pin", "rotation", "active"].includes(input.actualReason)
      : input.actualOutcome === "waiting"
        ? input.actualReason === "all_capped"
        : input.actualReason === "none";
  const shadowConsistent =
    input.shadowOutcome === "selected"
      ? ["fenced_in_flight", "best_score", "affinity_best", "hysteresis_hold"].includes(
          input.shadowReason,
        )
      : input.shadowOutcome === "paced"
        ? input.shadowReason === "admission_paced"
        : ["fenced_candidate_missing", "no_eligible_candidate", "overlay_isolated_empty"].includes(
            input.shadowReason,
          );
  // Keep this mapping exhaustive so a newly accepted admission reason cannot
  // silently be dropped from the paced/admitted event consistency check.
  const pacedAdmissionReason = FLEET_PACED_ADMISSION_REASONS.has(input.admissionReason);
  return (
    actualConsistent &&
    shadowConsistent &&
    (input.admissionOutcome === "pace") === pacedAdmissionReason &&
    (input.shadowOutcome === "paced") === (input.admissionOutcome === "pace") &&
    input.borrowedIdleCapacity === (input.admissionReason === "work_conserving_borrow") &&
    (!input.borrowedOverlayCapacity ||
      (input.shadowOutcome === "selected" && input.strandedEligibleCount === 0))
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
