import type { DurableLearningResource, PreferenceRegistryScope } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import {
  activatePreferenceRegistryRevision,
  correctPreferenceRegistry,
  createPreferenceRegistryProposal,
  deactivatePreferenceRegistry,
  getPreferenceRegistryDetail,
} from "@opengeni/db";

type WriteResult = {
  outcome: "applied" | "proposed";
  resource: DurableLearningResource;
  effectiveBoundary: "next_accepted_attempt";
  rollback: { supported: boolean; targetAttemptId: null; token: string | null };
};

type RollbackResult = {
  resource: DurableLearningResource;
  effectiveBoundary: "next_accepted_attempt";
};

export type PreferenceRegistryDurableLearningAuthorityAdapter = {
  write: (input: unknown) => Promise<WriteResult>;
  rollback: (input: unknown) => Promise<RollbackResult>;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function parseAttempt(value: unknown) {
  const attempt = record(value, "durable-learning attempt");
  const actor = record(attempt.actor, "durable-learning actor");
  return {
    id: text(attempt.id, "durable-learning attempt id"),
    inputHash: text(attempt.inputHash, "durable-learning input hash"),
    accountId: text(attempt.accountId, "durable-learning account id"),
    workspaceId: text(attempt.workspaceId, "durable-learning workspace id"),
    actorSubjectId: text(actor.subjectId, "durable-learning actor subject"),
  };
}

function rollbackToken(value: Record<string, unknown>): string {
  return `preference-registry.v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function parseRollbackToken(value: string): Record<string, unknown> {
  if (!value.startsWith("preference-registry.v1:")) {
    throw new Error("Invalid preference registry rollback token");
  }
  return record(
    JSON.parse(
      Buffer.from(value.slice("preference-registry.v1:".length), "base64url").toString("utf8"),
    ),
    "preference rollback token",
  );
}

function authorizeExactScope(expected: PreferenceRegistryScope) {
  return (actual: PreferenceRegistryScope) => {
    if (actual !== expected) throw new Error("Preference scope changed outside the routed request");
  };
}

function resource(preference: {
  id: string;
  status: string;
  scopeVersion: number;
  activeRevision: { revision: number } | null;
}): DurableLearningResource {
  return {
    surface: "preference_registry",
    id: preference.id,
    version: preference.activeRevision
      ? `${preference.scopeVersion}:${preference.activeRevision.revision}`
      : String(preference.scopeVersion),
    status: preference.status,
  };
}

export function createPreferenceRegistryDurableLearningAdapter(options: {
  db: Database;
}): PreferenceRegistryDurableLearningAuthorityAdapter {
  return {
    async write(raw) {
      const input = record(raw, "preference durable-learning write");
      const attempt = parseAttempt(input.attempt);
      const request = record(input.request, "durable-learning request");
      const decision = record(input.decision, "durable-learning decision");
      const scope = record(decision.scope, "durable-learning scope");
      const subject = record(request.subject, "preference subject");
      const preferenceScope = text(subject.scope, "preference scope") as PreferenceRegistryScope;
      if (
        request.operation !== "write" ||
        request.attemptId !== attempt.id ||
        request.targetSurface !== "preference_registry" ||
        subject.kind !== "preference" ||
        decision.disposition !== "route" ||
        decision.destination !== "preference_registry" ||
        scope.kind !== preferenceScope ||
        (decision.authority !== "active" && decision.authority !== "proposal")
      ) {
        throw new Error("Preference adapter received a mismatched durable-learning route");
      }
      const common = {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        actorSubjectId: attempt.actorSubjectId,
        principalKind: "agent_attempt",
        durableLearningAttemptId: attempt.id,
        durableLearningInputHash: attempt.inputHash,
        authorizeScope: authorizeExactScope(preferenceScope),
      } as const;
      if (subject.action === "correct") {
        if (decision.authority !== "active") {
          throw new Error("Preference corrections are active lifecycle mutations, not proposals");
        }
        const corrected = await correctPreferenceRegistry(options.db, {
          ...common,
          preferenceId: text(subject.preferenceId, "preference id"),
          expectedCurrentRevisionId: text(
            subject.expectedCurrentRevisionId,
            "expected preference revision",
          ),
          expectedScopeVersion: integer(subject.expectedScopeVersion, "expected scope version"),
          title: text(subject.title, "preference title"),
          description: text(subject.description, "preference description"),
          content: text(subject.content, "preference content"),
          precedenceRank: integer(subject.precedenceRank, "preference precedence rank"),
          conflictStrategy: text(subject.conflictStrategy, "preference conflict strategy") as
            | "override"
            | "merge"
            | "reject"
            | "inform",
          conflictsWith: Array.isArray(subject.conflictsWith)
            ? subject.conflictsWith.map((item) => text(item, "preference conflict key"))
            : [],
          expiresAt: nullableText(subject.expiresAt, "preference expiry"),
          reason: text(subject.reason, "preference correction reason"),
        });
        return {
          outcome: "applied",
          resource: resource(corrected.preference),
          effectiveBoundary: "next_accepted_attempt",
          rollback: {
            supported: true,
            targetAttemptId: null,
            token: rollbackToken({
              action: "activate",
              scope: preferenceScope,
              preferenceId: corrected.preference.id,
              previousRevisionId: text(
                subject.expectedCurrentRevisionId,
                "previous preference revision",
              ),
              appliedRevisionId: corrected.preference.activeRevision?.id,
              scopeVersion: corrected.preference.scopeVersion,
            }),
          },
        };
      }
      if (subject.action !== "create") throw new Error("Unsupported preference write action");
      const created = await createPreferenceRegistryProposal(options.db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        actorSubjectId: attempt.actorSubjectId,
        principalKind: "agent_attempt",
        durableLearningAttemptId: attempt.id,
        durableLearningInputHash: attempt.inputHash,
        scope: preferenceScope,
        stableKey: text(subject.stableKey, "preference stable key"),
        title: text(subject.title, "preference title"),
        description: text(subject.description, "preference description"),
        content: text(subject.content, "preference content"),
        precedenceRank: integer(subject.precedenceRank, "preference precedence rank"),
        conflictStrategy: text(subject.conflictStrategy, "preference conflict strategy") as
          | "override"
          | "merge"
          | "reject"
          | "inform",
        conflictsWith: Array.isArray(subject.conflictsWith)
          ? subject.conflictsWith.map((item) => text(item, "preference conflict key"))
          : [],
        expiresAt: nullableText(subject.expiresAt, "preference expiry"),
        provenanceSource: "human",
        provenanceSourceId: null,
      });
      const detail = await getPreferenceRegistryDetail(options.db, {
        workspaceId: attempt.workspaceId,
        subjectId: attempt.actorSubjectId,
        preferenceId: created.id,
      });
      const proposedRevision = detail.revisions[0];
      if (!proposedRevision) throw new Error("Preference proposal revision was not recorded");
      if (decision.authority === "proposal") {
        return {
          outcome: "proposed",
          resource: resource(created),
          effectiveBoundary: "next_accepted_attempt",
          rollback: { supported: false, targetAttemptId: null, token: null },
        };
      }
      const activated = await activatePreferenceRegistryRevision(options.db, {
        ...common,
        preferenceId: created.id,
        revisionId: proposedRevision.id,
        expectedCurrentRevisionId: null,
        expectedScopeVersion: created.scopeVersion,
        reason: `Durable learning attempt ${attempt.id}`,
      });
      return {
        outcome: "applied",
        resource: resource(activated.preference),
        effectiveBoundary: "next_accepted_attempt",
        rollback: {
          supported: true,
          targetAttemptId: null,
          token: rollbackToken({
            action: "deactivate",
            scope: preferenceScope,
            preferenceId: activated.preference.id,
            appliedRevisionId: activated.preference.activeRevision?.id,
            scopeVersion: activated.preference.scopeVersion,
          }),
        },
      };
    },

    async rollback(raw) {
      const input = record(raw, "preference durable-learning rollback");
      const attempt = parseAttempt(input.attempt);
      const targetReceipt = record(input.targetReceipt, "durable-learning target receipt");
      const targetResource = record(targetReceipt.resource, "preference target resource");
      const receiptRollback = record(targetReceipt.rollback, "preference rollback receipt");
      const tokenValue = text(input.rollbackToken, "preference rollback token");
      if (
        targetResource.surface !== "preference_registry" ||
        receiptRollback.supported !== true ||
        receiptRollback.token !== tokenValue
      ) {
        throw new Error("Preference adapter cannot roll back another authority surface");
      }
      const token = parseRollbackToken(tokenValue);
      const scope = text(token.scope, "preference rollback scope") as PreferenceRegistryScope;
      const common = {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        actorSubjectId: attempt.actorSubjectId,
        principalKind: "agent_attempt",
        durableLearningAttemptId: attempt.id,
        durableLearningInputHash: attempt.inputHash,
        preferenceId: text(token.preferenceId, "preference rollback id"),
        expectedCurrentRevisionId: text(token.appliedRevisionId, "applied preference revision"),
        expectedScopeVersion: integer(token.scopeVersion, "preference rollback scope version"),
        authorizeScope: authorizeExactScope(scope),
        reason: text(input.reason, "preference rollback reason"),
      } as const;
      const result =
        token.action === "deactivate"
          ? await deactivatePreferenceRegistry(options.db, common)
          : token.action === "activate"
            ? await activatePreferenceRegistryRevision(options.db, {
                ...common,
                revisionId: text(token.previousRevisionId, "previous preference revision"),
              })
            : (() => {
                throw new Error("Unsupported preference rollback action");
              })();
      return {
        resource: resource(result.preference),
        effectiveBoundary: "next_accepted_attempt",
      };
    },
  };
}
