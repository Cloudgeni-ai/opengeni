import {
  SessionGoalReportDeliveries,
  SessionGoalReportRequirements,
  type SessionGoalReportRequirement,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  rawRows,
  withSessionActivityRlsContext,
  withSessionActivitySavepoint,
  type Database,
} from "./database";
import {
  transactionallyAuthorizeEditableArtifactActor,
  type PersistedEditableArtifactActor,
} from "./editable-artifacts";
import {
  assertAgentCommandAuthorityInTransaction,
  canonicalSessionCommandHash,
  lockSessionEventWriteRows,
  reserveSessionCommandReceipt,
} from "./session-control";
import * as schema from "./schema";

/** Versioned, server-owned metadata. Malformed persisted data fails closed. */
export const GOAL_REPORT_REQUIREMENTS_KEY = "reportRequirementsV1";

export function goalReportRequirements(
  metadata: Record<string, unknown>,
): SessionGoalReportRequirement[] {
  return SessionGoalReportRequirements.parse(
    Object.hasOwn(metadata, GOAL_REPORT_REQUIREMENTS_KEY)
      ? metadata[GOAL_REPORT_REQUIREMENTS_KEY]
      : [],
  );
}

export function appendGoalReportRequirements(
  metadata: Record<string, unknown>,
  declarations: readonly SessionGoalReportRequirement[] = [],
): Record<string, unknown> {
  const existing = goalReportRequirements(metadata);
  const incoming = SessionGoalReportRequirements.parse(declarations);
  for (const requirement of incoming) {
    const previous = existing.find((item) => item.id === requirement.id);
    if (previous && previous.title !== requirement.title) {
      throw new Error(`Report requirement ${requirement.id} is immutable`);
    }
    if (!previous) existing.push(requirement);
  }
  return {
    ...metadata,
    [GOAL_REPORT_REQUIREMENTS_KEY]: SessionGoalReportRequirements.parse(existing),
  };
}

export type ReportArtifactActor = Extract<PersistedEditableArtifactActor, { kind: "agent" }>;

/** Called under the canonical session lock. NOWAIT avoids the existing artifact
 * writer's artifact -> actor-session authorization lock inversion. The caller
 * rolls back and retries/re-inspects after a concurrent edit; never waits here. */
async function lockReadableDocument(
  tx: Database,
  scope: { accountId: string; workspaceId: string },
  actor: ReportArtifactActor,
  artifactId: string,
) {
  const [artifact] = await rawRows<{
    head_sequence: string | number;
    state_hash: string;
    modality: string;
    lifecycle_state: string;
    authorization_revision: string | number;
  }>(
    tx,
    sql`
    select head_sequence, state_hash, modality, lifecycle_state, authorization_revision from editable_artifacts
    where account_id = ${scope.accountId}::uuid and workspace_id = ${scope.workspaceId}::uuid
      and id = ${artifactId} for share nowait
  `,
  );
  if (!artifact || artifact.modality !== "document" || artifact.lifecycle_state !== "active") {
    throw new Error("Report delivery requires an accessible active native document");
  }
  const authorization = await transactionallyAuthorizeEditableArtifactActor(tx, {
    scope,
    actor,
    artifactId,
    permission: "read",
  });
  if (!authorization.allowed) throw new Error("Report document access denied");
  return artifact;
}

/** Trusted application-only recorder, called after native query/decode. There is
 * no public route/tool accepting this proof body. The runtime SQL role remains
 * trusted: it can insert receipt-shaped rows, so stored proof is not a native
 * execution attestation against arbitrary application-role SQL. UPDATE and
 * direct DELETE are fenced; legitimate session-retention cascades remove proof.
 */
