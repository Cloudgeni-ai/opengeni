import {
  ActivateGovernedLearningDecisionRequest,
  GovernedLearningActivationCaller,
  GovernedLearningActivationReceipt,
  GovernedLearningActivationUndoReceipt,
  UndoGovernedLearningActivationRequest,
  type ActivateGovernedLearningDecisionRequest as ActivateRequest,
  type GovernedLearningActivationCaller as ActivationCaller,
  type GovernedLearningActivationReceipt as ActivationReceipt,
  type GovernedLearningActivationUndoReceipt as UndoReceipt,
  type UndoGovernedLearningActivationRequest as UndoRequest,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withWorkspaceRls, withWorkspaceSubjectRls } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export class GovernedLearningActivationAuthorityError extends Error {
  readonly name = "GovernedLearningActivationAuthorityError";
}

export class GovernedLearningActivationConflictError extends Error {
  readonly name = "GovernedLearningActivationConflictError";
}

export class GovernedLearningActivationInvalidOperationError extends Error {
  readonly name = "GovernedLearningActivationInvalidOperationError";
}

type ActivationRow = {
  id: string;
  operation_id: string;
  input_hash: string;
  account_id: string;
  workspace_id: string;
  decision_receipt_id: string;
  initiating_human_subject_id: string;
  service_actor_subject_id: string;
  policy_revision_id: string;
  policy_hash: string;
  policy_activation_version: number | string;
  source_kind: string;
  source_id: string;
  source_authority_hash: string;
  proposal_id: string;
  claim_id: string;
  evidence_id: string;
  knowledge_previous_review_id: string;
  knowledge_previous_review_revision: number | string;
  knowledge_approval_review_id: string;
  knowledge_approval_review_revision: number | string;
  knowledge_approval_input_hash: string;
  destination: string;
  destination_proposal_id: string;
  destination_revision_id: string;
  destination_old_revision_id: string | null;
  destination_old_content_hash: string | null;
  destination_old_version: number | string;
  destination_new_content_hash: string;
  destination_new_version: number | string;
  destination_event_id: string;
  effective_at: Date | string;
  created_at: Date | string;
};

