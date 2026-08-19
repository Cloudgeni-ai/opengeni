import {
  ActivateGovernedLearningDecisionRequest,
  ActivateHumanConfirmedLearningDecisionRequest,
  ConfirmRememberKnowledgeClaimRequest,
  GovernedLearningActivationCaller,
  RememberKnowledgeConfirmationReceipt,
  GovernedLearningActivationReceipt,
  GovernedLearningActivationUndoReceipt,
  UndoGovernedLearningActivationRequest,
  type ActivateGovernedLearningDecisionRequest as ActivateRequest,
  type ActivateHumanConfirmedLearningDecisionRequest as ActivateHumanConfirmedRequest,
  type ConfirmRememberKnowledgeClaimRequest as ConfirmRememberKnowledgeClaimRequestType,
  type RememberKnowledgeConfirmationReceipt as RememberKnowledgeConfirmationReceiptType,
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
  authority_kind?: string | null;
  human_input_request_id?: string | null;
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
    authorityKind: row.authority_kind ?? "automatic",
    humanInputRequestId: row.human_input_request_id ?? null,
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

// The translated errors keep the originating failure as `cause`. The SQLSTATE
// alone collapses distinguishable outcomes - a stale instruction-policy
// baseline and a duplicate-key conflict are both surfaced here - so callers
// that need to tell them apart can still reach the exact database diagnostic
// without re-running the operation.
function translate(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "42501") {
    throw new GovernedLearningActivationAuthorityError(
      "Governed-learning activation is unavailable",
      { cause: error },
    );
  }
  if (state === "23505" || state === "40001") {
    throw new GovernedLearningActivationConflictError(
      "Governed-learning activation conflicted with current authority",
      { cause: error },
    );
  }
  if (state === "23514" || state === "55000" || state === "22023") {
    throw new GovernedLearningActivationInvalidOperationError(
      "Governed-learning activation is no longer eligible",
      { cause: error },
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

/**
 * Activate one confirmable evaluator receipt (`suggest`, `automatic`, or
 * `confidence`) because the exact initiating human answered the bound
 * `remember:<proposalId>` structured human-input question with `save` on the
 * same session/turn generation. The database capability revalidates the human
 * answer, current policy (not `off`), evidence, and destination CAS.
 */
export async function activateHumanConfirmedLearningDecision(
  db: Database,
  raw: { caller: ActivationCaller; request: ActivateHumanConfirmedRequest },
): Promise<ActivationReceipt> {
  const caller = GovernedLearningActivationCaller.parse(raw.caller);
  const request = ActivateHumanConfirmedLearningDecisionRequest.parse(raw.request);
  try {
    return await withWorkspaceSubjectRls(
      db,
      caller.workspaceId,
      caller.subjectId,
      async (scoped) => {
        const rows = await rawRows<ActivationRow>(
          scoped,
          sql`SELECT * FROM activate_human_confirmed_learning_decision(
          current_setting('opengeni.account_id')::uuid,
          ${caller.workspaceId}::uuid,
          ${request.operationId}::uuid,
          ${request.decisionReceiptId}::uuid,
          ${request.humanInputRequestId}::uuid
        )`,
        );
        if (rows.length !== 1 || !rows[0]) {
          throw new Error(
            "Human-confirmed governed-learning activation returned no unique receipt",
          );
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
          WHERE evidence.account_id = current_setting('opengeni.account_id')::uuid
            AND evidence.scope_kind = 'workspace'
            AND evidence.scope_workspace_id = ${input.workspaceId}::uuid
            AND evidence.id = ${input.evidenceId}::uuid
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    if (row.task_note_id) return { kind: "task-note" };
    return { kind: "document", providerKey: row.provider_key };
  });
}

export type GovernedLearningProposalSummary = {
  id: string;
  claimId: string;
  evidenceId: string;
  status: string;
  targetKind: string;
  initiatingHumanSubjectId: string | null;
};

/**
 * Read one workspace-scoped `knowledge_change_proposals` row under workspace
 * RLS. Used by `remember_confirm` to rebuild the evaluator request for the
 * exact proposal the human confirmed; it exposes no content.
 */
export async function getWorkspaceKnowledgeChangeProposalSummary(
  db: Database,
  input: { workspaceId: string; proposalId: string },
): Promise<GovernedLearningProposalSummary | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const rows = await rawRows<{
      id: string;
      claim_id: string;
      evidence_id: string;
      status: string;
      target_kind: string;
      initiating_human_subject_id: string | null;
    }>(
      scoped,
      sql`SELECT proposal.id, proposal.claim_id, proposal.evidence_id, proposal.status,
                 proposal.target_kind, proposal.initiating_human_subject_id
          FROM knowledge_change_proposals proposal
          WHERE proposal.account_id = current_setting('opengeni.account_id')::uuid
            AND proposal.scope_kind = 'workspace'
            AND proposal.scope_workspace_id = ${input.workspaceId}::uuid
            AND proposal.scope_subject_id IS NULL
            AND proposal.id = ${input.proposalId}::uuid
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      claimId: row.claim_id,
      evidenceId: row.evidence_id,
      status: row.status,
      targetKind: row.target_kind,
      initiatingHumanSubjectId: row.initiating_human_subject_id,
    };
  });
}

type KnowledgeConfirmationRow = {
  id: string;
  operation_id: string;
  input_hash: string;
  account_id: string;
  workspace_id: string;
  session_id: string;
  turn_id: string;
  execution_generation: number;
  initiating_human_subject_id: string;
  service_actor_subject_id: string;
  claim_id: string;
  evidence_id: string;
  task_note_id: string;
  task_note_text_hash: string;
  human_input_request_id: string;
  previous_review_id: string;
  previous_review_revision: number | string;
  approval_review_id: string;
  approval_review_revision: number | string;
  created_at: Date | string;
};

/**
 * Approve one user-directed Knowledge claim after the exact initiating human
 * answered the bound `remember:<claimId>` structured human-input question with
 * `save` on the live turn. The database capability revalidates the claim,
 * Task-note evidence, latest `proposed` review, and the canonical question
 * before writing the approval through the guarded service-review path.
 */
export async function confirmRememberKnowledgeClaim(
  db: Database,
  raw: {
    caller: ActivationCaller & {
      sessionId: string;
      turnId: string;
      executionGeneration: number;
    };
    request: ConfirmRememberKnowledgeClaimRequestType;
  },
): Promise<RememberKnowledgeConfirmationReceiptType> {
  const caller = GovernedLearningActivationCaller.parse({
    workspaceId: raw.caller.workspaceId,
    subjectId: raw.caller.subjectId,
  });
  const request = ConfirmRememberKnowledgeClaimRequest.parse(raw.request);
  const { sessionId, turnId, executionGeneration } = raw.caller;
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (
    !uuidPattern.test(sessionId) ||
    !uuidPattern.test(turnId) ||
    !Number.isSafeInteger(executionGeneration) ||
    executionGeneration <= 0
  ) {
    throw new GovernedLearningActivationAuthorityError(
      "remember Knowledge confirmation requires exact turn authority",
    );
  }
  try {
    return await withWorkspaceSubjectRls(
      db,
      caller.workspaceId,
      caller.subjectId,
      async (scoped) => {
        const rows = await rawRows<KnowledgeConfirmationRow>(
          scoped,
          sql`SELECT * FROM confirm_remember_knowledge_claim(
          current_setting('opengeni.account_id')::uuid,
          ${caller.workspaceId}::uuid,
          ${sessionId}::uuid,
          ${turnId}::uuid,
          ${executionGeneration}::integer,
          ${request.operationId}::uuid,
          ${request.claimId}::uuid,
          ${request.humanInputRequestId}::uuid
        )`,
        );
        const row = rows[0];
        if (rows.length !== 1 || !row) {
          throw new Error("remember Knowledge confirmation returned no unique receipt");
        }
        return RememberKnowledgeConfirmationReceipt.parse({
          id: row.id,
          operationId: row.operation_id,
          inputHash: row.input_hash,
          accountId: row.account_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          turnId: row.turn_id,
          executionGeneration: Number(row.execution_generation),
          initiatingHumanSubjectId: row.initiating_human_subject_id,
          serviceActorSubjectId: row.service_actor_subject_id,
          claimId: row.claim_id,
          evidenceId: row.evidence_id,
          taskNoteId: row.task_note_id,
          taskNoteTextHash: row.task_note_text_hash,
          humanInputRequestId: row.human_input_request_id,
          previousReviewId: row.previous_review_id,
          previousReviewRevision: Number(row.previous_review_revision),
          approvalReviewId: row.approval_review_id,
          approvalReviewRevision: Number(row.approval_review_revision),
          createdAt: iso(row.created_at),
        });
      },
    );
  } catch (error) {
    translate(error);
  }
}

/**
 * Read the initiating human bound to one workspace-scoped Knowledge claim under
 * workspace RLS. Used by `remember_confirm` for the Knowledge lane; exposes no
 * content.
 */
export async function getWorkspaceKnowledgeClaimInitiatingHuman(
  db: Database,
  input: { workspaceId: string; claimId: string },
): Promise<string | null> {
  return await withWorkspaceRls(db, input.workspaceId, async (scoped) => {
    const rows = await rawRows<{ initiating_human_subject_id: string | null }>(
      scoped,
      sql`SELECT claim.initiating_human_subject_id
          FROM knowledge_claims claim
          WHERE claim.account_id = current_setting('opengeni.account_id')::uuid
            AND claim.scope_kind = 'workspace'
            AND claim.scope_workspace_id = ${input.workspaceId}::uuid
            AND claim.scope_subject_id IS NULL
            AND claim.id = ${input.claimId}::uuid
          LIMIT 1`,
    );
    return rows[0]?.initiating_human_subject_id ?? null;
  });
}
