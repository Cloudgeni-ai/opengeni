import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";

const sha256 = /* @__PURE__ */ defineSchema(() => primitives.string.regex(/^[0-9a-f]{64}$/));
const boundedActor = /* @__PURE__ */ defineSchema(() => primitives.string.trim().min(1).max(1_024));

export const GovernedLearningActivationDestination = /* @__PURE__ */ defineSchema(() =>
  z.enum(["instruction_policy", "preference"]),
);
export const GovernedLearningActivationAuthorityKind = /* @__PURE__ */ defineSchema(() =>
  z.enum(["automatic", "human_confirmed"]),
);
export type GovernedLearningActivationAuthorityKind = z.infer<
  typeof GovernedLearningActivationAuthorityKind
>;
export type GovernedLearningActivationDestination = z.infer<
  typeof GovernedLearningActivationDestination
>;

export const GovernedLearningActivationCaller = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      workspaceId: primitives.uuid,
      subjectId: boundedActor,
    })
    .strict(),
);
export type GovernedLearningActivationCaller = z.infer<typeof GovernedLearningActivationCaller>;

export const ActivateGovernedLearningDecisionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      decisionReceiptId: primitives.uuid,
    })
    .strict(),
);
export type ActivateGovernedLearningDecisionRequest = z.infer<
  typeof ActivateGovernedLearningDecisionRequest
>;

export const UndoGovernedLearningActivationRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      activationReceiptId: primitives.uuid,
    })
    .strict(),
);
export type UndoGovernedLearningActivationRequest = z.infer<
  typeof UndoGovernedLearningActivationRequest
>;

const destinationBoundary = {
  destination: GovernedLearningActivationDestination,
  destinationProposalId: primitives.uuid,
  destinationRevisionId: primitives.uuid,
  destinationOldRevisionId: primitives.nullableUuid,
  destinationOldContentHash: sha256.nullable(),
  destinationOldVersion: primitives.nonnegativeInteger,
  destinationNewContentHash: sha256,
  destinationNewVersion: primitives.positiveInteger,
  destinationEventId: primitives.uuid,
};

/**
 * Immutable content-free proof that one final automatic evaluator receipt was
 * revalidated and applied through the destination-owned lifecycle.
 */
export const GovernedLearningActivationReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      operationId: primitives.uuid,
      inputHash: sha256,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      decisionReceiptId: primitives.uuid,
      initiatingHumanSubjectId: boundedActor,
      serviceActorSubjectId: boundedActor,
      policyRevisionId: primitives.uuid,
      policyHash: sha256,
      policyActivationVersion: primitives.positiveInteger,
      sourceKind: z.enum(["scoped-knowledge-evidence", "task-note"]),
      sourceId: primitives.uuid,
      sourceAuthorityHash: sha256,
      proposalId: primitives.uuid,
      claimId: primitives.uuid,
      evidenceId: primitives.uuid,
      knowledgePreviousReviewId: primitives.uuid,
      knowledgePreviousReviewRevision: primitives.positiveInteger,
      knowledgeApprovalReviewId: primitives.uuid,
      knowledgeApprovalReviewRevision: primitives.positiveInteger,
      knowledgeApprovalInputHash: sha256,
      ...destinationBoundary,
      outcome: z.literal("activated"),
      effectiveAt: primitives.dateTime,
      /**
       * `automatic`: a final eligible evaluator receipt under an automatic policy.
       * `human_confirmed`: the exact initiating human answered the bound
       * `remember:<proposalId>` structured human-input question with `save`.
       */
      authorityKind: GovernedLearningActivationAuthorityKind,
      humanInputRequestId: primitives.nullableUuid,
      rollback: z
        .object({
          supported: z.literal(true),
          mechanism: z.literal("exact_head_and_latest_review"),
        })
        .strict(),
      createdAt: primitives.dateTime,
    })
    .strict(),
);
export type GovernedLearningActivationReceipt = z.infer<typeof GovernedLearningActivationReceipt>;

export const ActivateHumanConfirmedLearningDecisionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      decisionReceiptId: primitives.uuid,
      humanInputRequestId: primitives.uuid,
    })
    .strict(),
);
export type ActivateHumanConfirmedLearningDecisionRequest = z.infer<
  typeof ActivateHumanConfirmedLearningDecisionRequest
>;

/** Append-only compensation proof. Undo never deletes prior evidence. */
export const GovernedLearningActivationUndoReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      operationId: primitives.uuid,
      inputHash: sha256,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      activationReceiptId: primitives.uuid,
      initiatingHumanSubjectId: boundedActor,
      serviceActorSubjectId: boundedActor,
      destination: GovernedLearningActivationDestination,
      knowledgeApprovalReviewId: primitives.uuid,
      knowledgeRevocationReviewId: primitives.uuid,
      knowledgeRevocationReviewRevision: primitives.positiveInteger,
      knowledgeRevocationInputHash: sha256,
      destinationActivatedRevisionId: primitives.uuid,
      destinationRestoredRevisionId: primitives.nullableUuid,
      destinationActivatedContentHash: sha256,
      destinationRestoredContentHash: sha256.nullable(),
      destinationOldVersion: primitives.positiveInteger,
      destinationNewVersion: primitives.positiveInteger,
      destinationEventId: primitives.uuid,
      outcome: z.literal("undone"),
      superseded: z.literal(false),
      effectiveAt: primitives.dateTime,
      createdAt: primitives.dateTime,
    })
    .strict(),
);
export type GovernedLearningActivationUndoReceipt = z.infer<
  typeof GovernedLearningActivationUndoReceipt
>;

/**
 * Immutable content-free proof that the exact initiating human confirmed a
 * user-directed Knowledge claim (`remember` with lane `knowledge`) through the
 * bound structured human-input question, after which the claim's latest
 * `proposed` review was superseded by an `approved` service review.
 */
export const RememberKnowledgeConfirmationReceipt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      id: primitives.uuid,
      operationId: primitives.uuid,
      inputHash: sha256,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      turnId: primitives.uuid,
      executionGeneration: primitives.positiveInteger,
      initiatingHumanSubjectId: boundedActor,
      serviceActorSubjectId: boundedActor,
      claimId: primitives.uuid,
      evidenceId: primitives.uuid,
      taskNoteId: primitives.uuid,
      taskNoteTextHash: sha256,
      humanInputRequestId: primitives.uuid,
      previousReviewId: primitives.uuid,
      previousReviewRevision: primitives.positiveInteger,
      approvalReviewId: primitives.uuid,
      approvalReviewRevision: primitives.positiveInteger,
      createdAt: primitives.dateTime,
    })
    .strict(),
);
export type RememberKnowledgeConfirmationReceipt = z.infer<
  typeof RememberKnowledgeConfirmationReceipt
>;

export const ConfirmRememberKnowledgeClaimRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      claimId: primitives.uuid,
      humanInputRequestId: primitives.uuid,
    })
    .strict(),
);
export type ConfirmRememberKnowledgeClaimRequest = z.infer<
  typeof ConfirmRememberKnowledgeClaimRequest
>;
