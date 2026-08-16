import {
  EvaluateGovernedLearningProposalRequest,
  GovernedLearningDecisionReceipt,
  GovernedLearningEvaluationAttempt,
  type GovernedLearningDecisionReceipt as GovernedLearningDecisionReceiptType,
  type GovernedLearningEvaluationAttempt as GovernedLearningEvaluationAttemptType,
  type EvaluateGovernedLearningProposalRequest as EvaluateGovernedLearningProposalRequestType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceSubjectRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export class GovernedLearningEvaluationAuthorityError extends Error {
  readonly name = "GovernedLearningEvaluationAuthorityError";
}

export class GovernedLearningEvaluationConflictError extends Error {
  readonly name = "GovernedLearningEvaluationConflictError";
}

export type GovernedLearningEvaluationInput = Readonly<{
  attempt: GovernedLearningEvaluationAttemptType;
  request: EvaluateGovernedLearningProposalRequestType;
}>;

type ReceiptRow = {
  receipt_id: string;
  operation_id: string;
  input_hash: string;
  account_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  attempt_id: string;
  execution_generation: number;
  initiating_human_subject_id: string;
  policy_snapshot_id: string;
  policy_snapshot_hash: string;
  policy_revision_id: string | null;
  policy_activation_version: number | string;
  source_kind: string;
  source_id: string;
  proposal_id: string;
  proposal_input_hash: string;
  proposal_content_hash: string;
  claim_id: string;
  claim_input_hash: string;
  evidence_id: string;
  evidence_input_hash: string;
  evidence_content_hash: string;
  evidence_authority_hash: string;
  review_revision: number | string;
  review_state: string;
  effective_mode: string;
  confidence_bps: number;
  conflict_count: number;
  outcome: string;
  reason_codes: string[];
  automatic_eligible: boolean;
  confidence_floor_bps: number;
  created_at: Date | string;
};

function receiptFromRow(row: ReceiptRow): GovernedLearningDecisionReceiptType {
  return GovernedLearningDecisionReceipt.parse({
    id: row.receipt_id,
    operationId: row.operation_id,
    inputHash: row.input_hash,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
    executionGeneration: row.execution_generation,
    initiatingHumanSubjectId: row.initiating_human_subject_id,
    policySnapshotId: row.policy_snapshot_id,
    policySnapshotHash: row.policy_snapshot_hash,
    policyRevisionId: row.policy_revision_id,
    policyActivationVersion: Number(row.policy_activation_version),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    proposalId: row.proposal_id,
    proposalInputHash: row.proposal_input_hash,
    proposalContentHash: row.proposal_content_hash,
    claimId: row.claim_id,
    claimInputHash: row.claim_input_hash,
    evidenceId: row.evidence_id,
    evidenceInputHash: row.evidence_input_hash,
    evidenceContentHash: row.evidence_content_hash,
    evidenceAuthorityHash: row.evidence_authority_hash,
    reviewRevision: Number(row.review_revision),
    reviewState: row.review_state,
    effectiveMode: row.effective_mode,
    confidenceBps: row.confidence_bps,
    conflictCount: row.conflict_count,
    outcome: row.outcome,
    reasons: row.reason_codes,
    automaticEligible: row.automatic_eligible,
    confidenceFloorBps: row.confidence_floor_bps,
    createdAt: (row.created_at instanceof Date
      ? row.created_at
      : new Date(row.created_at)
    ).toISOString(),
  });
}

/**
 * Persist one inert, content-free governed-learning decision. The database
 * capability independently revalidates the accepted attempt, policy snapshot,
 * proposal lineage, current evidence authority, and deterministic verdict.
 */
export async function evaluateGovernedLearningProposal(
  db: Database,
  input: GovernedLearningEvaluationInput,
): Promise<GovernedLearningDecisionReceiptType> {
  const attempt = GovernedLearningEvaluationAttempt.parse(input.attempt);
  const request = EvaluateGovernedLearningProposalRequest.parse(input.request);
  try {
    return await withWorkspaceSubjectRls(
      db,
      attempt.workspaceId,
      attempt.subjectId,
      async (scopedDb) => {
        const rows = await rawRows<ReceiptRow>(
          scopedDb,
          sql`SELECT * FROM evaluate_governed_learning_proposal(
            current_setting('opengeni.account_id')::uuid,
            ${attempt.workspaceId}::uuid,
            ${attempt.sessionId}::uuid,
            ${attempt.turnId}::uuid,
            ${attempt.attemptId}::uuid,
            ${attempt.executionGeneration}::integer,
            ${request.operationId}::uuid,
            ${request.policySnapshotId}::uuid,
            ${request.proposalId}::uuid,
            ${request.claimId}::uuid,
            ${request.evidenceId}::uuid
          )`,
        );
        const row = rows[0];
        if (!row || rows.length !== 1) {
          throw new Error("Governed-learning evaluation returned no unique receipt");
        }
        return receiptFromRow(row);
      },
    );
  } catch (error) {
    const state = nestedPostgresSqlState(error);
    if (state === "42501") {
      throw new GovernedLearningEvaluationAuthorityError(
        "Governed-learning proposal evaluation is unavailable",
      );
    }
    if (state === "23505" || state === "40001") {
      throw new GovernedLearningEvaluationConflictError(
        "Governed-learning proposal evaluation conflicted",
      );
    }
    throw error;
  }
}