type UndoRow = {
  id: string;
  operation_id: string;
  input_hash: string;
  account_id: string;
  workspace_id: string;
  activation_receipt_id: string;
  initiating_human_subject_id: string;
  service_actor_subject_id: string;
  destination: string;
  knowledge_approval_review_id: string;
  knowledge_revocation_review_id: string;
  knowledge_revocation_review_revision: number | string;
  knowledge_revocation_input_hash: string;
  destination_activated_revision_id: string;
  destination_restored_revision_id: string | null;
  destination_activated_content_hash: string;
  destination_restored_content_hash: string | null;
  destination_old_version: number | string;
  destination_new_version: number | string;
  destination_event_id: string;
  effective_at: Date | string;
  created_at: Date | string;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function activationFromRow(row: ActivationRow): ActivationReceipt {
  return GovernedLearningActivationReceipt.parse({
    id: row.id,
    operationId: row.operation_id,
    inputHash: row.input_hash,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    decisionReceiptId: row.decision_receipt_id,
    initiatingHumanSubjectId: row.initiating_human_subject_id,
    serviceActorSubjectId: row.service_actor_subject_id,
    policyRevisionId: row.policy_revision_id,
    policyHash: row.policy_hash,
    policyActivationVersion: Number(row.policy_activation_version),
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceAuthorityHash: row.source_authority_hash,
    proposalId: row.proposal_id,
    claimId: row.claim_id,
    evidenceId: row.evidence_id,
    knowledgePreviousReviewId: row.knowledge_previous_review_id,
    knowledgePreviousReviewRevision: Number(row.knowledge_previous_review_revision),
    knowledgeApprovalReviewId: row.knowledge_approval_review_id,
    knowledgeApprovalReviewRevision: Number(row.knowledge_approval_review_revision),
    knowledgeApprovalInputHash: row.knowledge_approval_input_hash,
    destination: row.destination,
    destinationProposalId: row.destination_proposal_id,
    destinationRevisionId: row.destination_revision_id,
    destinationOldRevisionId: row.destination_old_revision_id,
    destinationOldContentHash: row.destination_old_content_hash,
    destinationOldVersion: Number(row.destination_old_version),
    destinationNewContentHash: row.destination_new_content_hash,
    destinationNewVersion: Number(row.destination_new_version),
    destinationEventId: row.destination_event_id,
    outcome: "activated",
    effectiveAt: iso(row.effective_at),
    rollback: { supported: true, mechanism: "exact_head_and_latest_review" },
    createdAt: iso(row.created_at),
  });
}

function undoFromRow(row: UndoRow): UndoReceipt {
  return GovernedLearningActivationUndoReceipt.parse({
    id: row.id,
    operationId: row.operation_id,
    inputHash: row.input_hash,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    activationReceiptId: row.activation_receipt_id,
    initiatingHumanSubjectId: row.initiating_human_subject_id,
    serviceActorSubjectId: row.service_actor_subject_id,
    destination: row.destination,
    knowledgeApprovalReviewId: row.knowledge_approval_review_id,
    knowledgeRevocationReviewId: row.knowledge_revocation_review_id,
    knowledgeRevocationReviewRevision: Number(row.knowledge_revocation_review_revision),
    knowledgeRevocationInputHash: row.knowledge_revocation_input_hash,
    destinationActivatedRevisionId: row.destination_activated_revision_id,
    destinationRestoredRevisionId: row.destination_restored_revision_id,
    destinationActivatedContentHash: row.destination_activated_content_hash,
    destinationRestoredContentHash: row.destination_restored_content_hash,
    destinationOldVersion: Number(row.destination_old_version),
    destinationNewVersion: Number(row.destination_new_version),
    destinationEventId: row.destination_event_id,
    outcome: "undone",
    superseded: false,
    effectiveAt: iso(row.effective_at),
    createdAt: iso(row.created_at),
  });
}

/** Subject-filtered activation and compensation history for Workspace State. */
export async function listGovernedLearningActivationHistory(
  db: Database,
  input: { workspaceId: string; subjectId: string; principalKind: string; limit: number },
): Promise<{ activations: ActivationReceipt[]; undos: UndoReceipt[]; truncated: boolean }> {
  if (input.principalKind !== "human_session") {
    throw new GovernedLearningActivationAuthorityError(
      "Governed-learning history requires an exact authenticated human actor",
    );
  }
  const limit = Math.max(1, Math.min(input.limit, 100));
  try {
    return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (scoped) => {
      await scoped.execute(
        sql`select set_config('opengeni.principal_kind', ${input.principalKind}, true)`,
      );
      const [activationRows, undoRows] = await Promise.all([
        rawRows<ActivationRow>(
          scoped,
          sql`SELECT * FROM inspect_governed_learning_activations(
          current_setting('opengeni.account_id')::uuid,
          ${input.workspaceId}::uuid,
          ${input.subjectId},
          ${limit + 1}
        )`,
        ),
        rawRows<UndoRow>(
          scoped,
          sql`SELECT * FROM inspect_governed_learning_activation_undos(
          current_setting('opengeni.account_id')::uuid,
          ${input.workspaceId}::uuid,
          ${input.subjectId},
          ${limit + 1}
        )`,
        ),
      ]);
      return {
        activations: activationRows.slice(0, limit).map(activationFromRow),
        undos: undoRows.slice(0, limit).map(undoFromRow),
        truncated: activationRows.length > limit || undoRows.length > limit,
      };
    });
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") {
      throw new GovernedLearningActivationAuthorityError(
        "Governed-learning history is unavailable",
      );
    }
    throw error;
  }
}

