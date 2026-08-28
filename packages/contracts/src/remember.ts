import { z } from "zod";
import {
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
  AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
  AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
} from "./agent-authored-durable-text";
import {
  CompanyBrainLearningDecisionSummary,
  CompanyBrainLearningStepFailure,
} from "./company-brain-governed-writes";
import { GovernedLearningActivationDestination } from "./governed-learning-activation";
import { HumanInputQuestion } from "./index";
import {
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  PreferenceRegistryStableKey,
} from "./preference-registry";
import { WorkspaceInstructionPolicyTarget } from "./workspace-instruction-policies";

/**
 * Explicit user-directed durable write ("remember X for this workspace").
 *
 * The lane is the Agent Knowledge area the content belongs to:
 * - `preference`: a Ways-of-working preference (how agents should act);
 * - `instruction_policy`: a mandatory workspace rule ("always"/"never");
 * - `knowledge`: a company/product/people fact.
 *
 * v1 supports the workspace scope only. Personal and organization scopes are
 * separate authorities that are not yet active for governed writes.
 */
export const RememberLane = z.enum(["preference", "instruction_policy", "knowledge"]);
export type RememberLane = z.infer<typeof RememberLane>;

export const RememberScope = z.enum(["workspace"]);
export type RememberScope = z.infer<typeof RememberScope>;

/**
 * Ceiling for the Knowledge lane, which is retrieval evidence rather than
 * always-composed prompt text. The prompt-composed lanes are bounded far more
 * tightly: see `AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS` and
 * `AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS`.
 */
export const REMEMBER_CONTENT_MAX_CHARS = 4_000;

const rememberBase = {
  operationId: z.string().uuid(),
  scope: RememberScope.default("workspace"),
  /** The exact user-directed content to remember, in the user's words. */
  content: z.string().trim().min(1).max(REMEMBER_CONTENT_MAX_CHARS),
  /** Why the agent believes the user asked for this to be remembered. */
  reason: z.string().trim().min(1).max(4_096),
};

export const RememberRequest = z.discriminatedUnion("lane", [
  z
    .object({
      ...rememberBase,
      lane: z.literal("preference"),
      // Only the short title/description descriptors are prompt-composed; the
      // content is retrieved on demand, so this length is retrieval cost rather
      // than standing prompt cost, and gets more room than a rule rather than
      // less.
      content: z
        .string()
        .trim()
        .min(1)
        .max(
          AGENT_AUTHORED_PREFERENCE_CONTENT_MAX_CHARS,
          AGENT_AUTHORED_PREFERENCE_CONTENT_TOO_LONG_MESSAGE,
        ),
      stableKey: PreferenceRegistryStableKey,
      title: z.string().trim().min(1).max(PREFERENCE_REGISTRY_TITLE_MAX_CHARS),
      description: z
        .string()
        .trim()
        .min(1)
        .max(PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS),
    })
    .strict(),
  z
    .object({
      ...rememberBase,
      lane: z.literal("instruction_policy"),
      // A mandatory rule is composed verbatim into the prompt of every session
      // it applies to, for as long as it stays active, so this is the tightest
      // agent budget in Agent Knowledge.
      content: z
        .string()
        .trim()
        .min(1)
        .max(
          AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
          AGENT_AUTHORED_INSTRUCTION_POLICY_CONTENT_TOO_LONG_MESSAGE,
        ),
      target: WorkspaceInstructionPolicyTarget.default({
        kind: "policy",
        scope: "global",
        roleKey: null,
      }),
    })
    .strict(),
  z
    .object({
      ...rememberBase,
      lane: z.literal("knowledge"),
      /** Short entity label the fact is about (company, product, person, team, ...). */
      subject: z.string().trim().min(1).max(512),
    })
    .strict(),
]);
export type RememberRequest = z.infer<typeof RememberRequest>;

/**
 * Bound structured human-input question that authorizes a confirmed remember.
 * The question id binds the exact confirmation target: the
 * `knowledge_change_proposals` id for Ways-of-working lanes, or the
 * `knowledge_claims` id for the Knowledge lane.
 */
export const REMEMBER_HUMAN_INPUT_SAVE_OPTION = "save" as const;
export const REMEMBER_HUMAN_INPUT_SKIP_OPTION = "skip" as const;
export function rememberHumanInputQuestionId(targetId: string): string {
  return `remember:${targetId}`;
}

