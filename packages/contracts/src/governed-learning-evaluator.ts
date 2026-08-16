import { z } from "zod";
import { WorkspaceLearningMode } from "./workspace-learning-policy";

/**
 * Automatic is intentionally conservative in the first evaluator tranche.
 * This constant is platform-owned rather than caller-selectable so an agent or
 * connector cannot lower the admission floor inside one request.
 */
export const GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS = 8_500;
export const GOVERNED_LEARNING_MAX_CONFLICT_COUNT = 1_000;

export const GovernedLearningDecisionOutcome = z.enum([
  "off",
  "suggest",
  "automatic",
  "confidence",
  "conflict",
  "stale",
  "revoked",
]);
export type GovernedLearningDecisionOutcome = z.infer<typeof GovernedLearningDecisionOutcome>;

/** Stable order used by TypeScript, SQL constraints, and public receipts. */
export const GOVERNED_LEARNING_REASON_ORDER = [
  "policy_off",
  "evidence_revoked",
  "proposal_stale",
  "evidence_conflict",
  "confidence_below_floor",
  "policy_suggest",
  "policy_automatic",
] as const;

export const GovernedLearningDecisionReason = z.enum(GOVERNED_LEARNING_REASON_ORDER);
export type GovernedLearningDecisionReason = z.infer<typeof GovernedLearningDecisionReason>;

export const GovernedLearningDecisionFacts = z
  .object({
    effectiveMode: WorkspaceLearningMode,
    confidenceBps: z.number().int().min(0).max(10_000),
    conflictCount: z.number().int().min(0).max(GOVERNED_LEARNING_MAX_CONFLICT_COUNT),
    stale: z.boolean(),
    revoked: z.boolean(),
  })
  .strict();
export type GovernedLearningDecisionFacts = z.infer<typeof GovernedLearningDecisionFacts>;

export const GovernedLearningDecision = z
  .object({
    outcome: GovernedLearningDecisionOutcome,
    reasons: z
      .array(GovernedLearningDecisionReason)
      .min(1)
      .max(GOVERNED_LEARNING_REASON_ORDER.length),
    automaticEligible: z.boolean(),
    confidenceFloorBps: z.literal(GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.automaticEligible !== (decision.outcome === "automatic")) {
      context.addIssue({
        code: "custom",
        path: ["automaticEligible"],
        message: "automatic eligibility must exactly match the automatic outcome",
      });
    }
    const indexes = decision.reasons.map((reason) =>
      GOVERNED_LEARNING_REASON_ORDER.indexOf(reason),
    );
    if (indexes.some((value, index) => index > 0 && value <= indexes[index - 1]!)) {
      context.addIssue({
        code: "custom",
        path: ["reasons"],
        message: "governed-learning reasons must be unique and in canonical order",
      });
    }
  });
export type GovernedLearningDecision = z.infer<typeof GovernedLearningDecision>;

export const GovernedLearningEvaluationAttempt = z
  .object({
    workspaceId: z.string().uuid(),
    subjectId: z.string().trim().min(1).max(1_024),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionGeneration: z.number().int().positive(),
  })
  .strict();
export type GovernedLearningEvaluationAttempt = z.infer<typeof GovernedLearningEvaluationAttempt>;

export const EvaluateGovernedLearningProposalRequest = z
  .object({
    operationId: z.string().uuid(),
    policySnapshotId: z.string().uuid(),
    proposalId: z.string().uuid(),
    claimId: z.string().uuid(),
    evidenceId: z.string().uuid(),
  })
  .strict();
export type EvaluateGovernedLearningProposalRequest = z.infer<
  typeof EvaluateGovernedLearningProposalRequest
>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Content-free immutable evidence. Hashes and bounded enums identify exactly
 * what was evaluated without copying proposal, fact, citation, or note text.
 */
export const GovernedLearningDecisionReceipt = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    inputHash: sha256,
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionGeneration: z.number().int().positive(),
    initiatingHumanSubjectId: z.string().min(1).max(1_024),
    policySnapshotId: z.string().uuid(),
    policySnapshotHash: sha256,
    policyRevisionId: z.string().uuid().nullable(),
    policyActivationVersion: z.number().int().nonnegative(),
    sourceKind: z.enum(["scoped-knowledge-evidence", "task-note"]),
    sourceId: z.string().uuid(),
    proposalId: z.string().uuid(),
    proposalInputHash: sha256,
    proposalContentHash: sha256,
    claimId: z.string().uuid(),
    claimInputHash: sha256,
    evidenceId: z.string().uuid(),
    evidenceInputHash: sha256,
    evidenceContentHash: sha256,
    evidenceAuthorityHash: sha256,
    reviewRevision: z.number().int().positive(),
    reviewState: z.enum(["proposed", "approved", "rejected", "revoked"]),
    effectiveMode: WorkspaceLearningMode,
    confidenceBps: z.number().int().min(0).max(10_000),
    conflictCount: z.number().int().min(0).max(GOVERNED_LEARNING_MAX_CONFLICT_COUNT),
    outcome: GovernedLearningDecisionOutcome,
    reasons: z
      .array(GovernedLearningDecisionReason)
      .min(1)
      .max(GOVERNED_LEARNING_REASON_ORDER.length),
    automaticEligible: z.boolean(),
    confidenceFloorBps: z.literal(GOVERNED_LEARNING_AUTOMATIC_CONFIDENCE_FLOOR_BPS),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const decision = GovernedLearningDecision.safeParse({
      outcome: receipt.outcome,
      reasons: receipt.reasons,
      automaticEligible: receipt.automaticEligible,
      confidenceFloorBps: receipt.confidenceFloorBps,
    });
    if (!decision.success) {
      for (const issue of decision.error.issues) {
        context.addIssue({ ...issue, path: issue.path });
      }
    }
    if (
      receipt.sourceKind === "scoped-knowledge-evidence" &&
      receipt.sourceId !== receipt.evidenceId
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceId"],
        message: "scoped-Knowledge evaluation must use its exact evidence id as the source id",
      });
    }
  });
export type GovernedLearningDecisionReceipt = z.infer<typeof GovernedLearningDecisionReceipt>;
