import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const boundedActor = z.string().trim().min(1).max(1_024);

export const GovernedLearningActivationDestination = z.enum(["instruction_policy", "preference"]);
export type GovernedLearningActivationDestination = z.infer<
  typeof GovernedLearningActivationDestination
>;

export const GovernedLearningActivationCaller = z
  .object({
    workspaceId: z.string().uuid(),
    subjectId: boundedActor,
  })
  .strict();
export type GovernedLearningActivationCaller = z.infer<typeof GovernedLearningActivationCaller>;

export const ActivateGovernedLearningDecisionRequest = z
  .object({
    operationId: z.string().uuid(),
    decisionReceiptId: z.string().uuid(),
  })
  .strict();
export type ActivateGovernedLearningDecisionRequest = z.infer<
  typeof ActivateGovernedLearningDecisionRequest
>;

export const UndoGovernedLearningActivationRequest = z
  .object({
    operationId: z.string().uuid(),
    activationReceiptId: z.string().uuid(),
  })
  .strict();
export type UndoGovernedLearningActivationRequest = z.infer<
  typeof UndoGovernedLearningActivationRequest
>;

const destinationBoundary = {
  destination: GovernedLearningActivationDestination,
  destinationProposalId: z.string().uuid(),
  destinationRevisionId: z.string().uuid(),
  destinationOldRevisionId: z.string().uuid().nullable(),
  destinationOldContentHash: sha256.nullable(),
  destinationOldVersion: z.number().int().nonnegative(),
  destinationNewContentHash: sha256,
  destinationNewVersion: z.number().int().positive(),
  destinationEventId: z.string().uuid(),
};

/**
 * Immutable content-free proof that one final automatic evaluator receipt was
 * revalidated and applied through the destination-owned lifecycle.
 */
export const GovernedLearningActivationReceipt = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    inputHash: sha256,
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    decisionReceiptId: z.string().uuid(),
    initiatingHumanSubjectId: boundedActor,
    serviceActorSubjectId: boundedActor,
    policyRevisionId: z.string().uuid(),
    policyHash: sha256,
    policyActivationVersion: z.number().int().positive(),
    sourceKind: z.enum(["scoped-knowledge-evidence", "task-note"]),
    sourceId: z.string().uuid(),
    sourceAuthorityHash: sha256,
    proposalId: z.string().uuid(),
    claimId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    knowledgePreviousReviewId: z.string().uuid(),
    knowledgePreviousReviewRevision: z.number().int().positive(),
    knowledgeApprovalReviewId: z.string().uuid(),
    knowledgeApprovalReviewRevision: z.number().int().positive(),
    knowledgeApprovalInputHash: sha256,
    ...destinationBoundary,
    outcome: z.literal("activated"),
    effectiveAt: z.string().datetime(),
    rollback: z
      .object({
        supported: z.literal(true),
        mechanism: z.literal("exact_head_and_latest_review"),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GovernedLearningActivationReceipt = z.infer<typeof GovernedLearningActivationReceipt>;

/** Append-only compensation proof. Undo never deletes prior evidence. */
export const GovernedLearningActivationUndoReceipt = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    inputHash: sha256,
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    activationReceiptId: z.string().uuid(),
    initiatingHumanSubjectId: boundedActor,
    serviceActorSubjectId: boundedActor,
    destination: GovernedLearningActivationDestination,
    knowledgeApprovalReviewId: z.string().uuid(),
    knowledgeRevocationReviewId: z.string().uuid(),
    knowledgeRevocationReviewRevision: z.number().int().positive(),
    knowledgeRevocationInputHash: sha256,
    destinationActivatedRevisionId: z.string().uuid(),
    destinationRestoredRevisionId: z.string().uuid().nullable(),
    destinationActivatedContentHash: sha256,
    destinationRestoredContentHash: sha256.nullable(),
    destinationOldVersion: z.number().int().positive(),
    destinationNewVersion: z.number().int().positive(),
    destinationEventId: z.string().uuid(),
    outcome: z.literal("undone"),
    superseded: z.literal(false),
    effectiveAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type GovernedLearningActivationUndoReceipt = z.infer<
  typeof GovernedLearningActivationUndoReceipt
>;
