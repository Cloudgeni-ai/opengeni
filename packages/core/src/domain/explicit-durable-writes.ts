import {
  DURABLE_LEARNING_CONTRACT_VERSION,
  EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
  EXPLICIT_DURABLE_WRITE_SUMMARY_MAX_CHARS,
  DurableLearningAuthorityContext,
  DurableLearningRollbackRequest,
  DurableLearningWriteRequest,
  ExplicitDurableWriteBinding,
  ExplicitDurableWriteCommand,
  ExplicitDurableWriteReceipt,
  type DurableLearningResolvedSurface,
  type DurableLearningRouterResponse,
  type DurableLearningScope,
  type DurableLearningSubjectKind,
  type ExplicitDurableWriteBinding as ExplicitDurableWriteBindingType,
  type ExplicitDurableWriteCommand as ExplicitDurableWriteCommandType,
  type ExplicitDurableWriteReceipt as ExplicitDurableWriteReceiptType,
  type ExplicitRememberCommand,
} from "@opengeni/contracts";

const MEMORY_INTENTS = new Set<DurableLearningSubjectKind>([
  "fact",
  "decision",
  "observation",
  "history",
]);
const PREFERENCE_INTENTS = new Set<DurableLearningSubjectKind>([
  "preference",
  "procedure",
  "working_method",
  "skill_guidance",
]);
const INSTRUCTION_POLICY_INTENTS = new Set<DurableLearningSubjectKind>([
  "workspace_charter",
  "mandatory_operating_context",
  "workspace_goal",
]);
const COMPANY_PROFILE_INTENTS = new Set<DurableLearningSubjectKind>([
  "company_identity",
  "company_mission",
  "company_product",
  "company_customer",
  "company_goal",
  "company_constraint",
]);

export class ExplicitDurableWriteBindingError extends Error {
  readonly name = "ExplicitDurableWriteBindingError";
}

function surfaceForIntent(intent: DurableLearningSubjectKind): DurableLearningResolvedSurface {
  if (MEMORY_INTENTS.has(intent)) return "memory";
  if (PREFERENCE_INTENTS.has(intent)) return "preference_registry";
  if (INSTRUCTION_POLICY_INTENTS.has(intent)) return "instruction_policy";
  if (COMPANY_PROFILE_INTENTS.has(intent)) return "company_profile";
  throw new ExplicitDurableWriteBindingError(
    `Explicit remember cannot route evidence-only subject kind ${intent}`,
  );
}

function scopeForCommand(
  command: ExplicitRememberCommand,
  context: DurableLearningAuthorityContext,
): DurableLearningScope {
  switch (command.scope) {
    case "unspecified":
      return { kind: "unspecified" };
    case "personal":
      if (context.initiatingHumanSubjectId === null) {
        throw new ExplicitDurableWriteBindingError(
          "Personal explicit remember requires the exact immutable initiating human",
        );
      }
      return { kind: "user", subjectId: context.initiatingHumanSubjectId };
    case "workspace":
      return { kind: "workspace" };
    case "company":
      return { kind: "organization" };
  }
}

function validateBinding(
  rawBinding: ExplicitDurableWriteBindingType,
  context: DurableLearningAuthorityContext,
): ExplicitDurableWriteBindingType {
  const binding = ExplicitDurableWriteBinding.parse(rawBinding);
  if (context.sessionId === null || context.sessionId !== binding.sessionId) {
    throw new ExplicitDurableWriteBindingError(
      "Explicit durable write source session must equal the router authority context session",
    );
  }
  if (context.initiatingHumanSubjectId === null) {
    throw new ExplicitDurableWriteBindingError(
      "Explicit durable writes require an immutable initiating human",
    );
  }
  return binding;
}

/**
 * Translate the bounded agent command into the only accepted persistence seam:
 * an OPE-183 durable-learning router request. This function performs no write,
 * looks up no authority, and accepts no adapter or persistence port.
 */
