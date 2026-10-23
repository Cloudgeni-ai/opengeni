import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
} from "./agent-authored-durable-text";
import {
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  PreferenceRegistryConflictStrategy,
  PreferenceRegistryStableKey,
} from "./preference-registry";
import { GovernedLearningActivationDestination } from "./governed-learning-activation";
import {
  GovernedLearningDecisionOutcome,
  GovernedLearningDecisionReason,
} from "./governed-learning-evaluator";
import { WorkspaceInstructionPolicyTarget } from "./workspace-instruction-policies";
import { WorkspaceLearningPolicyEffectiveMode } from "./workspace-learning-policy";

const boundedReason = /* @__PURE__ */ defineSchema(() =>
  primitives.string.trim().min(1).max(4_096),
);
const operationId = /* @__PURE__ */ defineSchema(() => primitives.uuid);
const exactEvidence = {
  claimId: primitives.uuid,
  evidenceId: primitives.uuid,
};

/** Exact accepted-attempt authority. It is validated again inside the write transaction. */
export const CompanyBrainGovernedWriteAttempt = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      turnId: primitives.uuid,
      attemptId: primitives.uuid,
      executionGeneration: primitives.positiveInteger,
    })
    .strict(),
);
export type CompanyBrainGovernedWriteAttempt = z.infer<typeof CompanyBrainGovernedWriteAttempt>;

export const ProposeWorkspaceKnowledgeClaimRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("propose_knowledge"),
      operationId,
      ...exactEvidence,
      reason: boundedReason,
    })
    .strict(),
);
export type ProposeWorkspaceKnowledgeClaimRequest = z.infer<
  typeof ProposeWorkspaceKnowledgeClaimRequest
>;

export const CorrectWorkspaceKnowledgeClaimRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("correct_knowledge"),
      operationId,
      ...exactEvidence,
      replacesClaimId: primitives.uuid,
      reason: boundedReason,
    })
    .strict(),
);
export type CorrectWorkspaceKnowledgeClaimRequest = z.infer<
  typeof CorrectWorkspaceKnowledgeClaimRequest
>;

/**
 * Promote one still-active task-tree note into a normalized, workspace-local
 * Knowledge claim proposal. The note text is the exact fact value and source
 * evidence; callers may describe the subject and predicate but cannot widen
 * authority or supply replacement source bytes.
 */
export const PromoteTaskNoteKnowledgeRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.literal("promote_task_note_knowledge"),
      operationId,
      noteId: primitives.uuid,
      expectedNoteVersion: z.literal(1),
      entityType: primitives.string
        .trim()
        .min(1)
        .max(96)
        .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
      normalizedKey: primitives.string.trim().min(1).max(512),
      displayName: primitives.string.trim().min(1).max(512),
      predicateKey: primitives.string
        .trim()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
      confidenceBps: z.number().int().min(0).max(10_000),
      reason: boundedReason,
    })
    .strict(),
);
export type PromoteTaskNoteKnowledgeRequest = z.infer<typeof PromoteTaskNoteKnowledgeRequest>;

/**
 * Promote the exact immutable Task-note bytes into an inactive mandatory-rule
 * draft. The caller selects only the governed target and active-head baseline;
 * it cannot replace the source content or activate the draft.
 */
export const PromoteTaskNoteInstructionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .strictObject({
      kind: z.literal("promote_task_note_instruction_policy"),
      operationId,
      noteId: primitives.uuid,
      expectedNoteVersion: z.literal(1),
      entityType: primitives.string
        .trim()
        .min(1)
        .max(96)
        .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
      normalizedKey: primitives.string.trim().min(1).max(512),
      displayName: primitives.string.trim().min(1).max(512),
      predicateKey: primitives.string
        .trim()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
      confidenceBps: z.number().int().min(0).max(10_000),
      target: WorkspaceInstructionPolicyTarget,
      expectedCurrentRevisionId: primitives.nullableUuid,
      expectedActivationVersion: primitives.nonnegativeInteger,
      reason: boundedReason,
    })
    .superRefine((value, context) => {
      const target = WorkspaceInstructionPolicyTarget.safeParse(value.target);
      if (!target.success) {
        for (const issue of target.error.issues) {
          context.addIssue({ ...issue, path: ["target", ...issue.path] });
        }
      }
    }),
);
export type PromoteTaskNoteInstructionPolicyRequest = z.infer<
  typeof PromoteTaskNoteInstructionPolicyRequest
