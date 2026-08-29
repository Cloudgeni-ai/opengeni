import {
  CompanyBrainLearningPolicyRouteReceipt,
  CompanyBrainGovernedWriteAttempt,
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
  resolveWorkspaceLearningPolicyEffectiveMode,
  type CompanyBrainGovernedWriteReceipt as CompanyBrainGovernedWriteReceiptType,
  type CompanyBrainLearningPolicyRouteReceipt as CompanyBrainLearningPolicyRouteReceiptType,
  type CompanyBrainLearningStepFailure,
  type GovernedLearningActivationDestination,
  type GovernedLearningActivationReceipt,
  type GovernedLearningDecisionReceipt,
  type WorkspaceLearningPolicySnapshot,
} from "@opengeni/contracts";
import {
  type Database,
  GovernedLearningActivationAuthorityError,
  GovernedLearningActivationConflictError,
  GovernedLearningActivationInvalidOperationError,
  GovernedLearningEvaluationAuthorityError,
  GovernedLearningEvaluationConflictError,
  activateGovernedLearningDecision,
  evaluateGovernedLearningProposal,
  getOrCreateWorkspaceLearningPolicySnapshot,
  writeCompanyBrainGovernedProposal,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import {
  publishGovernedLearningEventToSlack,
  type GovernedLearningSlackPublicationResult,
} from "./governed-learning-slack-publication";

export type CompanyBrainGovernedWriteInput = {
  attempt: unknown;
  request: unknown;
};

export type CompanyBrainGovernedWriteRouterOptions = {
  db: Database;
  authority?: typeof writeCompanyBrainGovernedProposal;
  learningPolicySnapshot?: typeof getOrCreateWorkspaceLearningPolicySnapshot;
  /** Governed-learning evaluator (migration 0268). Defaults to the DB capability. */
  evaluate?: typeof evaluateGovernedLearningProposal;
  /** Governed-learning activation controller (migration 0269). Defaults to the DB capability. */
  activate?: typeof activateGovernedLearningDecision;
  /**
   * Destinations the router may activate automatically from a final eligible
   * decision. Defaults to preferences only: mandatory instruction policy keeps
   * requiring human-authoritative activation even under `automatic`, so its
   * decision receipt is recorded but the inactive draft stays for review.
   */
  automaticDestinations?: ReadonlyArray<GovernedLearningActivationDestination>;
  /**
   * Optional post-activation notification sink (Slack publication outbox).
   * Notification is never authority: failures are swallowed after the
   * activation receipt is durable and never change the route receipt.
   */
  notifyActivation?: (input: {
    db: Database;
    receipt: GovernedLearningActivationReceipt;
    sessionId: string;
    attemptId: string;
  }) => Promise<GovernedLearningSlackPublicationResult>;
};

export const DEFAULT_AUTOMATIC_LEARNING_DESTINATIONS: ReadonlyArray<GovernedLearningActivationDestination> =
  ["preference"];

/**
 * Start a non-authoritative post-activation notification without making the
 * durable activation receipt wait for its settlement. The callback is invoked
 * synchronously so immediate enqueue work begins before the router returns;
 * both synchronous throws and later promise rejections are contained.
 *
 * Exact retries intentionally dispatch again: the publication sink owns an
 * activation-receipt idempotency key, while the activation receipt remains the
 * caller-facing source of truth even if notification delivery stalls forever.
 */
export function dispatchBestEffortGovernedLearningNotification(
  notify: () => Promise<unknown>,
): void {
  try {
    void notify().catch(() => undefined);
  } catch {
    // Notification is best-effort; the durable activation receipt already exists.
  }
}

/**
 * Transport-neutral facade for explicit governed Company Brain proposals.
 * It intentionally exposes no generic remember call, selector, activation,
 * rollback token, or personal/organization destination.
 */
export function createCompanyBrainGovernedWriteRouter(
  options: CompanyBrainGovernedWriteRouterOptions,
): {
  write: (input: CompanyBrainGovernedWriteInput) => Promise<CompanyBrainGovernedWriteReceiptType>;
} {
  const authority = options.authority ?? writeCompanyBrainGovernedProposal;
  return {
    async write(input) {
      const attempt = CompanyBrainGovernedWriteAttempt.parse(input.attempt);
      const request = CompanyBrainGovernedWriteRequest.parse(input.request);
      const result = await authority(options.db, { attempt, request });
      return CompanyBrainGovernedWriteReceipt.parse(result);
    },
  };
}

/**
 * Deterministic UUIDv5-shaped operation id derived from the caller's proposal
 * operation id, so an exact retry of the same write converges on the same
 * evaluator/activation receipts instead of conflicting.
 */
export function derivedGovernedLearningOperationId(
  operationId: string,
  stage: "evaluation" | "activation",
): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`company-brain-governed-learning:v1:${operationId}:${stage}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function classifyLearningFailure(
  stage: CompanyBrainLearningStepFailure["stage"],
  error: unknown,
): CompanyBrainLearningStepFailure {
  if (
    error instanceof GovernedLearningEvaluationAuthorityError ||
    error instanceof GovernedLearningActivationAuthorityError
  ) {
    return { stage, code: "authority" };
  }
  if (
    error instanceof GovernedLearningEvaluationConflictError ||
    error instanceof GovernedLearningActivationConflictError
  ) {
    return { stage, code: "conflict" };
  }
  if (error instanceof GovernedLearningActivationInvalidOperationError) {
    return { stage, code: "invalid_operation" };
  }
  return { stage, code: "unavailable" };
}

/**
 * Resolve one derived Company Brain write from the immutable policy snapshot
 * frozen for the exact accepted attempt. The evidence identity is the policy
 * source identity; callers cannot select another override key to widen the
 * decision.
 *
 * After the proposal commits, a Ways-of-working proposal (instruction policy or
 * preference, i.e. one that materialized a `knowledge_change_proposals` row) is
 * evaluated by the governed-learning evaluator against the same accepted
 * snapshot. `suggest` records the content-free decision receipt only. Under
 * `automatic`, a final `automaticEligible` receipt is handed to the activation
 * controller, which revalidates current authority and applies the change only
 * through the destination-owned lifecycle. By default only preferences may
 * activate automatically; mandatory instruction policy always keeps a human
 * activation boundary. Evaluation or activation failure
 * never rolls back the durable proposal; it is reported as a bounded
 * `learningFailure` and the proposal remains for human review.
 */
export function createCompanyBrainLearningPolicyRouter(
  options: CompanyBrainGovernedWriteRouterOptions,
): {
  write: (
    input: CompanyBrainGovernedWriteInput,
  ) => Promise<CompanyBrainLearningPolicyRouteReceiptType>;
} {
  const authority = options.authority ?? writeCompanyBrainGovernedProposal;
  const evaluate = options.evaluate ?? evaluateGovernedLearningProposal;
  const activate = options.activate ?? activateGovernedLearningDecision;
  const notifyActivation =
    options.notifyActivation ??
    (async ({ db, receipt, sessionId, attemptId }) =>
      publishGovernedLearningEventToSlack(db, {
        kind: "activated",
        receipt,
        sessionId,
        attemptId,
      }));
  const automaticDestinations = new Set(
    options.automaticDestinations ?? DEFAULT_AUTOMATIC_LEARNING_DESTINATIONS,
  );
  const snapshotAuthority =
    options.learningPolicySnapshot ?? getOrCreateWorkspaceLearningPolicySnapshot;
  return {
    async write(input) {
      const attempt = CompanyBrainGovernedWriteAttempt.parse(input.attempt);
      const request = CompanyBrainGovernedWriteRequest.parse(input.request);
      const policySnapshot: WorkspaceLearningPolicySnapshot = await snapshotAuthority(options.db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        sessionId: attempt.sessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      });
      const taskNotePromotion =
        request.kind === "promote_task_note_knowledge" ||
        request.kind === "promote_task_note_instruction_policy" ||
        request.kind === "promote_task_note_preference";
      const effectivePolicy = resolveWorkspaceLearningPolicyEffectiveMode(policySnapshot, {
        kind: taskNotePromotion ? "task-note" : "scoped-knowledge-evidence",
        id: taskNotePromotion ? request.noteId : request.evidenceId,
      });
      if (effectivePolicy.mode === "off") {
        return CompanyBrainLearningPolicyRouteReceipt.parse({
          operationId: request.operationId,
          workspaceId: attempt.workspaceId,
          effectivePolicy,
          decision: "blocked",
          write: null,
          learning: null,
          learningFailure: null,
          activation: {
            requested: false,
            activated: false,
            boundary: "policy_off",
          },
        });
      }
      const result = await authority(options.db, { attempt, request });
      const write = CompanyBrainGovernedWriteReceipt.parse(result);
      const automatic = effectivePolicy.mode === "automatic";
      const proposalOnly = CompanyBrainLearningPolicyRouteReceipt.parse({
        operationId: request.operationId,
        workspaceId: attempt.workspaceId,
        effectivePolicy,
        decision: automatic ? "activation_requested" : "proposal_created",
        write,
        learning: null,
        learningFailure: null,
        activation: {
          requested: automatic,
          activated: false,
          boundary: automatic ? "destination_authority" : "human_review",
        },
      });
      // Knowledge destinations create no change proposal and are never
      // evaluated; the human Knowledge review lifecycle owns them.
      if (write.knowledgeChangeProposalId === null) return proposalOnly;

      let decision: GovernedLearningDecisionReceipt;
      try {
        decision = await evaluate(options.db, {
          attempt: {
            workspaceId: attempt.workspaceId,
            subjectId: result.initiatingHumanSubjectId,
            sessionId: attempt.sessionId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
            executionGeneration: attempt.executionGeneration,
          },
          request: {
            operationId: derivedGovernedLearningOperationId(request.operationId, "evaluation"),
            policySnapshotId: policySnapshot.id,
            proposalId: write.knowledgeChangeProposalId,
            claimId: write.claimId,
            evidenceId: write.evidenceId,
          },
        });
      } catch (error) {
        return CompanyBrainLearningPolicyRouteReceipt.parse({
          ...proposalOnly,
          learningFailure: classifyLearningFailure("evaluation", error),
        });
      }
      const learning = {
        receiptId: decision.id,
        outcome: decision.outcome,
        automaticEligible: decision.automaticEligible,
        reasons: decision.reasons,
      };
      const destinationAllowsAutomatic =
        write.destination !== "knowledge" && automaticDestinations.has(write.destination);
      if (!automatic || !decision.automaticEligible || !destinationAllowsAutomatic) {
        return CompanyBrainLearningPolicyRouteReceipt.parse({
          ...proposalOnly,
          learning,
          activation: {
            requested: automatic,
            activated: false,
            boundary: !automatic
              ? "human_review"
              : !decision.automaticEligible
                ? "not_eligible"
                : "human_activation_required",
          },
        });
      }
      let activation: GovernedLearningActivationReceipt;
      try {
        activation = await activate(options.db, {
          caller: {
            workspaceId: attempt.workspaceId,
            subjectId: result.initiatingHumanSubjectId,
          },
          request: {
            operationId: derivedGovernedLearningOperationId(request.operationId, "activation"),
            decisionReceiptId: decision.id,
          },
        });
      } catch (error) {
        return CompanyBrainLearningPolicyRouteReceipt.parse({
          ...proposalOnly,
          learning,
          learningFailure: classifyLearningFailure("activation", error),
        });
      }
      dispatchBestEffortGovernedLearningNotification(() =>
        notifyActivation({
          db: options.db,
          receipt: activation,
          sessionId: attempt.sessionId,
          attemptId: attempt.attemptId,
        }),
      );
      return CompanyBrainLearningPolicyRouteReceipt.parse({
        operationId: request.operationId,
        workspaceId: attempt.workspaceId,
        effectivePolicy,
        decision: "activated",
        write,
        learning,
        learningFailure: null,
        activation: {
          requested: true,
          activated: true,
          boundary: "activated",
          receiptId: activation.id,
          destination: activation.destination,
          destinationRevisionId: activation.destinationRevisionId,
          effectiveAt: activation.effectiveAt,
        },
      });
    },
  };
}
