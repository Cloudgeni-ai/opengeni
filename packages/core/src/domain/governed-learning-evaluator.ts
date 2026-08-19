import {
  GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS,
  GovernedLearningDecision,
  GovernedLearningDecisionFacts,
  type GovernedLearningDecision as GovernedLearningDecisionType,
  type GovernedLearningDecisionFacts as GovernedLearningDecisionFactsType,
  type GovernedLearningDecisionReason,
} from "@opengeni/contracts";

/**
 * Pure, closed evaluator mirrored by the 0268 database authority. It never
 * receives source content and cannot activate a destination authority.
 */
export function deriveGovernedLearningDecision(
  input: GovernedLearningDecisionFactsType,
): GovernedLearningDecisionType {
  const facts = GovernedLearningDecisionFacts.parse(input);
  const reasons: GovernedLearningDecisionReason[] = [];

  if (facts.effectiveMode === "off") reasons.push("policy_off");
  if (facts.revoked) reasons.push("evidence_revoked");
  if (facts.stale) reasons.push("proposal_stale");
  if (facts.conflictCount > 0) reasons.push("evidence_conflict");
  if (facts.confidenceBps < GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS) {
    reasons.push("confidence_below_floor");
  }
  if (facts.effectiveMode === "suggest") reasons.push("policy_suggest");
  if (facts.effectiveMode === "automatic") reasons.push("policy_automatic");

  const outcome =
    facts.effectiveMode === "off"
      ? "off"
      : facts.revoked
        ? "revoked"
        : facts.stale
          ? "stale"
          : facts.conflictCount > 0
            ? "conflict"
            : facts.confidenceBps < GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS
              ? "confidence"
              : facts.effectiveMode;

  return GovernedLearningDecision.parse({
    outcome,
    reasons,
    automaticEligible: outcome === "automatic",
    confidenceFloorBps: GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS,
  });
}