>;

/**
 * Promote the exact immutable Task-note bytes into an inactive workspace
 * preference proposal. Descriptor metadata is caller-supplied and bounded,
 * while the full proposal content always comes from the admitted note.
 */
export const PromoteTaskNotePreferenceRequest = /* @__PURE__ */ defineSchema(() =>
  z.strictObject({
    kind: z.literal("promote_task_note_preference"),
    operationId,
    noteId: primitives.uuid,
    expectedNoteVersion: z.literal(1),
    entityType: primitives.string
      .trim()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    normalizedKey: primitives.string.trim().min(1).max(512),
    displayName: primitives.string.trim().min(1).max(512),
    predicateKey: primitives.string
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/),
    confidenceBps: z.number().int().min(0).max(10_000),
    stableKey: PreferenceRegistryStableKey.max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
    title: primitives.string.trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
    description: primitives.string
      .trim()
      .min(1)
      .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
    precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
    conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
    conflictsWith: z.array(PreferenceRegistryStableKey).max(32).default([]),
    expiresAt: primitives.string.datetime({ offset: true }).nullable().default(null),
    reason: boundedReason,
  }),
);
export type PromoteTaskNotePreferenceRequest = z.infer<typeof PromoteTaskNotePreferenceRequest>;

export const ProposeWorkspaceInstructionPolicyRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .strictObject({
      kind: z.literal("propose_instruction_policy"),
      operationId,
      ...exactEvidence,
      target: WorkspaceInstructionPolicyTarget,
      // Instruction drafts use the same storage bound as the human editor.
      // Prompt composition retains its separate byte limit after activation.
      content: primitives.nonEmptyString
        .max(
          AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
          AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
        )
        .refine((value) => value.trim().length > 0, "instruction proposal must not be blank"),
      expectedCurrentRevisionId: primitives.nullableUuid,
      expectedActivationVersion: primitives.nonnegativeInteger,
      reason: boundedReason,
    })
    .superRefine((value, context) => {
      const target = WorkspaceInstructionPolicyTarget.safeParse(value.target);
      if (!target.success) {
        for (const issue of target.error.issues) {
          context.addIssue({ ...issue, path: ["target", ...issue.path] });
        }
      }
    }),
);
export type ProposeWorkspaceInstructionPolicyRequest = z.infer<
  typeof ProposeWorkspaceInstructionPolicyRequest
>;

export const ProposeWorkspacePreferenceRequest = /* @__PURE__ */ defineSchema(() =>
  z.strictObject({
    kind: z.literal("propose_preference"),
    operationId,
    ...exactEvidence,
    stableKey: PreferenceRegistryStableKey.max(PREFERENCE_REGISTRY_STABLE_KEY_MAX_CHARS),
    title: primitives.string.trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
    description: primitives.string
      .trim()
      .min(1)
      .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
    // Agent-authored: the descriptor pair is prompt-composed in every session and
    // the content is retrieved on demand, so it stays short.
    content: primitives.nonEmptyString
      .max(
        AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
        AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
      )
      .refine((value) => value.trim().length > 0, "preference proposal must not be blank"),
    precedenceRank: z.number().int().min(-1_000).max(1_000).default(0),
    conflictStrategy: PreferenceRegistryConflictStrategy.default("override"),
    conflictsWith: z.array(PreferenceRegistryStableKey).max(32).default([]),
    expiresAt: primitives.string.datetime({ offset: true }).nullable().default(null),
    reason: boundedReason,
  }),
);
export type ProposeWorkspacePreferenceRequest = z.infer<typeof ProposeWorkspacePreferenceRequest>;

/**
 * Destination selection is explicit and structured. There is deliberately no
 * generic "remember" operation, classifier, personal scope, or active authority.
 */
export const CompanyBrainGovernedWriteRequest = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    ProposeWorkspaceKnowledgeClaimRequest,
    CorrectWorkspaceKnowledgeClaimRequest,
    PromoteTaskNoteKnowledgeRequest,
    PromoteTaskNoteInstructionPolicyRequest,
    PromoteTaskNotePreferenceRequest,
    ProposeWorkspaceInstructionPolicyRequest,
    ProposeWorkspacePreferenceRequest,
  ]),
);
export type CompanyBrainGovernedWriteRequest = z.infer<typeof CompanyBrainGovernedWriteRequest>;