// z.lazy: this module is re-exported from ./index, so resolve the question
// schema at parse time instead of at import time.
export const RememberHumanInputPrompt = z.object({
  questions: z.array(z.lazy(() => HumanInputQuestion)).length(1),
  allowSkip: z.literal(false),
});
export type RememberHumanInputPrompt = z.infer<typeof RememberHumanInputPrompt>;

export const RememberActivationSummary = z.discriminatedUnion("destination", [
  z.object({
    destination: GovernedLearningActivationDestination,
    receiptId: z.string().uuid(),
    destinationRevisionId: z.string().uuid().nullable(),
    effectiveAt: z.string().datetime().nullable(),
    authorityKind: z.enum(["automatic", "human_confirmed"]),
    /** The `/learning` API/SDK history exposes exact undo for this receipt. */
    undo: z.literal("learning_history"),
  }),
  z.object({
    destination: z.literal("knowledge"),
    receiptId: z.string().uuid(),
    claimId: z.string().uuid(),
    /** The retrievable Memory record materialized from the approved claim. */
    memoryId: z.string().uuid(),
    approvalReviewId: z.string().uuid(),
    effectiveAt: z.string().datetime().nullable(),
    authorityKind: z.literal("human_confirmed"),
    /** Correct or archive the materialized record through the Memory lifecycle. */
    undo: z.literal("memory_management"),
  }),
]);
export type RememberActivationSummary = z.infer<typeof RememberActivationSummary>;

export const RememberReceipt = z.discriminatedUnion("status", [
  /** Learning policy is off for this source: nothing durable was written. */
  z.object({
    status: z.literal("blocked"),
    operationId: z.string().uuid(),
    lane: RememberLane,
    scope: RememberScope,
    reason: z.literal("learning_policy_off"),
  }),
  /** Kept for callers that still expect review-only Knowledge; not returned by `remember` today. */
  z.object({
    status: z.literal("proposed_for_review"),
    operationId: z.string().uuid(),
    lane: RememberLane,
    scope: RememberScope,
    noteId: z.string().uuid(),
    claimId: z.string().uuid(),
    evidenceId: z.string().uuid(),
    reviewId: z.string().uuid().nullable(),
  }),
  /** Activated immediately (automatic policy) through the destination lifecycle. */
  z.object({
    status: z.literal("activated"),
    operationId: z.string().uuid(),
    lane: RememberLane,
    scope: RememberScope,
    noteId: z.string().uuid(),
    proposalId: z.string().uuid(),
    learning: CompanyBrainLearningDecisionSummary.nullable(),
    activation: RememberActivationSummary,
  }),
  /**
   * The proposal is durable but the workspace policy will not activate it on
   * its own. The agent must ask the human exactly this question through the
   * built-in `request_human_input` tool, then call `remember_confirm` with the
   * returned request id.
   */
  z.object({
    status: z.literal("confirmation_required"),
    operationId: z.string().uuid(),
    lane: RememberLane,
    scope: RememberScope,
    noteId: z.string().uuid(),
    /** Ways-of-working lanes confirm a change proposal; Knowledge confirms the claim. */
    proposalId: z.string().uuid().nullable(),
    claimId: z.string().uuid(),
    learning: CompanyBrainLearningDecisionSummary.nullable(),
    learningFailure: CompanyBrainLearningStepFailure.nullable(),
    humanInput: RememberHumanInputPrompt,
    confirmWith: z.literal("remember_confirm"),
  }),
]);
export type RememberReceipt = z.infer<typeof RememberReceipt>;

export const RememberConfirmRequest = z.discriminatedUnion("target", [
  z
    .object({
      target: z.literal("proposal"),
      operationId: z.string().uuid(),
      proposalId: z.string().uuid(),
      /** `learning.receiptId` from the `confirmation_required` remember receipt. */
      decisionReceiptId: z.string().uuid(),
      /** The `requestId` returned by `request_human_input`. */
      humanInputRequestId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      target: z.literal("knowledge_claim"),
      operationId: z.string().uuid(),
      claimId: z.string().uuid(),
      humanInputRequestId: z.string().uuid(),
    })
    .strict(),
]);
export type RememberConfirmRequest = z.infer<typeof RememberConfirmRequest>;

export const RememberConfirmReceipt = z.object({
  status: z.literal("activated"),
  operationId: z.string().uuid(),
  proposalId: z.string().uuid().nullable(),
  claimId: z.string().uuid(),
  decisionReceiptId: z.string().uuid().nullable(),
  activation: RememberActivationSummary,
});
export type RememberConfirmReceipt = z.infer<typeof RememberConfirmReceipt>;