export async function recordNativeDocumentInspection(
  db: Database,
  input: {
    scope: { accountId: string; workspaceId: string };
    actor: ReportArtifactActor;
    sessionId: string;
    artifact: { id: string; modality: string; headSequence: number; stateHash: string };
    queryHash: string;
    queryKind: string;
  },
): Promise<string> {
  if (input.actor.sessionId !== input.sessionId)
    throw new Error("Inspection session authority mismatch");
  return withSessionActivityRlsContext(db, input.scope, (scopedDb) =>
    withSessionActivitySavepoint(scopedDb, async (tx) => {
      const locks = await lockSessionEventWriteRows(tx, {
        workspaceId: input.scope.workspaceId,
        controlLock: "share",
        sessionIds: [input.sessionId],
      });
      if (!locks.control || !locks.workspace || !locks.sessions[0])
        throw new Error("Inspection session not found");
      const actor = {
        type: "agent_attempt" as const,
        sessionId: input.actor.sessionId,
        turnId: input.actor.turnId,
        attemptId: input.actor.attemptId,
        executionGeneration: input.actor.generation,
      };
      await assertAgentCommandAuthorityInTransaction(tx, {
        workspaceId: input.scope.workspaceId,
        actor,
        targetSessionId: input.sessionId,
        action: "goal",
      });
      const artifact = await lockReadableDocument(tx, input.scope, input.actor, input.artifact.id);
      if (
        Number(artifact.head_sequence) !== input.artifact.headSequence ||
        artifact.state_hash !== input.artifact.stateHash
      ) {
        throw new Error("Document changed during inspection; inspect its current head again");
      }
      const result = {
        version: "native-document-inspection.v1",
        artifactId: input.artifact.id,
        headSequence: input.artifact.headSequence,
        stateHash: input.artifact.stateHash,
        subjectId: input.actor.subjectId,
        queryHash: input.queryHash,
        queryKind: input.queryKind,
        authorizationRevision: Number(artifact.authorization_revision),
      };
      const reserved = await reserveSessionCommandReceipt(tx, {
        ...input.scope,
        actor,
        action: "artifact.document.inspect",
        targetSessionId: input.sessionId,
        targetTurnId: input.actor.turnId,
        operationKey: `document-inspection:${canonicalSessionCommandHash(result)}`,
        canonicalRequestHash: canonicalSessionCommandHash(result),
        initialResult: result,
      });
      return reserved.receipt.id;
    }),
  );
}

/** No provider calls here: receipt, access, locked current head and completion
 * share one transaction. Receipts from previous attempts may prove inspection,
 * but the completing attempt must still have live read authority. */
export async function verifyGoalReportDeliveries(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    metadata: Record<string, unknown>;
    deliveries: unknown;
    actor?: ReportArtifactActor;
  },
): Promise<void> {
  const requirements = goalReportRequirements(input.metadata);
  const deliveries = SessionGoalReportDeliveries.parse(input.deliveries ?? []);
  if (
    deliveries.length !== requirements.length ||
    requirements.some((item) => !deliveries.some((delivery) => delivery.requirementId === item.id))
  ) {
    throw new Error(
      "Every persisted report requirement needs exactly one verified document delivery",
    );
  }
  if (!requirements.length) return;
  if (!input.actor || input.actor.sessionId !== input.sessionId)
    throw new Error("Report completion requires exact agent artifact authority");
  const [turn] = await tx
    .select({
      initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
      initiatorKind: schema.sessionTurns.initiatorKind,
      initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.actor.turnId),
      ),
    )
    .limit(1);
  const recipient =
    turn?.initiatingHumanSubjectId ??
    (turn?.initiatorKind === "subject" ? turn.initiatorSubjectId : null);
  if (!recipient)
    throw new Error("Report completion requires a verified initiating human recipient");
  for (const delivery of [...deliveries].sort((a, b) => a.artifactId.localeCompare(b.artifactId))) {
    const artifact = await lockReadableDocument(tx, input, input.actor, delivery.artifactId);
    const recipientAccess = await transactionallyAuthorizeEditableArtifactActor(tx, {
      scope: input,
      artifactId: delivery.artifactId,
      actor: { kind: "human", subjectId: recipient, replicaId: input.actor.replicaId },
      permission: "read",
    });
    if (!recipientAccess.allowed)
      throw new Error("Report recipient cannot access the native document");
    const [receipt] = await tx
      .select()
      .from(schema.sessionCommandReceipts)
      .where(
        and(
          eq(schema.sessionCommandReceipts.id, delivery.inspectionReceiptId),
          eq(schema.sessionCommandReceipts.accountId, input.accountId),
          eq(schema.sessionCommandReceipts.workspaceId, input.workspaceId),
          eq(schema.sessionCommandReceipts.targetSessionId, input.sessionId),
          eq(schema.sessionCommandReceipts.action, "artifact.document.inspect"),
          eq(schema.sessionCommandReceipts.actorType, "agent_attempt"),
        ),
      )
      .limit(1);
    const proof = receipt?.result;
    if (
      !proof ||
      proof.version !== "native-document-inspection.v1" ||
      proof.queryKind !== "body" ||
      proof.artifactId !== delivery.artifactId ||
      proof.subjectId !== input.actor.subjectId ||
      proof.headSequence !== Number(artifact.head_sequence) ||
      proof.stateHash !== artifact.state_hash ||
      proof.authorizationRevision !== Number(artifact.authorization_revision)
    ) {
      throw new Error(
        "Missing, untrusted, inaccessible or stale native document inspection receipt",
      );
    }
  }
}
