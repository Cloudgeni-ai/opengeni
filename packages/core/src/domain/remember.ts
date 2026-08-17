import {
  CompanyBrainGovernedWriteAttempt,
  REMEMBER_HUMAN_INPUT_SAVE_OPTION,
  REMEMBER_HUMAN_INPUT_SKIP_OPTION,
  RememberConfirmReceipt,
  RememberConfirmRequest,
  RememberReceipt,
  RememberRequest,
  rememberHumanInputQuestionId,
  type CompanyBrainGovernedWriteAttempt as Attempt,
  type CompanyBrainGovernedWriteRequest,
  type CompanyBrainLearningPolicyRouteReceipt,
  type GovernedLearningActivationReceipt,
  type RememberConfirmReceipt as RememberConfirmReceiptType,
  type RememberReceipt as RememberReceiptType,
} from "@opengeni/contracts";
import {
  type Database,
  activateHumanConfirmedLearningDecision,
  createTaskNote,
  getWorkspaceKnowledgeChangeProposalSummary,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import {
  createCompanyBrainLearningPolicyRouter,
  derivedGovernedLearningOperationId,
} from "./company-brain-governed-writes";
import { publishGovernedLearningEventToSlack } from "./governed-learning-slack-publication";

export class RememberError extends Error {
  readonly name = "RememberError";
  constructor(
    readonly code:
      | "proposal_unavailable"
      | "proposal_not_confirmable"
      | "human_confirmation_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export type RememberRouterOptions = {
  db: Database;
  learningRouter?: Pick<ReturnType<typeof createCompanyBrainLearningPolicyRouter>, "write">;
  createNote?: typeof createTaskNote;
  activateHumanConfirmed?: typeof activateHumanConfirmedLearningDecision;
  proposalSummary?: typeof getWorkspaceKnowledgeChangeProposalSummary;
  notifyActivation?: (input: {
    db: Database;
    receipt: GovernedLearningActivationReceipt;
    sessionId: string;
    attemptId: string;
  }) => Promise<unknown>;
};

/** Deterministic UUID-shaped id derived from the caller's remember operation id. */
export function derivedRememberOperationId(
  operationId: string,
  stage: "note" | "promotion" | "evaluation" | "activation",
): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`company-brain-remember:v1:${operationId}:${stage}`, "utf8")
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedKeyFor(noteId: string): string {
  return `remember-${noteId.replaceAll("-", "")}`;
}

function promotionRequest(
  request: RememberRequest,
  noteId: string,
): CompanyBrainGovernedWriteRequest {
  const common = {
    operationId: derivedRememberOperationId(request.operationId, "promotion"),
    noteId,
    expectedNoteVersion: 1 as const,
    // The user directed this write, so the claim carries full confidence.
    confidenceBps: 10_000,
    reason: request.reason,
  };
  switch (request.lane) {
    case "preference":
      return {
        ...common,
        kind: "promote_task_note_preference",
        entityType: "ways-of-working",
        normalizedKey: normalizedKeyFor(noteId),
        displayName: request.title,
        predicateKey: "remember.preference",
        stableKey: request.stableKey,
        title: request.title,
        description: request.description,
        precedenceRank: 0,
        conflictStrategy: "override",
        conflictsWith: [],
        expiresAt: null,
      };
    case "instruction_policy":
      return {
        ...common,
        kind: "promote_task_note_instruction_policy",
        entityType: "ways-of-working",
        normalizedKey: normalizedKeyFor(noteId),
        displayName: "User-directed rule",
        predicateKey: "remember.instruction",
        target: request.target,
        expectedCurrentRevisionId: null,
        expectedActivationVersion: 0,
      };
    case "knowledge":
      return {
        ...common,
        kind: "promote_task_note_knowledge",
        entityType: "user-directed",
        normalizedKey: normalizedKeyFor(noteId),
        displayName: request.subject,
        predicateKey: "remember.fact",
      };
  }
}

/**
 * Canonical confirmation question. Migration 0272 reconstructs exactly this
 * prompt/help/options from the proposal and refuses any human-input row that
 * differs, so a misleading agent-authored prompt can never authorize a save.
 * `helpText` truncation is by code point to match PostgreSQL `left()`.
 */
function humanInputPrompt(request: RememberRequest, proposalId: string) {
  const what =
    request.lane === "preference"
      ? "workspace preference"
      : request.lane === "instruction_policy"
        ? "mandatory workspace rule"
        : "workspace knowledge";
  return {
    questions: [
      {
        id: rememberHumanInputQuestionId(proposalId),
        kind: "single_select" as const,
        prompt: `Save this as a ${what} for everyone in this workspace?`,
        label: "Remember",
        helpText: Array.from(request.content).slice(0, 2_000).join(""),
        options: [
          { id: REMEMBER_HUMAN_INPUT_SAVE_OPTION, label: "Save" },
          { id: REMEMBER_HUMAN_INPUT_SKIP_OPTION, label: "Don't save" },
        ],
        required: true,
        allowOther: false,
      },
    ],
    allowSkip: false as const,
  };
}

function activationSummary(receipt: GovernedLearningActivationReceipt) {
  return {
    receiptId: receipt.id,
    destination: receipt.destination,
    destinationRevisionId: receipt.destinationRevisionId,
    effectiveAt: receipt.effectiveAt,
    authorityKind: receipt.authorityKind,
    undo: "learning_history" as const,
  };
}

/**
 * Explicit user-directed remember. Content becomes an exact task note (the
 * evidence), the note is promoted through the frozen learning policy router,
 * and the result is either an immediate activation (automatic policy), a
 * proposal for the human Knowledge review lifecycle, or a durable proposal that
 * still needs one bound human confirmation through `request_human_input`.
 */
export function createRememberRouter(options: RememberRouterOptions): {
  remember: (input: { attempt: unknown; request: unknown }) => Promise<RememberReceiptType>;
  confirm: (input: { attempt: unknown; request: unknown }) => Promise<RememberConfirmReceiptType>;
} {
  const learningRouter =
    options.learningRouter ?? createCompanyBrainLearningPolicyRouter({ db: options.db });
  const createNote = options.createNote ?? createTaskNote;
  const activateHumanConfirmed =
    options.activateHumanConfirmed ?? activateHumanConfirmedLearningDecision;
  const proposalSummary = options.proposalSummary ?? getWorkspaceKnowledgeChangeProposalSummary;
  const notifyActivation =
    options.notifyActivation ??
    (async ({ db, receipt, sessionId, attemptId }) =>
      publishGovernedLearningEventToSlack(db, {
        kind: "activated",
        receipt,
        sessionId,
        attemptId,
      }));

  async function attemptOf(input: unknown): Promise<Attempt> {
    return CompanyBrainGovernedWriteAttempt.parse(input);
  }

  return {
    async remember(input) {
      const attempt = await attemptOf(input.attempt);
      const request = RememberRequest.parse(input.request);
      const note = await createNote(options.db, {
        ...attempt,
        operationId: derivedRememberOperationId(request.operationId, "note"),
        kind: "decision",
        text: request.content,
        expiresInDays: 30,
      });
      const route: CompanyBrainLearningPolicyRouteReceipt = await learningRouter.write({
        attempt,
        request: promotionRequest(request, note.note.id),
      });
      const base = {
        operationId: request.operationId,
        lane: request.lane,
        scope: request.scope,
      };
      if (route.decision === "blocked" || route.write === null) {
        return RememberReceipt.parse({ ...base, status: "blocked", reason: "learning_policy_off" });
      }
      if (route.write.knowledgeChangeProposalId === null) {
        return RememberReceipt.parse({
          ...base,
          status: "proposed_for_review",
          noteId: note.note.id,
          claimId: route.write.claimId,
          evidenceId: route.write.evidenceId,
          reviewId: route.write.reviewId,
        });
      }
      const proposalId = route.write.knowledgeChangeProposalId;
      if (route.activation.activated && route.activation.receiptId) {
        return RememberReceipt.parse({
          ...base,
          status: "activated",
          noteId: note.note.id,
          proposalId,
          learning: route.learning,
          activation: {
            receiptId: route.activation.receiptId,
            destination: route.activation.destination,
            destinationRevisionId: route.activation.destinationRevisionId,
            effectiveAt: route.activation.effectiveAt,
            authorityKind: "automatic",
            undo: "learning_history",
          },
        });
      }
      return RememberReceipt.parse({
        ...base,
        status: "confirmation_required",
        noteId: note.note.id,
        proposalId,
        learning: route.learning,
        learningFailure: route.learningFailure,
        humanInput: humanInputPrompt(request, proposalId),
        confirmWith: "remember_confirm",
      });
    },

    async confirm(input) {
      const attempt = await attemptOf(input.attempt);
      const request = RememberConfirmRequest.parse(input.request);
      const proposal = await proposalSummary(options.db, {
        workspaceId: attempt.workspaceId,
        proposalId: request.proposalId,
      });
      if (!proposal || !proposal.initiatingHumanSubjectId) {
        throw new RememberError("proposal_unavailable", "The remember proposal is not available");
      }
      if (proposal.status !== "proposed") {
        throw new RememberError(
          "proposal_not_confirmable",
          "The remember proposal is no longer awaiting confirmation",
        );
      }
      // The database capability proves the exact human answered the bound
      // question with `save` on this session/turn generation before writing.
      const activation = await activateHumanConfirmed(options.db, {
        caller: { workspaceId: attempt.workspaceId, subjectId: proposal.initiatingHumanSubjectId },
        request: {
          operationId: derivedGovernedLearningOperationId(request.operationId, "activation"),
          decisionReceiptId: request.decisionReceiptId,
          humanInputRequestId: request.humanInputRequestId,
        },
      });
      try {
        await notifyActivation({
          db: options.db,
          receipt: activation,
          sessionId: attempt.sessionId,
          attemptId: attempt.attemptId,
        });
      } catch {
        // Notification is best-effort; the durable receipts already exist.
      }
      return RememberConfirmReceipt.parse({
        status: "activated",
        operationId: request.operationId,
        proposalId: proposal.id,
        decisionReceiptId: request.decisionReceiptId,
        activation: activationSummary(activation),
      });
    },
  };
}