function translate(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "42501") {
    throw new GovernedLearningActivationAuthorityError(
      "Governed-learning activation is unavailable",
    );
  }
  if (state === "23505" || state === "40001") {
    throw new GovernedLearningActivationConflictError(
      "Governed-learning activation conflicted with current authority",
    );
  }
  if (state === "23514" || state === "55000" || state === "22023") {
    throw new GovernedLearningActivationInvalidOperationError(
      "Governed-learning activation is no longer eligible",
    );
  }
  throw error;
}

export async function activateGovernedLearningDecision(
  db: Database,
  raw: { caller: ActivationCaller; request: ActivateRequest },
): Promise<ActivationReceipt> {
  const caller = GovernedLearningActivationCaller.parse(raw.caller);
  const request = ActivateGovernedLearningDecisionRequest.parse(raw.request);
  try {
    return await withWorkspaceSubjectRls(
      db,
      caller.workspaceId,
      caller.subjectId,
      async (scoped) => {
        const rows = await rawRows<ActivationRow>(
          scoped,
          sql`SELECT * FROM activate_governed_learning_decision(
          current_setting('opengeni.account_id')::uuid,
          ${caller.workspaceId}::uuid,
          ${request.operationId}::uuid,
          ${request.decisionReceiptId}::uuid
        )`,
        );
        if (rows.length !== 1 || !rows[0]) {
          throw new Error("Governed-learning activation returned no unique receipt");
        }
        return activationFromRow(rows[0]);
      },
    );
  } catch (error) {
    translate(error);
  }
}

export async function undoGovernedLearningActivation(
  db: Database,
  raw: { caller: ActivationCaller; request: UndoRequest },
): Promise<UndoReceipt> {
  const caller = GovernedLearningActivationCaller.parse(raw.caller);
  const request = UndoGovernedLearningActivationRequest.parse(raw.request);
  try {
    return await withWorkspaceSubjectRls(
      db,
      caller.workspaceId,
      caller.subjectId,
      async (scoped) => {
        const rows = await rawRows<UndoRow>(
          scoped,
          sql`SELECT * FROM undo_governed_learning_activation(
          current_setting('opengeni.account_id')::uuid,
          ${caller.workspaceId}::uuid,
          ${request.operationId}::uuid,
          ${request.activationReceiptId}::uuid
        )`,
        );
        if (rows.length !== 1 || !rows[0]) {
          throw new Error("Governed-learning activation undo returned no unique receipt");
        }
        return undoFromRow(rows[0]);
      },
    );
  } catch (error) {
    translate(error);
  }
}

export type GovernedLearningEvidenceOrigin =
  | { kind: "task-note" }
  | { kind: "document"; providerKey: string | null };

/**
 * Resolve where the evidence behind a governed-learning receipt came from, so
 * notification sinks can fail closed for evidence that originated in the same
 * connector they publish to (loop prevention). Returns `null` when the exact
 * evidence row is not visible under the workspace authority.
 */
export async function resolveGovernedLearningEvidenceOrigin(
  db: Database,
  input: { workspaceId: string; evidenceId: string },
): Promise<GovernedLearningEvidenceOrigin | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const rows = await rawRows<{
      task_note_id: string | null;
      provider_key: string | null;
    }>(
      scoped,
      sql`SELECT evidence.task_note_id, provider.provider_key
          FROM knowledge_claim_evidence evidence
          LEFT JOIN knowledge_document_versions version
            ON version.account_id = evidence.account_id
           AND version.id = evidence.document_version_id
          LEFT JOIN knowledge_sources source
            ON source.account_id = version.account_id
           AND source.id = version.source_id
          LEFT JOIN knowledge_providers provider
            ON provider.account_id = source.account_id
           AND provider.id = source.provider_id
          WHERE evidence.workspace_id = ${input.workspaceId}::uuid
            AND evidence.id = ${input.evidenceId}::uuid
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.task_note_id) return { kind: "task-note" };
    return { kind: "document", providerKey: row.provider_key };
  });
}
