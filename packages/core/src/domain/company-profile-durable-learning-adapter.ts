import {
  CompanyProfileLearningSubjectKind,
  CompanyProfileLearningWrite,
  type CompanyProfileMutationResponse,
} from "@opengeni/contracts";
import {
  type CompanyProfileLearningWriteResult,
  type Database,
  rollbackCompanyProfileLearning,
  writeCompanyProfileLearning,
} from "@opengeni/db";

export type CompanyProfileDurableLearningResource = {
  surface: "company_profile";
  id: string;
  version: string | null;
  status: string;
};

export type CompanyProfileDurableLearningWriteResult = {
  outcome: "applied" | "proposed";
  resource: CompanyProfileDurableLearningResource;
  effectiveBoundary: "next_accepted_attempt";
  rollback: {
    supported: boolean;
    targetAttemptId: null;
    token: string | null;
  };
};

export type CompanyProfileDurableLearningRollbackResult = {
  resource: CompanyProfileDurableLearningResource;
  effectiveBoundary: "next_accepted_attempt";
};

/**
 * Structural match for canonical durable-learning router's DurableLearningAuthorityAdapter. The router
 * package owns its complete request/decision types; accepting unknown here
 * keeps this adapter assignable without copying or competing with that router.
 */
export type CompanyProfileDurableLearningAuthorityAdapter = {
  write: (input: unknown) => Promise<CompanyProfileDurableLearningWriteResult>;
  rollback: (input: unknown) => Promise<CompanyProfileDurableLearningRollbackResult>;
};

export type CompanyProfileDurableLearningAdapterOptions = {
  db: Database;
  authority?: {
    write: typeof writeCompanyProfileLearning;
    rollback: typeof rollbackCompanyProfileLearning;
  };
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredString(value, name);
}

function actorKind(value: unknown): "human" | "agent" | "service" {
  if (value === "human" || value === "agent" || value === "service") return value;
  throw new Error("durable-learning attempt actor kind is invalid");
}

function parseAttempt(value: unknown) {
  const attempt = record(value, "durable-learning attempt");
  const actor = record(attempt.actor, "durable-learning actor");
  return {
    id: requiredString(attempt.id, "durable-learning attempt id"),
    accountId: requiredString(attempt.accountId, "durable-learning account id"),
    workspaceId: requiredString(attempt.workspaceId, "durable-learning workspace id"),
    actor: {
      kind: actorKind(actor.kind),
      subjectId: requiredString(actor.subjectId, "durable-learning actor subject"),
    },
  };
}

function parseWriteInput(value: unknown) {
  const input = record(value, "company-profile durable-learning write");
  const attempt = parseAttempt(input.attempt);
  const request = record(input.request, "durable-learning write request");
  const decision = record(input.decision, "durable-learning route decision");
  const scope = record(decision.scope, "durable-learning resolved scope");
  const subject = record(request.subject, "durable-learning subject");
  if (
    request.operation !== "write" ||
    request.attemptId !== attempt.id ||
    request.targetSurface !== "company_profile" ||
    decision.disposition !== "route" ||
    decision.destination !== "company_profile" ||
    scope.kind !== "organization" ||
    (decision.authority !== "active" && decision.authority !== "proposal")
  ) {
    throw new Error(
      "The company-profile adapter accepts only matching routed active or proposal organization company_profile writes",
    );
  }
  return CompanyProfileLearningWrite.parse({
    operationId: attempt.id,
    accountId: attempt.accountId,
    workspaceId: attempt.workspaceId,
    actorSubjectId: attempt.actor.subjectId,
    actorKind: attempt.actor.kind,
    authority: decision.authority,
    subject: {
      kind: CompanyProfileLearningSubjectKind.parse(subject.kind),
      content: requiredString(subject.content, "durable-learning subject content"),
      stableKey: nullableString(subject.stableKey, "durable-learning subject stable key"),
    },
    sourceId: `durable-learning-attempt:${attempt.id}`,
  });
}

function parseRollbackInput(value: unknown) {
  const input = record(value, "company-profile durable-learning rollback");
  const attempt = parseAttempt(input.attempt);
  const targetAttempt = parseAttempt(input.targetAttempt);
  const targetReceipt = record(input.targetReceipt, "durable-learning target receipt");
  const targetResource = record(
    targetReceipt.resource,
    "durable-learning target company-profile resource",
  );
  const receiptRollback = record(
    targetReceipt.rollback,
    "durable-learning target rollback receipt",
  );
  const rollbackToken = requiredString(input.rollbackToken, "company-profile rollback token");
  if (
    targetReceipt.attemptId !== targetAttempt.id ||
    targetResource.surface !== "company_profile" ||
    receiptRollback.supported !== true ||
    receiptRollback.token !== rollbackToken
  ) {
    throw new Error("The company-profile adapter cannot roll back another authority surface");
  }
  return {
    attempt,
    rollbackToken,
    reason: requiredString(input.reason, "company-profile rollback reason"),
  };
}

function writeResource(
  result: CompanyProfileLearningWriteResult,
): CompanyProfileDurableLearningResource {
  return {
    surface: "company_profile",
    id: result.revision.id,
    version: String(result.revision.revision),
    status: result.outcome === "applied" ? "active" : "proposal",
  };
}

function rollbackResource(
  result: CompanyProfileMutationResponse,
): CompanyProfileDurableLearningResource {
  if (!result.event) throw new Error("Company-profile rollback returned no activation event");
  return {
    surface: "company_profile",
    id: result.head?.revisionId ?? result.event.oldRevision?.id ?? result.event.id,
    version: String(result.event.activationVersion),
    status: result.head ? "active" : "inactive",
  };
}

/** Install this under `authorities.company_profile` in the canonical durable-learning router ports. */
export function createCompanyProfileDurableLearningAdapter(
  options: CompanyProfileDurableLearningAdapterOptions,
): CompanyProfileDurableLearningAuthorityAdapter {
  const authority = options.authority ?? {
    write: writeCompanyProfileLearning,
    rollback: rollbackCompanyProfileLearning,
  };
  return {
    async write(rawInput) {
      const input = parseWriteInput(rawInput);
      const result = await authority.write(options.db, input);
      return {
        outcome: result.outcome,
        resource: writeResource(result),
        effectiveBoundary: result.effectiveBoundary,
        rollback: {
          supported: result.rollbackToken !== null,
          targetAttemptId: null,
          token: result.rollbackToken,
        },
      };
    },

    async rollback(rawInput) {
      const input = parseRollbackInput(rawInput);
      const result = await authority.rollback(options.db, {
        operationId: input.attempt.id,
        accountId: input.attempt.accountId,
        workspaceId: input.attempt.workspaceId,
        actorSubjectId: input.attempt.actor.subjectId,
        actorKind: input.attempt.actor.kind,
        token: input.rollbackToken,
        reason: input.reason,
      });
      return {
        resource: rollbackResource(result),
        effectiveBoundary: "next_accepted_attempt",
      };
    },
  };
}