export const CompanyBrainGovernedWriteDestination = /* @__PURE__ */ defineSchema(() =>
  z.enum(["knowledge", "instruction_policy", "preference"]),
);
export type CompanyBrainGovernedWriteDestination = z.infer<
  typeof CompanyBrainGovernedWriteDestination
>;

export const CompanyBrainGovernedWriteReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId,
    inputHash: primitives.string.regex(/^[0-9a-f]{64}$/),
    workspaceId: primitives.uuid,
    destination: CompanyBrainGovernedWriteDestination,
    outcome: z.literal("proposed"),
    claimId: primitives.uuid,
    evidenceId: primitives.uuid,
    relationId: primitives.nullableUuid,
    reviewId: primitives.nullableUuid,
    knowledgeChangeProposalId: primitives.nullableUuid,
    destinationProposalId: primitives.nullableUuid,
    destinationRevisionId: primitives.nullableUuid,
    taskNoteSource: z
      .object({
        noteId: primitives.uuid,
        rootSessionId: primitives.uuid,
        noteVersion: z.literal(1),
        textHash: primitives.string.regex(/^[0-9a-f]{64}$/),
      })
      .nullable()
      .optional(),
    effectiveBoundary: z.literal("human_review_required"),
    rollback: z.object({
      supported: z.literal(false),
      mechanism: z.literal("not_applicable_proposal_only"),
    }),
  }),
);
export type CompanyBrainGovernedWriteReceipt = z.infer<typeof CompanyBrainGovernedWriteReceipt>;

/**
 * Policy routing is deliberately separate from destination admission. The
 * immutable accepted-attempt snapshot decides whether derived evidence may
 * create a proposal; the destination still owns activation and rollback.
 */
export const CompanyBrainLearningPolicyDecision = /* @__PURE__ */ defineSchema(() =>
  z.enum(["blocked", "proposal_created", "activation_requested", "activated"]),
);
export type CompanyBrainLearningPolicyDecision = z.infer<typeof CompanyBrainLearningPolicyDecision>;

/**
 * Content-free summary of the governed-learning decision receipt recorded for
 * a Ways-of-working proposal (instruction policy or preference). Knowledge
 * destinations create no `knowledge_change_proposals` row and are therefore
 * never evaluated; they report `null`.
 */
export const CompanyBrainLearningDecisionSummary = /* @__PURE__ */ defineSchema(() =>
  z.object({
    receiptId: primitives.uuid,
    outcome: GovernedLearningDecisionOutcome,
    automaticEligible: primitives.boolean,
    reasons: z.array(GovernedLearningDecisionReason).max(16),
  }),
);
export type CompanyBrainLearningDecisionSummary = z.infer<
  typeof CompanyBrainLearningDecisionSummary
>;

/**
 * Bounded, content-free reason why evaluation or activation did not complete.
 * The proposal write itself remains durable regardless.
 */
export const CompanyBrainLearningStepFailure = /* @__PURE__ */ defineSchema(() =>
  z.object({
    stage: z.enum(["evaluation", "activation"]),
    code: z.enum(["authority", "conflict", "invalid_operation", "unavailable"]),
  }),
);
export type CompanyBrainLearningStepFailure = z.infer<typeof CompanyBrainLearningStepFailure>;

export const CompanyBrainLearningPolicyRouteReceipt = /* @__PURE__ */ defineSchema(() =>
  z.object({
    operationId,
    workspaceId: primitives.uuid,
    effectivePolicy: WorkspaceLearningPolicyEffectiveMode,
    decision: CompanyBrainLearningPolicyDecision,
    write: CompanyBrainGovernedWriteReceipt.nullable(),
    learning: CompanyBrainLearningDecisionSummary.nullable().default(null),
    learningFailure: CompanyBrainLearningStepFailure.nullable().default(null),
    activation: z.object({
      requested: primitives.boolean,
      activated: primitives.boolean,
      boundary: z.enum([
        "policy_off",
        "human_review",
        "destination_authority",
        "not_eligible",
        "human_activation_required",
        "activated",
      ]),
      receiptId: primitives.nullableUuid.default(null),
      destination: GovernedLearningActivationDestination.nullable().default(null),
      destinationRevisionId: primitives.nullableUuid.default(null),
      effectiveAt: z.string().datetime().nullable().default(null),
    }),
  }),
);
export type CompanyBrainLearningPolicyRouteReceipt = z.infer<
  typeof CompanyBrainLearningPolicyRouteReceipt
>;
