import { createHash } from "node:crypto";
import {
  CompanyBrainGovernedWriteAttempt,
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
  PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS,
  PREFERENCE_REGISTRY_TITLE_MAX_CHARS,
  type CompanyBrainGovernedWriteReceipt as CompanyBrainGovernedWriteReceiptType,
  type CompanyBrainGovernedWriteRequest as CompanyBrainGovernedWriteRequestType,
  type ScopedKnowledgeActor,
} from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setSubjectRlsContext, withRlsContext } from "./database";
import { sanitizePreferenceDescriptorText } from "./preference-registry";
import {
  appendKnowledgeClaimReview,
  createKnowledgeChangeProposal,
  linkKnowledgeClaims,
  scopedKnowledgeInputHash,
  ScopedKnowledgeAuthorityError,
  ScopedKnowledgeInvalidOperationError,
} from "./scoped-knowledge";
import * as schema from "./schema";
import { createWorkspaceInstructionPolicyKnowledgeProposal } from "./workspace-instruction-policies";

export class CompanyBrainGovernedWriteAuthorityError extends Error {
  readonly name = "CompanyBrainGovernedWriteAuthorityError";
}

export class CompanyBrainGovernedWriteInvalidOperationError extends Error {
  readonly name = "CompanyBrainGovernedWriteInvalidOperationError";
}

type AttemptAuthority = CompanyBrainGovernedWriteAttempt & {
  initiatingHumanSubjectId: string;
};

type WorkspaceEvidence = {
  claimId: string;
  evidenceId: string;
  confidenceBps: number;
};

type NormalizedPreferenceProposal = {
  stableKey: string;
  title: string;
  description: string;
  content: string;
  precedenceRank: number;
  conflictStrategy: "override" | "merge" | "reject" | "inform";
  conflictsWith: string[];
  expiresAt: string | null;
};

