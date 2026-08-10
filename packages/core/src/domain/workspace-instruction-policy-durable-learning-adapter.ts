import { createHash } from "node:crypto";
import type { Database } from "@opengeni/db";
import {
  activateWorkspaceInstructionPolicyRevision,
  createWorkspaceInstructionPolicyDraft,
  listWorkspaceInstructionPolicyRevisions,
  rollbackWorkspaceInstructionPolicyRevision,
} from "@opengeni/db";
import type {
  DurableLearningResource,
  WorkspaceInstructionPolicyTarget,
} from "@opengeni/contracts";

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

export type WorkspaceInstructionPolicyDurableLearningAuthorityAdapter = {
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

function derivedUuid(operationId: string, label: string): string {
  const bytes = createHash("sha256")
    .update(`${operationId}:${label}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function token(value: Record<string, unknown>): string {
  return `workspace-instruction-policy.v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function parseToken(value: string): {
  target: WorkspaceInstructionPolicyTarget;
  previousRevisionId: string;
  appliedRevisionId: string;
  activationVersion: number;
} {
  if (!value.startsWith("workspace-instruction-policy.v1:")) {
    throw new Error("Invalid workspace instruction-policy rollback token");
  }
  const parsed = JSON.parse(
    Buffer.from(value.slice("workspace-instruction-policy.v1:".length), "base64url").toString(
      "utf8",
    ),
  ) as Record<string, unknown>;
  const target = record(parsed.target, "instruction-policy rollback target");
  const activationVersion = parsed.activationVersion;
  if (!Number.isSafeInteger(activationVersion) || (activationVersion as number) < 1) {
    throw new Error("Invalid workspace instruction-policy rollback activation version");
  }
  return {
    target: {
      kind: text(target.kind, "instruction-policy target kind") as "charter" | "policy",
      scope: text(target.scope, "instruction-policy target scope") as "global" | "role",
      roleKey: target.roleKey === null ? null : text(target.roleKey, "instruction-policy role key"),
    },
    previousRevisionId: text(parsed.previousRevisionId, "previous instruction-policy revision"),
    appliedRevisionId: text(parsed.appliedRevisionId, "applied instruction-policy revision"),
    activationVersion: activationVersion as number,
  };
}

function parseAttempt(value: unknown) {
  const attempt = record(value, "durable-learning attempt");
  const actor = record(attempt.actor, "durable-learning actor");
  return {
    id: text(attempt.id, "durable-learning attempt id"),
    accountId: text(attempt.accountId, "durable-learning account id"),
    workspaceId: text(attempt.workspaceId, "durable-learning workspace id"),
    actorSubjectId: text(actor.subjectId, "durable-learning actor subject"),
  };
}

export function createWorkspaceInstructionPolicyDurableLearningAdapter(options: {
  db: Database;
}): WorkspaceInstructionPolicyDurableLearningAuthorityAdapter {
  return {
    async write(raw) {
      const input = record(raw, "instruction-policy durable-learning write");
      const attempt = parseAttempt(input.attempt);
      const request = record(input.request, "durable-learning request");
      const decision = record(input.decision, "durable-learning decision");
      const subject = record(request.subject, "instruction-policy subject");
      const target = record(subject.target, "instruction-policy target");
      if (
        request.operation !== "write" ||
        request.attemptId !== attempt.id ||
        request.targetSurface !== "workspace_instruction_policy" ||
        subject.kind !== "workspace_instruction" ||
        decision.disposition !== "route" ||
        decision.destination !== "workspace_instruction_policy" ||
        record(decision.scope, "instruction-policy scope").kind !== "workspace" ||
        (decision.authority !== "active" && decision.authority !== "proposal")
      ) {
        throw new Error("Instruction-policy adapter received a mismatched durable-learning route");
      }
      const policyTarget = {
        kind: text(target.kind, "instruction-policy kind") as "charter" | "policy",
        scope: text(target.scope, "instruction-policy scope") as "global" | "role",
        roleKey:
          target.roleKey === null ? null : text(target.roleKey, "instruction-policy role key"),
      } satisfies WorkspaceInstructionPolicyTarget;
      const current = await listWorkspaceInstructionPolicyRevisions(
        options.db,
        attempt.workspaceId,
        {
          ...policyTarget,
          limit: 1,
        },
      );
      const currentHead =
        current.activeHeads.find(
          (head) =>
            head.kind === policyTarget.kind &&
            head.scope === policyTarget.scope &&
            head.roleKey === policyTarget.roleKey,
        ) ?? null;
      const revision = await createWorkspaceInstructionPolicyDraft(options.db, {
        operationId: derivedUuid(attempt.id, "revision"),
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        createdBySubjectId: attempt.actorSubjectId,
        ...policyTarget,
        content: text(subject.content, "workspace instruction content"),
        provenanceSource: "human",
        provenanceSourceId: null,
        supersedesRevisionId: currentHead?.revisionId ?? null,
      });
      if (decision.authority === "proposal") {
        return {
          outcome: "proposed",
          resource: {
            surface: "workspace_instruction_policy",
            id: revision.id,
            version: String(revision.revision),
            status: "proposal",
          },
          effectiveBoundary: "next_accepted_attempt",
          rollback: { supported: false, targetAttemptId: null, token: null },
        };
      }
      const activated = await activateWorkspaceInstructionPolicyRevision(options.db, {
        operationId: derivedUuid(attempt.id, "activation"),
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        revisionId: revision.id,
        expectedCurrentRevisionId: currentHead?.revisionId ?? null,
        expectedActivationVersion: currentHead?.activationVersion ?? 0,
        actorSubjectId: attempt.actorSubjectId,
        reason: `Durable learning attempt ${attempt.id}`,
      });
      const rollbackToken = currentHead
        ? token({
            target: policyTarget,
            previousRevisionId: currentHead.revisionId,
            appliedRevisionId: revision.id,
            activationVersion: activated.event.activationVersion,
          })
        : null;
      return {
        outcome: "applied",
        resource: {
          surface: "workspace_instruction_policy",
          id: revision.id,
          version: String(revision.revision),
          status: "active",
        },
        effectiveBoundary: "next_accepted_attempt",
        rollback: {
          supported: rollbackToken !== null,
          targetAttemptId: null,
          token: rollbackToken,
        },
      };
    },

    async rollback(raw) {
      const input = record(raw, "instruction-policy durable-learning rollback");
      const attempt = parseAttempt(input.attempt);
      const targetReceipt = record(input.targetReceipt, "durable-learning target receipt");
      const resource = record(targetReceipt.resource, "instruction-policy target resource");
      const receiptRollback = record(targetReceipt.rollback, "instruction-policy rollback receipt");
      const rollbackToken = text(input.rollbackToken, "instruction-policy rollback token");
      if (
        resource.surface !== "workspace_instruction_policy" ||
        receiptRollback.supported !== true ||
        receiptRollback.token !== rollbackToken
      ) {
        throw new Error("Instruction-policy adapter cannot roll back another authority surface");
      }
      const parsed = parseToken(rollbackToken);
      const result = await rollbackWorkspaceInstructionPolicyRevision(options.db, {
        operationId: attempt.id,
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        targetRevisionId: parsed.previousRevisionId,
        expectedCurrentRevisionId: parsed.appliedRevisionId,
        expectedActivationVersion: parsed.activationVersion,
        actorSubjectId: attempt.actorSubjectId,
        reason: text(input.reason, "instruction-policy rollback reason"),
      });
      return {
        resource: {
          surface: "workspace_instruction_policy",
          id: result.head.revisionId,
          version: String(result.head.revision),
          status: "active",
        },
        effectiveBoundary: "next_accepted_attempt",
      };
    },
  };
}
