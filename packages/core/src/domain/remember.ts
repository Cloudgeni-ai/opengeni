import {
  CompanyBrainGovernedWriteAttempt,
  REMEMBER_HUMAN_INPUT_SAVE_OPTION,
  REMEMBER_HUMAN_INPUT_SKIP_OPTION,
  TASK_NOTE_MAX_LIFETIME_DAYS,
  RememberConfirmReceipt,
  RememberConfirmRequest,
  RememberReceipt,
  RememberRequest,
  rememberHumanInputQuestionId,
  type CompanyBrainGovernedWriteAttempt as Attempt,
  type CompanyBrainGovernedWriteRequest,
  type RememberLane,
  type CompanyBrainLearningPolicyRouteReceipt,
  type GovernedLearningActivationReceipt,
  type RememberConfirmReceipt as RememberConfirmReceiptType,
  type RememberReceipt as RememberReceiptType,
} from "@opengeni/contracts";
import {
  type Database,
  INSTRUCTION_POLICY_STALE_BASELINE_DIAGNOSTIC,
  WorkspaceInstructionPolicyOnboardingProposalStaleError,
  activateHumanConfirmedLearningDecision,
  archiveTaskNote,
  confirmRememberKnowledgeClaim,
  createTaskNote,
  getWorkspaceInstructionPolicyBaseline,
  getWorkspaceKnowledgeChangeProposalSummary,
  getWorkspaceKnowledgeClaimInitiatingHuman,
  materializeConfirmedRememberKnowledgeMemory,
  nestedPostgresSqlState,
  rebaselineWorkspaceInstructionPolicyKnowledgeProposal,
} from "@opengeni/db";
import { createHash } from "node:crypto";
import {
  createCompanyBrainLearningPolicyRouter,
  derivedGovernedLearningOperationId,
  dispatchBestEffortGovernedLearningNotification,
} from "./company-brain-governed-writes";
import { publishGovernedLearningEventToSlack } from "./governed-learning-slack-publication";

// A confirmation may need to lose a race with a concurrent activation more
// than once before it lands, but it must not retry forever.
const REBASELINE_ATTEMPTS = 3;

export class RememberError extends Error {
  readonly name = "RememberError";
  constructor(
    readonly code:
      | "proposal_unavailable"
      | "proposal_not_confirmable"
      | "human_confirmation_unavailable"
      | "baseline_stale",
    message: string,
  ) {
    super(message);
  }
}

