import { defineSchema } from "./define-schema";
import { z } from "zod";
import {
  GovernedLearningActivationReceipt,
  GovernedLearningActivationUndoReceipt,
  UndoGovernedLearningActivationRequest,
} from "./governed-learning-activation";
import { GovernedLearningDecisionReceipt } from "./governed-learning-evaluator";
import {
  WorkspaceLearningMode,
  WorkspaceLearningPolicyActivationEvent,
  WorkspaceLearningPolicyHead,
  WorkspaceLearningPolicyRevision,
  WorkspaceLearningSourceOverrideInput,
  WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS,
} from "./workspace-learning-policy";

export const WORKSPACE_LEARNING_HISTORY_MAX_ITEMS = 100;

export const WorkspaceLearningPolicyHistoryQuery = /* @__PURE__ */ defineSchema(() =>
  z.object({
    limit: z.coerce.number().int().min(1).max(WORKSPACE_LEARNING_HISTORY_MAX_ITEMS).default(50),
  }),
);
export type WorkspaceLearningPolicyHistoryQuery = z.infer<
  typeof WorkspaceLearningPolicyHistoryQuery
>;

export const CreateWorkspaceLearningPolicyRevisionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: z.string().uuid().optional(),
      workspaceMode: WorkspaceLearningMode,
      sourceOverrides: z.array(WorkspaceLearningSourceOverrideInput).optional().default([]),
      supersedesRevisionId: z.string().uuid().nullable().optional().default(null),
    })
    .strict(),
);
export type CreateWorkspaceLearningPolicyRevisionRequest = z.infer<
  typeof CreateWorkspaceLearningPolicyRevisionRequest
>;

export const ActivateWorkspaceLearningPolicyRevisionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: z.string().uuid().optional(),
      expectedCurrentRevisionId: z.string().uuid().nullable(),
      expectedActivationVersion: z.number().int().nonnegative(),
      reason: z.string().trim().min(1).max(WORKSPACE_LEARNING_POLICY_REASON_MAX_CHARS),
    })
    .strict(),
);
export type ActivateWorkspaceLearningPolicyRevisionRequest = z.infer<
  typeof ActivateWorkspaceLearningPolicyRevisionRequest
>;

export const RollbackWorkspaceLearningPolicyRevisionRequest =
  /* @__PURE__ */ defineSchema(() =>
    ActivateWorkspaceLearningPolicyRevisionRequest.extend({
      targetRevisionId: z.string().uuid(),
      expectedCurrentRevisionId: z.string().uuid(),
    }).strict(),
  );
export type RollbackWorkspaceLearningPolicyRevisionRequest = z.infer<
  typeof RollbackWorkspaceLearningPolicyRevisionRequest
>;

export const WorkspaceLearningPolicyMutationResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      head: WorkspaceLearningPolicyHead,
      event: WorkspaceLearningPolicyActivationEvent,
    })
    .strict(),
);
export type WorkspaceLearningPolicyMutationResponse = z.infer<
  typeof WorkspaceLearningPolicyMutationResponse
>;

export const UndoGovernedLearningActivationHttpRequest = /* @__PURE__ */ defineSchema(() =>
  UndoGovernedLearningActivationRequest.pick({ operationId: true }).partial(),
);
export type UndoGovernedLearningActivationHttpRequest = z.infer<
  typeof UndoGovernedLearningActivationHttpRequest
>;

export const WorkspaceLearningHistoryResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      head: WorkspaceLearningPolicyHead.nullable(),
      revisions: z.array(WorkspaceLearningPolicyRevision),
      policyEvents: z.array(WorkspaceLearningPolicyActivationEvent),
      decisions: z.array(GovernedLearningDecisionReceipt),
      activations: z.array(GovernedLearningActivationReceipt),
      undos: z.array(GovernedLearningActivationUndoReceipt),
      truncated: z.boolean(),
      effectiveBoundary: z.literal("next_accepted_attempt"),
    })
    .strict(),
);
export type WorkspaceLearningHistoryResponse = z.infer<typeof WorkspaceLearningHistoryResponse>;
