import {
  DurableLearningRollbackRequest,
  DurableLearningWriteRequest,
  type DurableLearningAttemptReceipt,
  type DurableLearningRouteDecision,
  type DurableLearningSubject,
} from "@opengeni/contracts";
import {
  getDurableLearningAttemptWithReceipt,
  runDurableLearningAttempt,
  type Database,
  type DurableLearningAttemptAdmission,
  type DurableLearningAuthorityResult,
} from "@opengeni/db";
import { createCompanyProfileDurableLearningAdapter } from "./company-profile-durable-learning-adapter";
import { createPreferenceRegistryDurableLearningAdapter } from "./preference-registry-durable-learning-adapter";
import { createWorkspaceInstructionPolicyDurableLearningAdapter } from "./workspace-instruction-policy-durable-learning-adapter";

export class DurableLearningAuthorityWriteError extends Error {
  readonly code = "AUTHORITY_WRITE_FAILED";
  readonly name = "DurableLearningAuthorityWriteError";

  constructor(
    readonly destination: DurableLearningRouteDecision["destination"],
    cause: unknown,
  ) {
    super(`Durable-learning ${destination} authority write failed`, { cause });
  }
}

export class DurableLearningRollbackUnavailableError extends Error {
  readonly code = "DURABLE_LEARNING_ROLLBACK_UNAVAILABLE";
  readonly name = "DurableLearningRollbackUnavailableError";
}

export type DurableLearningAuthorityAdapter = {
  write: (input: unknown) => Promise<{
    outcome: "applied" | "proposed";
    resource: DurableLearningAuthorityResult["resource"];
    effectiveBoundary: "next_accepted_attempt";
    rollback: DurableLearningAuthorityResult["rollback"];
  }>;
  rollback: (input: unknown) => Promise<{
    resource: DurableLearningAuthorityResult["resource"];
    effectiveBoundary: "next_accepted_attempt";
  }>;
};

type AuthorityFactory = (db: Database) => DurableLearningAuthorityAdapter;

export type DurableLearningRouterOptions = {
  db: Database;
  authorities?: Partial<Record<DurableLearningRouteDecision["destination"], AuthorityFactory>>;
  ledger?: {
    run: typeof runDurableLearningAttempt;
    get: typeof getDurableLearningAttemptWithReceipt;
  };
};

function decisionFor(
  subject: DurableLearningSubject,
  authority: "active" | "proposal",
): DurableLearningRouteDecision {
  if (subject.kind === "workspace_instruction") {
    return {
      disposition: "route",
      destination: "workspace_instruction_policy",
      scope: { kind: "workspace" },
      authority,
    };
  }
  if (subject.kind === "preference") {
    return {
      disposition: "route",
      destination: "preference_registry",
      scope: { kind: subject.scope },
      authority,
    };
  }
  return {
    disposition: "route",
    destination: "company_profile",
    scope: { kind: "organization" },
    authority,
  };
}

function defaultAuthorityFactory(
  destination: DurableLearningRouteDecision["destination"],
): AuthorityFactory {
  if (destination === "company_profile") {
    return (db) => createCompanyProfileDurableLearningAdapter({ db });
  }
  if (destination === "workspace_instruction_policy") {
    return (db) => createWorkspaceInstructionPolicyDurableLearningAdapter({ db });
  }
  return (db) => createPreferenceRegistryDurableLearningAdapter({ db });
}

function adapterInput(admission: DurableLearningAttemptAdmission) {
  return {
    attempt: {
      id: admission.id,
      accountId: admission.authority.accountId,
      workspaceId: admission.authority.workspaceId,
      sessionId: admission.authority.sessionId,
      turnId: admission.authority.turnId,
      executionAttemptId: admission.authority.attemptId,
      executionGeneration: admission.authority.executionGeneration,
      actor: { kind: "agent" as const, subjectId: admission.initiatingHumanSubjectId },
    },
    request: admission.request,
    decision: admission.decision,
  };
}

export function createDurableLearningRouter(options: DurableLearningRouterOptions) {
  const ledger = options.ledger ?? {
    run: runDurableLearningAttempt,
    get: getDurableLearningAttemptWithReceipt,
  };
  return {
    async write(rawInput: unknown): Promise<DurableLearningAttemptReceipt> {
      const input = DurableLearningWriteRequest.parse(rawInput);
      const decision = decisionFor(input.subject, input.activation);
      const request = {
        operation: "write" as const,
        attemptId: input.operationId,
        targetSurface: decision.destination,
        confirmation: input.confirmation,
        subject: input.subject,
      };
      return await ledger.run(
        options.db,
        { operationId: input.operationId, authority: input.authority, request, decision },
        async (db, admission) => {
          const factory =
            options.authorities?.[decision.destination] ??
            defaultAuthorityFactory(decision.destination);
          try {
            return await factory(db).write(adapterInput(admission));
          } catch (error) {
            throw new DurableLearningAuthorityWriteError(decision.destination, error);
          }
        },
      );
    },

    async rollback(rawInput: unknown): Promise<DurableLearningAttemptReceipt> {
      const input = DurableLearningRollbackRequest.parse(rawInput);
      const target = await ledger.get(options.db, {
        accountId: input.authority.accountId,
        workspaceId: input.authority.workspaceId,
        attemptId: input.targetAttemptId,
      });
      if (
        !target ||
        !target.receipt.rollback.supported ||
        target.receipt.rollback.token !== input.rollbackToken ||
        target.receipt.resource?.surface !== target.decision.destination
      ) {
        throw new DurableLearningRollbackUnavailableError(
          "The target durable-learning attempt has no matching authorized rollback receipt",
        );
      }
      const decision = { ...target.decision, authority: "active" as const };
      const request = {
        operation: "rollback" as const,
        attemptId: input.operationId,
        targetSurface: decision.destination,
        confirmation: input.confirmation,
        targetAttemptId: input.targetAttemptId,
        rollbackToken: input.rollbackToken,
        reason: input.reason,
        ...(decision.destination === "preference_registry"
          ? { subject: { scope: decision.scope.kind } }
          : {}),
      };
      return await ledger.run(
        options.db,
        { operationId: input.operationId, authority: input.authority, request, decision },
        async (db, admission) => {
          const factory =
            options.authorities?.[decision.destination] ??
            defaultAuthorityFactory(decision.destination);
          try {
            const rolledBack = await factory(db).rollback({
              ...adapterInput(admission),
              targetAttempt: {
                id: input.targetAttemptId,
                accountId: input.authority.accountId,
                workspaceId: input.authority.workspaceId,
                actor: { kind: "agent", subjectId: target.initiatingHumanSubjectId },
              },
              targetReceipt: target.receipt,
              rollbackToken: input.rollbackToken,
              reason: input.reason,
            });
            return {
              outcome: "rolled_back",
              resource: rolledBack.resource,
              effectiveBoundary: rolledBack.effectiveBoundary,
              rollback: { supported: false, targetAttemptId: input.targetAttemptId, token: null },
            };
          } catch (error) {
            throw new DurableLearningAuthorityWriteError(decision.destination, error);
          }
        },
      );
    },
  };
}
