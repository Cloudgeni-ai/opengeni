import {
  CompanyBrainLearningPolicyRouteReceipt,
  CompanyBrainGovernedWriteAttempt,
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
  resolveWorkspaceLearningPolicyEffectiveMode,
  type CompanyBrainGovernedWriteReceipt as CompanyBrainGovernedWriteReceiptType,
  type CompanyBrainLearningPolicyRouteReceipt as CompanyBrainLearningPolicyRouteReceiptType,
  type WorkspaceLearningPolicySnapshot,
} from "@opengeni/contracts";
import {
  type Database,
  getOrCreateWorkspaceLearningPolicySnapshot,
  writeCompanyBrainGovernedProposal,
} from "@opengeni/db";

export type CompanyBrainGovernedWriteInput = {
  attempt: unknown;
  request: unknown;
};

export type CompanyBrainGovernedWriteRouterOptions = {
  db: Database;
  authority?: typeof writeCompanyBrainGovernedProposal;
  learningPolicySnapshot?: typeof getOrCreateWorkspaceLearningPolicySnapshot;
};

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
 * Resolve one derived Company Brain write from the immutable policy snapshot
 * frozen for the exact accepted attempt. The evidence identity is the policy
 * source identity; callers cannot select another override key to widen the
 * decision. `automatic` requests destination-owned activation but never
 * bypasses the existing human/destination lifecycle.
 */
export function createCompanyBrainLearningPolicyRouter(
  options: CompanyBrainGovernedWriteRouterOptions,
): {
  write: (
    input: CompanyBrainGovernedWriteInput,
  ) => Promise<CompanyBrainLearningPolicyRouteReceiptType>;
} {
  const proposalRouter = createCompanyBrainGovernedWriteRouter(options);
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
      const effectivePolicy = resolveWorkspaceLearningPolicyEffectiveMode(policySnapshot, {
        kind:
          request.kind === "promote_task_note_knowledge"
            ? "task-note"
            : "scoped-knowledge-evidence",
        id: request.kind === "promote_task_note_knowledge" ? request.noteId : request.evidenceId,
      });
      if (effectivePolicy.mode === "off") {
        return CompanyBrainLearningPolicyRouteReceipt.parse({
          operationId: request.operationId,
          workspaceId: attempt.workspaceId,
          effectivePolicy,
          decision: "blocked",
          write: null,
          activation: {
            requested: false,
            activated: false,
            boundary: "policy_off",
          },
        });
      }
      const write = await proposalRouter.write({ attempt, request });
      const automatic = effectivePolicy.mode === "automatic";
      return CompanyBrainLearningPolicyRouteReceipt.parse({
        operationId: request.operationId,
        workspaceId: attempt.workspaceId,
        effectivePolicy,
        decision: automatic ? "activation_requested" : "proposal_created",
        write,
        activation: {
          requested: automatic,
          activated: false,
          boundary: automatic ? "destination_authority" : "human_review",
        },
      });
    },
  };
}
