import {
  GovernedLearningDecisionReceipt,
  type GovernedLearningDecisionReceipt as GovernedLearningDecisionReceiptType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceSubjectRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export class GovernedLearningEvaluationAuthorityError extends Error {
  readonly name = "GovernedLearningEvaluationAuthorityError";
}

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

/** Subject-filtered, content-free decision history for the Workspace State surface. */
export async function listGovernedLearningDecisionReceipts(
  db: Database,
  input: { workspaceId: string; subjectId: string; principalKind: string; limit: number },
): Promise<{ receipts: GovernedLearningDecisionReceiptType[]; truncated: boolean }> {
  if (input.principalKind !== "human_session") {
    throw new GovernedLearningEvaluationAuthorityError(
      "Governed-learning history requires an exact authenticated human actor",
    );
  }
  const limit = Math.max(1, Math.min(input.limit, 100));
  try {
    return await withWorkspaceSubjectRls(
      db,
      input.workspaceId,
      input.subjectId,
      async (scopedDb) => {
        await scopedDb.execute(
          sql`select set_config('opengeni.principal_kind', ${input.principalKind}, true)`,
        );
        const rows = await rawRows<ReceiptRow>(
          scopedDb,
          sql`SELECT
        id AS receipt_id, operation_id, input_hash, account_id, workspace_id,
        session_id, turn_id, attempt_id, execution_generation,
        initiating_human_subject_id, policy_snapshot_id, policy_snapshot_hash,
        policy_revision_id, policy_activation_version, source_kind, source_id,
        proposal_id, proposal_input_hash, proposal_content_hash, claim_id,
        claim_input_hash, evidence_id, evidence_input_hash, evidence_content_hash,
        evidence_authority_hash, review_revision, review_state, effective_mode,
        confidence_bps, conflict_count, outcome, reason_codes, automatic_eligible,
        confidence_floor_bps, created_at
      FROM inspect_governed_learning_decisions(
        current_setting('opengeni.account_id')::uuid,
        ${input.workspaceId}::uuid,
        ${input.subjectId},
        ${limit + 1}
      )`,
        );
        return {
          receipts: rows.slice(0, limit).map(receiptFromRow),
          truncated: rows.length > limit,
        };
      },
    );
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") {
      throw new GovernedLearningEvaluationAuthorityError(
        "Governed-learning history is unavailable",
      );
    }
    throw error;
  }
}
