import { z } from "zod";
import {
  PREFERENCE_REGISTRY_CONTENT_MAX_CHARS,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  PreferenceRegistryConflictStrategy,
  PreferenceRegistryStableKey,
} from "./preference-registry";
import {
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  WorkspaceInstructionPolicyTarget,
} from "./workspace-instruction-policies";
import { WorkspaceLearningPolicyEffectiveMode } from "./workspace-learning-policy";

const boundedReason = z.string().trim().min(1).max(4_096);
const operationId = z.string().uuid();
const exactEvidence = {
  claimId: z.string().uuid(),
  evidenceId: z.string().uuid(),
};

/** Exact accepted-attempt authority. It is validated again inside the write transaction. */
export const CompanyBrainGovernedWriteAttempt = z
  .object({
    accountId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    sessionId: z.string().uuid(),
    turnId: z.string().uuid(),
    attemptId: z.string().uuid(),
    executionGeneration: z.number().int().positive(),
  })
  .strict();
export type CompanyBrainGovernedWriteAttempt = z.infer<typeof CompanyBrainGovernedWriteAttempt>;

export const ProposeWorkspaceKnowledgeClaimRequest = z
  .object({
    kind: z.literal("propose_knowledge"),
    operationId,
    ...exactEvidence,
    reason: boundedReason,
  })
  .strict();
export type ProposeWorkspaceKnowledgeClaimRequest = z.infer<
  typeof ProposeWorkspaceKnowledgeClaimRequest
>;

export const CorrectWorkspaceKnowledgeClaimRequest = z
  .object({
    kind: z.literal("correct_knowledge"),
    operationId,
    ...exactEvidence,
    replacesClaimId: z.string().uuid(),
    reason: boundedReason,
  })
  .strict();
export type CorrectWorkspaceKnowledgeClaimRequest = z.infer<
  typeof CorrectWorkspaceKnowledgeClaimRequest
>;

/**
 * Promote one still-active task-tree note into a normalized, workspace-local
 * Knowledge claim proposal. The note text is the exact fact value and source
 * evidence; callers may describe the subject and predicate but cannot widen
 * authority or supply replacement source bytes.
 */
export const PromoteTaskNoteKnowledgeRequest = z
  .object({
    kind: z.literal("promote_task_note_knowledge"),
    operationId,
    noteId: z.string().uuid(),
    expectedNoteVersion: z.literal(1),
    entityType: z
      .string()
      .trim()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    normalizedKey: z.string().trim().min(1).max(512),
    displayName: z.string().trim().min(1).max(512),
    predicateKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    confidenceBps: z.number().int().min(0).max(10_000),
    reason: boundedReason,
  })
  .strict();
export type PromoteTaskNoteKnowledgeRequest = z.infer<typeof PromoteTaskNoteKnowledgeRequest>;

export const ProposeWorkspaceInstructionPolicyRequest = z
  .strictObject({
    kind: z.literal("propose_instruction_policy"),
    operationId,
    ...exactEvidence,
    target: WorkspaceInstructionPolicyTarget,
    content: z
      .string()
      .min(1)
      .max(WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS)
      .refine((value) => value.trim().length > 0, "instruction proposal must not be blank"),
    expectedCurrentRevisionId: z.string().uuid().nullable(),
    expectedActivationVersion: z.number().int().nonnegative(),
    reason: boundedReason,
  })
  .superRefine((value, context) => {
    const target = WorkspaceInstructionPolicyTarget.safeParse(value.target);
    if (!target.success) {
      for (const issue of target.error.issues) {
        context.addIssue({ ...issue, path: ["target", ...issue.path] });
      }
    }
  });
export type ProposeWorkspaceInstructionPolicyRequest = z.infer<
  typeof ProposeWorkspaceInstructionPolicyRequest
>;