// The database layer collapses several SQLSTATEs into one typed conflict, so
// the exact diagnostic lives on the preserved `cause` chain rather than the
// outermost message.
function mentionsStaleInstructionBaseline(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth += 1) {
    if (current.message.includes(INSTRUCTION_POLICY_STALE_BASELINE_DIAGNOSTIC)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * A moved instruction-policy head is an ordinary, recoverable race: the agent
 * read a baseline, someone activated a policy, and the compare-and-set caught
 * it. It surfaced as an untyped Error (propose side) or a raw SQLSTATE 40001
 * (confirm side) with nothing telling the caller what to do about it. Convert
 * both into one typed, actionable failure and leave every other error exactly
 * as it was.
 */
function asRememberFailure(error: unknown): unknown {
  if (error instanceof WorkspaceInstructionPolicyOnboardingProposalStaleError) {
    return new RememberError(
      "baseline_stale",
      "The workspace instruction policy changed while this rule was being prepared. " +
        "Call remember again to rebuild it against the current policy.",
    );
  }
  if (nestedPostgresSqlState(error) === "40001" && mentionsStaleInstructionBaseline(error)) {
    return new RememberError(
      "baseline_stale",
      "The workspace instruction policy changed after this rule was proposed, so the " +
        "confirmation no longer applies to the current policy. Call remember again to " +
        "rebuild it against the current policy and ask for confirmation once more.",
    );
  }
  return error;
}

export type RememberRouterOptions = {
  db: Database;
  learningRouter?: Pick<ReturnType<typeof createCompanyBrainLearningPolicyRouter>, "write">;
  createNote?: typeof createTaskNote;
  archiveNote?: typeof archiveTaskNote;
  rebaselineProposal?: typeof rebaselineWorkspaceInstructionPolicyKnowledgeProposal;
  activateHumanConfirmed?: typeof activateHumanConfirmedLearningDecision;
  confirmKnowledgeClaim?: typeof confirmRememberKnowledgeClaim;
  materializeKnowledgeMemory?: typeof materializeConfirmedRememberKnowledgeMemory;
  proposalSummary?: typeof getWorkspaceKnowledgeChangeProposalSummary;
  claimInitiatingHuman?: typeof getWorkspaceKnowledgeClaimInitiatingHuman;
  instructionPolicyBaseline?: typeof getWorkspaceInstructionPolicyBaseline;
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
  stage: "note" | "note-archive" | "promotion" | "evaluation" | "activation" | "rebaseline",
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
  instructionBaseline: {
    expectedCurrentRevisionId: string | null;
    expectedActivationVersion: number;
  },
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
        expectedCurrentRevisionId: instructionBaseline.expectedCurrentRevisionId,
        expectedActivationVersion: instructionBaseline.expectedActivationVersion,
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

/** Bound for the card title; `HumanInputQuestion.label` accepts 128 characters. */
const REMEMBER_LABEL_MAX_CHARS = 128;

/**
 * What saving this costs, shown on the confirmation card so a human can judge
 * the length before agreeing. A mandatory rule is composed into the prompt of
 * every session it applies to; a preference contributes only its short
 * descriptor to that prompt and keeps its content behind on-demand retrieval;
 * knowledge is retrieval evidence and never joins the always-composed prefix.
 *
 * `HumanInputForm` renders a single question's `label` as the card heading and
 * its `prompt` as the sub-text, so this stays a title with a parenthetical
 * rather than a sentence: the question the human answers has to keep reading as
 * the heading of the card.
 *
 * This deliberately lives on `label` rather than `helpText`: migrations 0272 /
 * 0274 / 0284 / 0293 / 0316 byte-verify the reconstructed `prompt`, `helpText`,
 * and `options` against the exact Task-note text before authorizing an
 * activation, and `label` is the one field of the canonical question those
 * capabilities do not constrain.
 */
export function rememberConfirmationLabel(input: {
  lane: RememberLane;
  contentChars: number;
  /** Role-scoped rules compose only for sessions bound to that role. */
  policyScope?: "global" | "role" | undefined;
}): string {
  const cost =
    input.lane === "instruction_policy"
      ? input.policyScope === "role"
        ? "in every prompt for this role"
        : "in every session prompt"
      : input.lane === "preference"
        ? "summary in every prompt"
        : "retrieved when relevant";
  return `Remember (${input.contentChars} chars, ${cost})`.slice(0, REMEMBER_LABEL_MAX_CHARS);
}

/**
 * Canonical confirmation question. Migration 0272 reconstructs exactly this
 * prompt/help/options from the proposal and refuses any human-input row that
 * differs, so a misleading agent-authored prompt can never authorize a save.
 * `helpText` truncation is by code point to match PostgreSQL `left()`.
 */
function humanInputPrompt(request: RememberRequest, targetId: string) {
  const prompt =
    request.lane === "preference"
      ? "Save this as a workspace preference for everyone in this workspace?"
      : request.lane === "instruction_policy"
        ? "Save this as a mandatory workspace rule for everyone in this workspace?"
        : "Save this as workspace knowledge for everyone in this workspace?";
  return {
    questions: [
      {
        id: rememberHumanInputQuestionId(targetId),
        kind: "single_select" as const,
        prompt,
        label: rememberConfirmationLabel({
          lane: request.lane,
          contentChars: Array.from(request.content).length,
          policyScope: request.lane === "instruction_policy" ? request.target.scope : undefined,
        }),
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
 * A confirmed Knowledge claim is then materialized as a keyword-searchable
 * Memory record from its exact approved Task-note text.
 */
export function createRememberRouter(options: RememberRouterOptions): {
  remember: (input: { attempt: unknown; request: unknown }) => Promise<RememberReceiptType>;
  confirm: (input: { attempt: unknown; request: unknown }) => Promise<RememberConfirmReceiptType>;
} {
  const learningRouter =
    options.learningRouter ?? createCompanyBrainLearningPolicyRouter({ db: options.db });
  const createNote = options.createNote ?? createTaskNote;
  const archiveNote = options.archiveNote ?? archiveTaskNote;
  const rebaselineProposal =
    options.rebaselineProposal ?? rebaselineWorkspaceInstructionPolicyKnowledgeProposal;
  const activateHumanConfirmed =
    options.activateHumanConfirmed ?? activateHumanConfirmedLearningDecision;
  const confirmKnowledgeClaim = options.confirmKnowledgeClaim ?? confirmRememberKnowledgeClaim;
  const materializeKnowledgeMemory =
    options.materializeKnowledgeMemory ?? materializeConfirmedRememberKnowledgeMemory;
  const proposalSummary = options.proposalSummary ?? getWorkspaceKnowledgeChangeProposalSummary;
  const claimInitiatingHuman =
    options.claimInitiatingHuman ?? getWorkspaceKnowledgeClaimInitiatingHuman;
  const instructionPolicyBaseline =
    options.instructionPolicyBaseline ?? getWorkspaceInstructionPolicyBaseline;
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
        expiresInDays: TASK_NOTE_MAX_LIFETIME_DAYS,
      });
      // A user-directed rule must bind to the exact current activation
      // baseline of its target; a workspace with an active head is the norm.
      const instructionBaseline =
        request.lane === "instruction_policy"
          ? await instructionPolicyBaseline(options.db, {
              workspaceId: attempt.workspaceId,
              target: request.target,
            })
          : { expectedCurrentRevisionId: null, expectedActivationVersion: 0 };
      // The evidence note has to exist before the governed write (the write
      // promotes it), so a failed write would otherwise strand a live note for
      // its full lifetime with nothing pointing at it. Archive it on the way
      // out, then surface the original failure.
      let route: CompanyBrainLearningPolicyRouteReceipt;
      try {
        route = await learningRouter.write({
          attempt,
          request: promotionRequest(request, note.note.id, instructionBaseline),
        });
      } catch (error) {
        await archiveNote(options.db, {
          ...attempt,
          operationId: derivedRememberOperationId(request.operationId, "note-archive"),
          noteId: note.note.id,
          expectedVersion: note.note.version,
          reason: "The remember write this note was created for did not complete.",
        }).catch(() => undefined);
        throw asRememberFailure(error);
      }
      const base = {
        operationId: request.operationId,
        lane: request.lane,
        scope: request.scope,
      };
      if (route.decision === "blocked" || route.write === null) {
        return RememberReceipt.parse({
          ...base,
          status: "blocked",
          reason: "learning_policy_off",
        });
      }
      if (route.write.knowledgeChangeProposalId === null) {
        // Knowledge is owned by the human review lifecycle: the same one-click
        // confirmation approves the claim, bound to the claim id.
        return RememberReceipt.parse({
          ...base,
          status: "confirmation_required",
          noteId: note.note.id,
          proposalId: null,
          claimId: route.write.claimId,
          learning: null,
          learningFailure: null,
          humanInput: humanInputPrompt(request, route.write.claimId),
          confirmWith: "remember_confirm",
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
        claimId: route.write.claimId,
        learning: route.learning,
        learningFailure: route.learningFailure,
        humanInput: humanInputPrompt(request, proposalId),
        confirmWith: "remember_confirm",
      });
    },

    async confirm(input) {
      const attempt = await attemptOf(input.attempt);
      const request = RememberConfirmRequest.parse(input.request);
      if (request.target === "knowledge_claim") {
        // The database capability proves the exact human answered the bound
        // question with `save` on this live turn and that the claim is still
        // awaiting review before writing the approval.
        const initiatingHuman = await claimInitiatingHuman(options.db, {
          workspaceId: attempt.workspaceId,
          claimId: request.claimId,
        });
        if (!initiatingHuman) {
          throw new RememberError("proposal_unavailable", "The remember claim is not available");
        }
        // Approval and Memory materialization are one outer transaction. The
        // nested RLS helpers use savepoints, so a failed Memory write rolls the
        // approval back instead of leaving an approved but unretrievable claim.
        const { receipt, materialization } = await options.db.transaction(async (tx) => {
          const transaction = tx as unknown as Database;
          const activationReceipt = await confirmKnowledgeClaim(transaction, {
            caller: {
              workspaceId: attempt.workspaceId,
              subjectId: initiatingHuman,
              sessionId: attempt.sessionId,
              turnId: attempt.turnId,
              executionGeneration: attempt.executionGeneration,
            },
            request: {
              operationId: request.operationId,
              claimId: request.claimId,
              humanInputRequestId: request.humanInputRequestId,
            },
          });
          const materializedMemory = await materializeKnowledgeMemory(
            transaction,
            activationReceipt,
          );
          return { receipt: activationReceipt, materialization: materializedMemory };
        });
        return RememberConfirmReceipt.parse({
          status: "activated",
          operationId: request.operationId,
          proposalId: null,
          claimId: receipt.claimId,
          decisionReceiptId: null,
          activation: {
            destination: "knowledge",
            receiptId: receipt.id,
            claimId: receipt.claimId,
            memoryId: materialization.memoryId,
            approvalReviewId: receipt.approvalReviewId,
            effectiveAt: receipt.createdAt,
            authorityKind: "human_confirmed",
            undo: "memory_management",
          },
        });
      }
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
      // The human has already answered "save". If the head moved since this
      // rule was proposed, re-asking them would be the alternative; instead
      // rebaseline onto the current head and retry. The successor reuses this
      // same knowledge proposal, so the confirmation stays bound to exactly the
      // content the human approved. Bounded, because each retry can lose
      // another race with a concurrent activation.
      const activateOnce = async (): Promise<GovernedLearningActivationReceipt> =>
        await activateHumanConfirmed(options.db, {
          caller: {
            workspaceId: attempt.workspaceId,
            subjectId: proposal.initiatingHumanSubjectId!,
          },
          request: {
            operationId: derivedGovernedLearningOperationId(request.operationId, "activation"),
            decisionReceiptId: request.decisionReceiptId,
            humanInputRequestId: request.humanInputRequestId,
          },
        });
      let activation: GovernedLearningActivationReceipt | null = null;
      let lastFailure: unknown;
      for (
        let attemptIndex = 0;
        attemptIndex < REBASELINE_ATTEMPTS && !activation;
        attemptIndex++
      ) {
        try {
          activation = await activateOnce();
        } catch (error) {
          lastFailure = error;
          if (
            proposal.targetKind !== "instruction_policy" ||
            !(asRememberFailure(error) instanceof RememberError) ||
            attemptIndex === REBASELINE_ATTEMPTS - 1
          ) {
            throw asRememberFailure(error);
          }
          try {
            await rebaselineProposal(options.db, {
              accountId: attempt.accountId,
              workspaceId: attempt.workspaceId,
              knowledgeProposalId: proposal.id,
              initiatingHumanSubjectId: proposal.initiatingHumanSubjectId!,
              operationId: derivedRememberOperationId(
                `${request.operationId}:${attemptIndex}`,
                "rebaseline",
              ),
            });
          } catch {
            // The rebaseline is the recovery, not the outcome the caller asked
            // for. If it cannot land, the honest answer is still the actionable
            // stale-baseline failure rather than an internal recovery error.
            throw asRememberFailure(error);
          }
        }
      }
      if (!activation) throw asRememberFailure(lastFailure);
      dispatchBestEffortGovernedLearningNotification(() =>
        notifyActivation({
          db: options.db,
          receipt: activation,
          sessionId: attempt.sessionId,
          attemptId: attempt.attemptId,
        }),
      );
      return RememberConfirmReceipt.parse({
        status: "activated",
        operationId: request.operationId,
        proposalId: proposal.id,
        claimId: proposal.claimId,
        decisionReceiptId: request.decisionReceiptId,
        activation: activationSummary(activation),
      });
    },
  };
}