function derivedOperationId(operationId: string, label: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`company-brain-governed-write:v1:${operationId}:${label}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function preferenceProposalContent(
  request: Extract<CompanyBrainGovernedWriteRequestType, { kind: "propose_preference" }>,
): string {
  return JSON.stringify(normalizePreferenceProposal(request));
}

function normalizePreferenceProposal(
  request: Extract<CompanyBrainGovernedWriteRequestType, { kind: "propose_preference" }>,
): NormalizedPreferenceProposal {
  const title = sanitizePreferenceDescriptorText(request.title)
    .slice(0, PREFERENCE_REGISTRY_TITLE_MAX_CHARS)
    .trim();
  const description = sanitizePreferenceDescriptorText(request.description)
    .slice(0, PREFERENCE_REGISTRY_DESCRIPTOR_DESCRIPTION_MAX_CHARS)
    .trim();
  if (!title || !description) {
    throw new CompanyBrainGovernedWriteInvalidOperationError(
      "Preference proposal title and description must contain visible plain text",
    );
  }
  return {
    stableKey: request.stableKey,
    title,
    description,
    content: request.content,
    precedenceRank: request.precedenceRank,
    conflictStrategy: request.conflictStrategy,
    conflictsWith: [...new Set(request.conflictsWith)].sort(),
    expiresAt: request.expiresAt ? new Date(request.expiresAt).toISOString() : null,
  };
}

function instructionTargetKey(
  request: Extract<CompanyBrainGovernedWriteRequestType, { kind: "propose_instruction_policy" }>,
): string {
  return [request.target.kind, request.target.scope, request.target.roleKey ?? "global"].join(":");
}

async function withCompanyBrainGovernedWriteAuthority<T>(
  db: Database,
  attempt: CompanyBrainGovernedWriteAttempt,
  fn: (db: Database, authority: AttemptAuthority) => Promise<T>,
): Promise<T> {
  return await withRlsContext(
    db,
    { accountId: attempt.accountId, workspaceId: attempt.workspaceId },
    async (scopedDb) => {
      const rows = await rawRows<{ initiating_human_subject_id: string }>(
        scopedDb,
        sql`
        WITH locked_workspace AS MATERIALIZED (
          SELECT workspace.id, workspace.account_id
          FROM workspaces workspace
          WHERE workspace.id = ${attempt.workspaceId}::uuid
            AND workspace.account_id = ${attempt.accountId}::uuid
          FOR KEY SHARE OF workspace
        ), locked_session AS MATERIALIZED (
          SELECT session.id, session.account_id, session.workspace_id, session.active_turn_id
          FROM sessions session
          JOIN locked_workspace workspace
            ON workspace.id = session.workspace_id
            AND workspace.account_id = session.account_id
          WHERE session.id = ${attempt.sessionId}::uuid
            AND session.active_turn_id = ${attempt.turnId}::uuid
          FOR SHARE OF session
        ), locked_turn AS MATERIALIZED (
          SELECT turn.id, turn.account_id, turn.workspace_id, turn.session_id,
            turn.active_attempt_id, turn.execution_generation,
            coalesce(
              turn.initiating_human_subject_id,
              case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
            ) as initiating_human_subject_id
          FROM session_turns turn
          JOIN locked_session session
            ON session.id = turn.session_id
            AND session.workspace_id = turn.workspace_id
            AND session.account_id = turn.account_id
          WHERE turn.id = ${attempt.turnId}::uuid
            AND turn.active_attempt_id = ${attempt.attemptId}::uuid
            AND turn.execution_generation = ${attempt.executionGeneration}
            AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
            AND length(btrim(coalesce(
              turn.initiating_human_subject_id,
              case when turn.initiator_kind = 'subject' then turn.initiator_subject_id end
            ))) BETWEEN 1 AND 1024
          FOR SHARE OF turn
        ), locked_attempt AS MATERIALIZED (
          SELECT attempt.id, attempt.account_id, attempt.workspace_id,
            attempt.session_id, attempt.turn_id, attempt.execution_generation
          FROM session_turn_attempts attempt
          JOIN locked_turn turn
            ON turn.id = attempt.turn_id
            AND turn.session_id = attempt.session_id
            AND turn.workspace_id = attempt.workspace_id
            AND turn.account_id = attempt.account_id
          WHERE attempt.id = ${attempt.attemptId}::uuid
            AND attempt.execution_generation = ${attempt.executionGeneration}
            AND attempt.state IN ('claimed', 'running')
          FOR SHARE OF attempt
        )
        SELECT turn.initiating_human_subject_id
        FROM locked_workspace workspace
        JOIN locked_session session ON true
        JOIN locked_turn turn ON true
        JOIN locked_attempt attempt ON true
        WHERE workspace.account_id = attempt.account_id
          AND workspace.id = attempt.workspace_id
          AND session.id = attempt.session_id
          AND turn.id = attempt.turn_id
        `,
      );
      const initiatingHumanSubjectId = rows[0]?.initiating_human_subject_id;
      if (!initiatingHumanSubjectId) {
        throw new CompanyBrainGovernedWriteAuthorityError(
          "Governed Company Brain writes require the exact current attempt, generation, immutable human initiator, and no live interruption",
        );
      }
      // Lock acquisition may wait behind Pause/Steer. Under READ COMMITTED, a
      // NOT EXISTS evaluated in that same statement can retain its pre-wait
      // snapshot and miss the newly committed interruption. Recheck in a fresh
      // statement after all canonical rows are locked; interruption writers now
      // cannot advance until this transaction completes.
      const revalidated = await rawRows<{ id: string }>(
        scopedDb,
        sql`
        SELECT attempt.id
        FROM sessions session
        JOIN session_turns turn
          ON turn.account_id = session.account_id
          AND turn.workspace_id = session.workspace_id
          AND turn.session_id = session.id
        JOIN session_turn_attempts attempt
          ON attempt.account_id = turn.account_id
          AND attempt.workspace_id = turn.workspace_id
          AND attempt.session_id = turn.session_id
          AND attempt.turn_id = turn.id
        WHERE session.account_id = ${attempt.accountId}::uuid
          AND session.workspace_id = ${attempt.workspaceId}::uuid
          AND session.id = ${attempt.sessionId}::uuid
          AND session.active_turn_id = ${attempt.turnId}::uuid
          AND turn.id = ${attempt.turnId}::uuid
          AND turn.active_attempt_id = ${attempt.attemptId}::uuid
          AND turn.execution_generation = ${attempt.executionGeneration}
          AND turn.status IN ('running', 'requires_action', 'recovering', 'waiting_capacity')
          AND attempt.id = ${attempt.attemptId}::uuid
          AND attempt.execution_generation = ${attempt.executionGeneration}
          AND attempt.state IN ('claimed', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM session_attempt_interruptions interruption
            WHERE interruption.workspace_id = attempt.workspace_id
              AND interruption.attempt_id = attempt.id
              AND interruption.state IN ('pending', 'delivered', 'acknowledged')
          )
        `,
      );
      if (!revalidated[0]) {
        throw new CompanyBrainGovernedWriteAuthorityError(
          "Governed Company Brain write authority changed while admission was waiting",
        );
      }
      await setSubjectRlsContext(scopedDb, initiatingHumanSubjectId);
      return await fn(scopedDb, { ...attempt, initiatingHumanSubjectId });
    },
  );
}

async function requireWorkspaceEvidence(
  db: Database,
  authority: AttemptAuthority,
  claimId: string,
  evidenceId: string,
  replacesClaimId: string | null,
): Promise<WorkspaceEvidence> {
  const claimIds = replacesClaimId === null ? [claimId] : [claimId, replacesClaimId];
  const [claims, evidenceRows] = await Promise.all([
    db
      .select()
      .from(schema.knowledgeClaims)
      .where(
        and(
          eq(schema.knowledgeClaims.accountId, authority.accountId),
          inArray(schema.knowledgeClaims.id, claimIds),
        ),
      ),
    db
      .select()
      .from(schema.knowledgeClaimEvidence)
      .where(
        and(
          eq(schema.knowledgeClaimEvidence.accountId, authority.accountId),
          eq(schema.knowledgeClaimEvidence.id, evidenceId),
        ),
      )
      .limit(1),
  ]);
  const claim = claims.find((candidate) => candidate.id === claimId);
  const replaced = replacesClaimId
    ? claims.find((candidate) => candidate.id === replacesClaimId)
    : null;
  const evidence = evidenceRows[0];
  const isExactWorkspaceClaim = (candidate: typeof claim | null): boolean =>
    candidate != null &&
    candidate.scopeKind === "workspace" &&
    candidate.scopeWorkspaceId === authority.workspaceId &&
    candidate.scopeSubjectId === null;
  if (
    !isExactWorkspaceClaim(claim) ||
    !evidence ||
    evidence.claimId !== claimId ||
    evidence.polarity !== "supports" ||
    evidence.scopeKind !== "workspace" ||
    evidence.scopeWorkspaceId !== authority.workspaceId ||
    evidence.scopeSubjectId !== null
  ) {
    throw new CompanyBrainGovernedWriteInvalidOperationError(
      "Governed writes require exact supporting evidence for a workspace-local Knowledge claim",
    );
  }
  if (
    replacesClaimId !== null &&
    (replacesClaimId === claimId || !isExactWorkspaceClaim(replaced))
  ) {
    throw new CompanyBrainGovernedWriteInvalidOperationError(
      "Knowledge correction requires a different replaced claim in the same workspace scope",
    );
  }
  return { claimId, evidenceId, confidenceBps: claim!.confidenceBps };
}

async function createWorkspacePreferenceProposalForAttempt(
  db: Database,
  authority: AttemptAuthority,
  request: Extract<CompanyBrainGovernedWriteRequestType, { kind: "propose_preference" }>,
  knowledgeProposalId: string,
  inputHash: string,
): Promise<{ preferenceId: string; revisionId: string }> {
  const normalized = normalizePreferenceProposal(request);
  const [result] = await rawRows<{ preferenceId: string; revisionId: string }>(
    db,
    sql`
      SELECT
        proposal.preference_id AS "preferenceId",
        proposal.revision_id AS "revisionId"
      FROM preference_registry_create_knowledge_proposal_for_attempt(
        ${authority.accountId}::uuid,
        ${authority.workspaceId}::uuid,
        ${authority.sessionId}::uuid,
        ${authority.turnId}::uuid,
        ${authority.attemptId}::uuid,
        ${authority.executionGeneration},
        ${request.operationId}::uuid,
        ${inputHash},
        ${knowledgeProposalId}::uuid,
        ${normalized.stableKey},
        ${normalized.title},
        ${normalized.description},
        ${normalized.content},
        ${normalized.precedenceRank},
        ${normalized.conflictStrategy},
        ${JSON.stringify(normalized.conflictsWith)}::jsonb,
        ${normalized.expiresAt}::timestamptz,
        ${request.reason}
      ) proposal
    `,
  );
  if (!result) throw new Error("Preference Knowledge proposal returned no durable receipt");
  return result;
}

function receipt(
  input: Omit<CompanyBrainGovernedWriteReceiptType, "outcome" | "effectiveBoundary" | "rollback">,
): CompanyBrainGovernedWriteReceiptType {
  return CompanyBrainGovernedWriteReceipt.parse({
    ...input,
    outcome: "proposed",
    effectiveBoundary: "human_review_required",
    rollback: { supported: false, mechanism: "not_applicable_proposal_only" },
  });
}

/**
 * Route one explicit workspace-local proposal. This owns write admission only;
 * selector snapshots, logical-turn receipts, tools, and activation remain out of scope.
 */
export async function writeCompanyBrainGovernedProposal(
  db: Database,
  rawInput: {
    attempt: CompanyBrainGovernedWriteAttempt;
    request: CompanyBrainGovernedWriteRequestType;
  },
): Promise<CompanyBrainGovernedWriteReceiptType> {
  const attempt = CompanyBrainGovernedWriteAttempt.parse(rawInput.attempt);
  const request = CompanyBrainGovernedWriteRequest.parse(rawInput.request);
  const inputHash = scopedKnowledgeInputHash({ attempt, request });
  return await withCompanyBrainGovernedWriteAuthority(db, attempt, async (scopedDb, authority) => {
    const evidence = await requireWorkspaceEvidence(
      scopedDb,
      authority,
      request.claimId,
      request.evidenceId,
      request.kind === "correct_knowledge" ? request.replacesClaimId : null,
    );
    const actor: ScopedKnowledgeActor = {
      kind: "service",
      subjectId: `service:company-brain-governed-write:${inputHash}`,
      initiatingHumanSubjectId: authority.initiatingHumanSubjectId,
    };
    const review = await appendKnowledgeClaimReview(scopedDb, {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      operationId: derivedOperationId(request.operationId, "guard"),
      actor,
      claimId: request.claimId,
      state: "proposed",
      reason: request.reason,
    });

    if (request.kind === "propose_knowledge") {
      return receipt({
        operationId: request.operationId,
        inputHash,
        workspaceId: authority.workspaceId,
        destination: "knowledge",
        claimId: evidence.claimId,
        evidenceId: evidence.evidenceId,
        relationId: null,
        reviewId: review.id,
        knowledgeChangeProposalId: null,
        destinationProposalId: null,
        destinationRevisionId: null,
      });
    }

    if (request.kind === "correct_knowledge") {
      const relation = await linkKnowledgeClaims(scopedDb, {
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        operationId: derivedOperationId(request.operationId, "knowledge-correction"),
        actor,
        relationType: "supersedes",
        fromClaimId: request.claimId,
        toClaimId: request.replacesClaimId,
      });
      return receipt({
        operationId: request.operationId,
        inputHash,
        workspaceId: authority.workspaceId,
        destination: "knowledge",
        claimId: evidence.claimId,
        evidenceId: evidence.evidenceId,
        relationId: relation.id,
        reviewId: review.id,
        knowledgeChangeProposalId: null,
        destinationProposalId: null,
        destinationRevisionId: null,
      });
    }

    const changeProposal = await createKnowledgeChangeProposal(scopedDb, {
      accountId: authority.accountId,
      workspaceId: authority.workspaceId,
      operationId: derivedOperationId(request.operationId, "knowledge-change-proposal"),
      actor,
      claimId: request.claimId,
      evidenceId: request.evidenceId,
      targetKind:
        request.kind === "propose_instruction_policy" ? "instruction_policy" : "preference",
      targetScope: "workspace",
      targetKey:
        request.kind === "propose_instruction_policy"
          ? instructionTargetKey(request)
          : request.stableKey,
      content:
        request.kind === "propose_instruction_policy"
          ? request.content
          : preferenceProposalContent(request),
    });

    if (request.kind === "propose_instruction_policy") {
      const proposal = await createWorkspaceInstructionPolicyKnowledgeProposal(scopedDb, {
        operationId: derivedOperationId(request.operationId, "instruction-proposal"),
        accountId: authority.accountId,
        workspaceId: authority.workspaceId,
        ...request.target,
        content: request.content,
        knowledgeProposalId: changeProposal.id,
        knowledgeProposalContentHash: changeProposal.contentHash,
        confidenceBps: evidence.confidenceBps,
        expectedCurrentRevisionId: request.expectedCurrentRevisionId,
        expectedActivationVersion: request.expectedActivationVersion,
        createdBySubjectId: actor.subjectId,
      });
      return receipt({
        operationId: request.operationId,
        inputHash,
        workspaceId: authority.workspaceId,
        destination: "instruction_policy",
        claimId: evidence.claimId,
        evidenceId: evidence.evidenceId,
        relationId: null,
        reviewId: review.id,
        knowledgeChangeProposalId: changeProposal.id,
        destinationProposalId: proposal.id,
        destinationRevisionId: proposal.draft.id,
      });
    }

    const proposal = await createWorkspacePreferenceProposalForAttempt(
      scopedDb,
      authority,
      request,
      changeProposal.id,
      inputHash,
    );
    return receipt({
      operationId: request.operationId,
      inputHash,
      workspaceId: authority.workspaceId,
      destination: "preference",
      claimId: evidence.claimId,
      evidenceId: evidence.evidenceId,
      relationId: null,
      reviewId: review.id,
      knowledgeChangeProposalId: changeProposal.id,
      destinationProposalId: proposal.preferenceId,
      destinationRevisionId: proposal.revisionId,
    });
  }).catch((error: unknown) => {
    if (
      error instanceof CompanyBrainGovernedWriteAuthorityError ||
      error instanceof CompanyBrainGovernedWriteInvalidOperationError
    ) {
      throw error;
    }
    if (error instanceof ScopedKnowledgeAuthorityError) {
      throw new CompanyBrainGovernedWriteAuthorityError(error.message);
    }
    if (error instanceof ScopedKnowledgeInvalidOperationError) {
      throw new CompanyBrainGovernedWriteInvalidOperationError(error.message);
    }
    throw error;
  });
}