export const ProposeWorkspacePreferenceRequest = z.strictObject({
  kind: z.literal("propose_preference"),
  operationId,
  ...exactEvidence,
  stableKey: PreferenceRegistryStableKey.max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
  title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
  description: z.string().trim().min(1).max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
  content: z
    .string()
    .min(1)
    .max(PREFERENCE_REGISTRY_CONTENT_MAX_CHARS)
    .refine((value) => value.trim().length > 0, "preference proposal must not be blank"),
  precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
  conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
  conflictsWith: z.array(PreferenceRegistryStableKey).max(32).default([]),
  expiresAt: z.string().datetime({ offset: true }).nullable().default(null),
  reason: boundedReason,
});
export type ProposeWorkspacePreferenceRequest = z.infer<typeof ProposeWorkspacePreferenceRequest>;

/**
 * Destination selection is explicit and structured. There is deliberately no
 * generic "remember" operation, classifier, personal scope, or active authority.
 */
export const CompanyBrainGovernedWriteRequest = z.discriminatedUnion("kind", [
  ProposeWorkspaceKnowledgeClaimRequest,
  CorrectWorkspaceKnowledgeClaimRequest,
  PromoteTaskNoteKnowledgeRequest,
  ProposeWorkspaceInstructionPolicyRequest,
  ProposeWorkspacePreferenceRequest,
]);
export type CompanyBrainGovernedWriteRequest = z.infer<typeof CompanyBrainGovernedWriteRequest>;

export const CompanyBrainGovernedWriteDestination = z.enum([
  "knowledge",
  "instruction_policy",
  "preference",
]);
export type CompanyBrainGovernedWriteDestination = z.infer<
  typeof CompanyBrainGovernedWriteDestination
>;

export const CompanyBrainGovernedWriteReceipt = z.object({
  operationId,
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  workspaceId: z.string().uuid(),
  destination: CompanyBrainGovernedWriteDestination,
  outcome: z.literal("proposed"),
  claimId: z.string().uuid(),
  evidenceId: z.string().uuid(),
  relationId: z.string().uuid().nullable(),
  reviewId: z.string().uuid().nullable(),
  knowledgeChangeProposalId: z.string().uuid().nullable(),
  destinationProposalId: z.string().uuid().nullable(),
  destinationRevisionId: z.string().uuid().nullable(),
  taskNoteSource: z
    .object({
      noteId: z.string().uuid(),
      rootSessionId: z.string().uuid(),
      noteVersion: z.literal(1),
      textHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .nullable()
    .optional(),
  effectiveBoundary: z.literal("human_review_required"),
  rollback: z.object({
    supported: z.literal(false),
    mechanism: z.literal("not_applicable_proposal_only"),
  }),
});
export type CompanyBrainGovernedWriteReceipt = z.infer<typeof CompanyBrainGovernedWriteReceipt>;

/**
 * Policy routing is deliberately separate from destination admission. The
 * immutable accepted-attempt snapshot decides whether derived evidence may
 * create a proposal; the destination still owns activation and rollback.
 */
export const CompanyBrainLearningPolicyDecision = z.enum([
  "blocked",
  "proposal_created",
  "activation_requested",
]);
export type CompanyBrainLearningPolicyDecision = z.infer<typeof CompanyBrainLearningPolicyDecision>;

export const CompanyBrainLearningPolicyRouteReceipt = z.object({
  operationId,
  workspaceId: z.string().uuid(),
  effectivePolicy: WorkspaceLearningPolicyEffectiveMode,
  decision: CompanyBrainLearningPolicyDecision,
  write: CompanyBrainGovernedWriteReceipt.nullable(),
  activation: z.object({
    requested: z.boolean(),
    activated: z.literal(false),
    boundary: z.enum(["policy_off", "human_review", "destination_authority"]),
  }),
});
export type CompanyBrainLearningPolicyRouteReceipt = z.infer<
  typeof CompanyBrainLearningPolicyRouteReceipt
>;