export function toExplicitDurableLearningRouterRequest(
  rawCommand: ExplicitDurableWriteCommandType,
  rawBinding: ExplicitDurableWriteBindingType,
  rawContext: DurableLearningAuthorityContext,
): DurableLearningWriteRequest | DurableLearningRollbackRequest {
  const command = ExplicitDurableWriteCommand.parse(rawCommand);
  const context = DurableLearningAuthorityContext.parse(rawContext);
  const binding = validateBinding(rawBinding, context);

  if (command.operation === "undo") {
    return DurableLearningRollbackRequest.parse({
      contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
      operation: "rollback",
      attemptId: binding.attemptId,
      origin: "explicit_remember",
      targetAttemptId: command.targetAttemptId,
      reason: command.reason,
    });
  }

  if (binding.sourceMessage === null) {
    throw new ExplicitDurableWriteBindingError(
      "Explicit remember requires exact eligible source-message evidence",
    );
  }

  return DurableLearningWriteRequest.parse({
    contractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    operation: "write",
    attemptId: binding.attemptId,
    origin: "explicit_remember",
    requestedAuthority: "active",
    requestedScope: scopeForCommand(command, context),
    targetSurface: surfaceForIntent(command.subject.intent),
    subject: {
      kind: command.subject.intent,
      content: command.subject.content,
      stableKey: command.subject.stableKey,
      title: command.subject.title,
      summary: command.subject.summary,
      roleKey: null,
      replacesResourceId: command.subject.replacesResourceId,
    },
    evidence: [
      {
        kind: "session_message",
        sourceId: binding.sourceMessage.id,
        sourceVersion: binding.sourceMessage.version,
        contentHash: binding.sourceMessage.contentHash,
        eligibility: "eligible",
      },
    ],
  });
}

function compactSummary(value: string): string {
  const collapsed = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return collapsed.length <= EXPLICIT_DURABLE_WRITE_SUMMARY_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, EXPLICIT_DURABLE_WRITE_SUMMARY_MAX_CHARS - 1)}…`;
}

/**
 * Produce the concise transparency/inspection/undo view returned by a future
 * agent tool. It validates that the response belongs to the exact request and
 * intentionally does not expose the authority-owned rollback token.
 */
export function projectExplicitDurableWriteReceipt(
  rawRequest: DurableLearningWriteRequest | DurableLearningRollbackRequest,
  response: DurableLearningRouterResponse,
): ExplicitDurableWriteReceiptType {
  const request =
    rawRequest.operation === "write"
      ? DurableLearningWriteRequest.parse(rawRequest)
      : DurableLearningRollbackRequest.parse(rawRequest);
  if (request.origin !== "explicit_remember") {
    throw new ExplicitDurableWriteBindingError(
      "Explicit receipt projection accepts only explicit_remember router requests",
    );
  }
  if (response.receipt.attemptId !== request.attemptId) {
    throw new ExplicitDurableWriteBindingError(
      "Explicit receipt projection requires the exact router attempt response",
    );
  }

  const receipt = response.receipt;
  const resource = receipt.resource;
  const routedWrite =
    request.operation === "write" &&
    receipt.decision.disposition === "route" &&
    receipt.decision.destination !== null &&
    receipt.decision.scope !== null &&
    receipt.decision.authority !== null &&
    !["rejected", "failed", "clarification_required"].includes(receipt.outcome);

  return ExplicitDurableWriteReceipt.parse({
    contractVersion: EXPLICIT_DURABLE_WRITE_CONTRACT_VERSION,
    routerContractVersion: DURABLE_LEARNING_CONTRACT_VERSION,
    operation: request.operation === "write" ? "remember" : "undo",
    attemptId: receipt.attemptId,
    inputHash: receipt.inputHash,
    idempotency: response.idempotency,
    outcome: receipt.outcome,
    decision: {
      disposition: receipt.decision.disposition,
      code: receipt.decision.code,
      reasons: receipt.decision.reasons,
      clarificationFields: receipt.decision.clarificationFields,
    },
    saved: routedWrite
      ? {
          summary: compactSummary(
            request.subject.summary ?? request.subject.title ?? request.subject.content,
          ),
          destination: receipt.decision.destination,
          scope: receipt.decision.scope,
          authority: receipt.decision.authority,
          resource,
        }
      : null,
    effectiveBoundary: receipt.effectiveBoundary,
    inspect: resource
      ? {
          surface: resource.surface,
          resourceId: resource.id,
          version: resource.version,
        }
      : null,
    undo:
      request.operation === "write"
        ? {
            supported: receipt.rollback.supported,
            targetAttemptId: receipt.rollback.supported ? receipt.attemptId : null,
          }
        : null,
    audit: {
      sourceEvidence:
        request.operation === "write"
          ? request.evidence.map((item) => ({
              sourceId: item.sourceId,
              contentHash: item.contentHash,
            }))
          : [],
    },
    createdAt: receipt.createdAt,
  });
}
