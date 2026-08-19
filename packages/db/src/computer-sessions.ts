import { createHash, randomUUID } from "node:crypto";
import {
  ComputerSession,
  ComputerSessionCapabilities,
  ComputerSessionListResponse,
  ComputerSessionMutationResponse,
  InteractionControllerBinding,
  InteractionError,
  InteractionLifecycleOperationReceipt,
  type ComputerSessionCapabilities as ComputerSessionCapabilitiesValue,
  type ComputerSessionListResponse as ComputerSessionListResponseValue,
  type ComputerSessionMutationResponse as ComputerSessionMutationResponseValue,
  type InteractionControllerBinding as InteractionControllerBindingValue,
  type InteractionError as InteractionErrorValue,
  type InteractionLifecycleOperationKind,
  type InteractionLifecycleOperationReceipt as InteractionLifecycleOperationReceiptValue,
  type InteractionPlacement,
} from "@opengeni/contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { attachedDeviceGenerationMatches } from "./attached-browser-devices";
import { type Database, withRlsContext } from "./database";
import {
  advanceWorkspaceInteractionRevision,
  readWorkspaceInteractionRevision,
} from "./interaction-revisions";
import { safeDatabaseErrorFacts } from "./persistence-errors";
import * as schema from "./schema";

type ComputerSessionRow = typeof schema.computerSessions.$inferSelect;
type ComputerAssociationRow = typeof schema.computerSessionAssociations.$inferSelect;
type InteractionOperationRow = typeof schema.interactionOperations.$inferSelect;

const CONSISTENT_READ = {
  isolationLevel: "repeatable read",
  accessMode: "read only",
} as const;

export class ComputerSessionNotFoundError extends Error {
  readonly name = "ComputerSessionNotFoundError";
}

export class ComputerSessionOperationConflictError extends Error {
  readonly name = "ComputerSessionOperationConflictError";
}

export class ComputerSessionStateError extends Error {
  readonly name = "ComputerSessionStateError";
}

export type PrepareComputerSessionCreateInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  associatedSessionId: string;
  actorSubjectId: string;
  name: string;
  placement: InteractionPlacement;
};

export type PrepareComputerSessionEndInput = {
  accountId: string;
  workspaceId: string;
  computerSessionId: string;
  operationId: string;
  actorSubjectId: string;
};

/** Internal executor view. Plaintext controller credentials are derived from
 * this durable fence and never stored here. */
export type ComputerSessionControlRecord = {
  session: ComputerSession;
  tokenGeneration: number;
  sourceSessionId: string;
  createOperationId: string;
  operation: null | {
    operationId: string;
    kind: InteractionLifecycleOperationKind;
    state: InteractionOperationRow["state"];
    controllerGeneration: string | null;
    actorSubjectId: string;
  };
};

function iso(value: Date): string {
  return value.toISOString();
}

function placementFromRow(row: ComputerSessionRow): InteractionPlacement {
  switch (row.placementKind) {
    case "sandbox_group":
      if (!row.sandboxGroupId) throw new Error("ComputerSession sandbox placement is incomplete");
      return { kind: "sandbox_group", sandboxGroupId: row.sandboxGroupId };
    case "connected_machine":
      if (!row.connectedSandboxId) {
        throw new Error("ComputerSession connected-machine placement is incomplete");
      }
      return { kind: "connected_machine", sandboxId: row.connectedSandboxId };
    case "attached_device":
      if (!row.deviceId) throw new Error("ComputerSession attached-device placement is incomplete");
      return { kind: "attached_device", deviceId: row.deviceId };
    case "external_provider":
      if (!row.externalProviderId || !row.externalPlacementId) {
        throw new Error("ComputerSession external placement is incomplete");
      }
      return {
        kind: "external_provider",
        providerId: row.externalProviderId,
        placementId: row.externalPlacementId,
      };
  }
}

function controllerFromRow(row: ComputerSessionRow): InteractionControllerBindingValue | null {
  if (!row.controllerId && !row.controllerGeneration && !row.placementInstanceId) return null;
  if (!row.controllerId || !row.controllerGeneration || !row.placementInstanceId) {
    throw new Error("ComputerSession controller binding is incomplete");
  }
  return InteractionControllerBinding.parse({
    controllerId: row.controllerId,
    controllerGeneration: row.controllerGeneration,
    placementInstanceId: row.placementInstanceId,
  });
}

function associationFromRow(row: ComputerAssociationRow) {
  return {
    sessionId: row.sessionId,
    turnId: row.turnId,
    attemptId: row.attemptId,
    relationship: row.relationship,
    actorSubjectId: row.actorSubjectId,
    lastUsedAt: iso(row.lastUsedAt),
  } as const;
}

function computerSessionFromRows(
  row: ComputerSessionRow,
  associations: readonly ComputerAssociationRow[],
): ComputerSession {
  return ComputerSession.parse({
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    name: row.name,
    lifecycle: row.lifecycle,
    placement: placementFromRow(row),
    controller: controllerFromRow(row),
    platform: row.platform,
    adapter: row.adapter,
    seatId: row.seatId,
    displayId: row.displayId,
    capabilities: row.capabilities,
    associations: associations.map(associationFromRow),
    createdBySubjectId: row.createdBySubjectId,
    createdAt: iso(row.createdAt),
    lastUsedAt: iso(row.lastUsedAt),
    failureCode: row.failureCode,
  });
}

function operationReceipt(
  row: InteractionOperationRow,
  replayed: boolean,
): InteractionLifecycleOperationReceiptValue {
  const error: InteractionErrorValue | null = row.errorCode
    ? InteractionError.parse({
        code: row.errorCode,
        message: row.errorMessage,
        retryable: row.errorRetryable,
        ...(row.errorDetails ? { details: row.errorDetails } : {}),
      })
    : null;
  return InteractionLifecycleOperationReceipt.parse({
    operationId: row.operationId,
    resourceKind: row.resourceKind,
    resourceId: row.resourceId,
    kind: row.kind,
    state: row.state,
    replayed,
    error,
    createdAt: iso(row.createdAt),
    dispatchedAt: row.dispatchedAt ? iso(row.dispatchedAt) : null,
    settledAt: row.settledAt ? iso(row.settledAt) : null,
  });
}

async function loadAssociations(
  db: Database,
  workspaceId: string,
  computerSessionIds: readonly string[],
): Promise<ComputerAssociationRow[]> {
  if (computerSessionIds.length === 0) return [];
  return await db
    .select()
    .from(schema.computerSessionAssociations)
    .where(
      and(
        eq(schema.computerSessionAssociations.workspaceId, workspaceId),
        inArray(schema.computerSessionAssociations.computerSessionId, [...computerSessionIds]),
      ),
    )
    .orderBy(
      desc(schema.computerSessionAssociations.lastUsedAt),
      desc(schema.computerSessionAssociations.createdAt),
    );
}

async function loadComputerSession(
  db: Database,
  workspaceId: string,
  computerSessionId: string,
): Promise<ComputerSession | null> {
  const [row] = await db
    .select()
    .from(schema.computerSessions)
    .where(
      and(
        eq(schema.computerSessions.workspaceId, workspaceId),
        eq(schema.computerSessions.id, computerSessionId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return computerSessionFromRows(row, await loadAssociations(db, workspaceId, [computerSessionId]));
}

async function loadOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<InteractionOperationRow | null> {
  const [row] = await db
    .select()
    .from(schema.interactionOperations)
    .where(
      and(
        eq(schema.interactionOperations.workspaceId, workspaceId),
        eq(schema.interactionOperations.operationId, operationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function requestDigest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function computerSessionCreateRequestDigest(
  input: PrepareComputerSessionCreateInput,
): string {
  return requestDigest({
    version: 1,
    associatedSessionId: input.associatedSessionId,
    name: input.name,
    placement: input.placement,
    actorSubjectId: input.actorSubjectId,
  });
}

function lifecycleRequestDigest(
  computerSessionId: string,
  kind: InteractionLifecycleOperationKind,
  actorSubjectId: string,
): string {
  return requestDigest({ version: 1, computerSessionId, kind, actorSubjectId });
}

async function replayedMutation(
  db: Database,
  workspaceId: string,
  operation: InteractionOperationRow,
  expected: { kind: InteractionLifecycleOperationKind; digest: string },
): Promise<ComputerSessionMutationResponseValue> {
  if (
    operation.resourceKind !== "computer_session" ||
    operation.kind !== expected.kind ||
    operation.requestDigest !== expected.digest
  ) {
    throw new ComputerSessionOperationConflictError(
      "Interaction operation id is already bound to another request",
    );
  }
  const session = await loadComputerSession(db, workspaceId, operation.resourceId);
  if (!session) throw new Error("Interaction operation references a missing ComputerSession");
  return ComputerSessionMutationResponse.parse({
    session,
    operation: operationReceipt(operation, true),
  });
}

export async function listComputerSessions(
  db: Database,
  input: { accountId: string; workspaceId: string },
): Promise<ComputerSessionListResponseValue> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const rows = await scopedDb
        .select()
        .from(schema.computerSessions)
        .where(eq(schema.computerSessions.workspaceId, input.workspaceId))
        .orderBy(desc(schema.computerSessions.lastUsedAt), desc(schema.computerSessions.id));
      const associations = await loadAssociations(
        scopedDb,
        input.workspaceId,
        rows.map((row) => row.id),
      );
      const associationsByResource = new Map<string, ComputerAssociationRow[]>();
      for (const association of associations) {
        const current = associationsByResource.get(association.computerSessionId) ?? [];
        current.push(association);
        associationsByResource.set(association.computerSessionId, current);
      }
      return ComputerSessionListResponse.parse({
        revision: await readWorkspaceInteractionRevision(scopedDb, input.workspaceId),
        sessions: rows.map((row) =>
          computerSessionFromRows(row, associationsByResource.get(row.id) ?? []),
        ),
      });
    },
    CONSISTENT_READ,
  );
}

export async function getComputerSession(
  db: Database,
  input: { accountId: string; workspaceId: string; computerSessionId: string },
): Promise<ComputerSession> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const session = await loadComputerSession(
        scopedDb,
        input.workspaceId,
        input.computerSessionId,
      );
      if (!session) throw new ComputerSessionNotFoundError("ComputerSession not found");
      return session;
    },
    CONSISTENT_READ,
  );
}

async function controlRecordFromRows(
  db: Database,
  workspaceId: string,
  row: ComputerSessionRow,
  operation: InteractionOperationRow | null,
): Promise<ComputerSessionControlRecord> {
  const associations = await loadAssociations(db, workspaceId, [row.id]);
  const created = associations.filter((association) => association.relationship === "created");
  if (created.length !== 1) {
    throw new Error("ComputerSession must have exactly one creation association");
  }
  return {
    session: computerSessionFromRows(row, associations),
    tokenGeneration: row.tokenGeneration,
    sourceSessionId: created[0]!.sessionId,
    createOperationId: row.createOperationId,
    operation: operation
      ? {
          operationId: operation.operationId,
          kind: operation.kind,
          state: operation.state,
          controllerGeneration: operation.controllerGeneration,
          actorSubjectId: operation.actorSubjectId,
        }
      : null,
  };
}

export async function getComputerSessionControlRecord(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    computerSessionId: string;
    operationId?: string;
  },
): Promise<ComputerSessionControlRecord> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const [row] = await scopedDb
        .select()
        .from(schema.computerSessions)
        .where(
          and(
            eq(schema.computerSessions.accountId, input.accountId),
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
          ),
        )
        .limit(1);
      if (!row) throw new ComputerSessionNotFoundError("ComputerSession not found");
      const operation = input.operationId
        ? await loadOperation(scopedDb, input.workspaceId, input.operationId)
        : null;
      if (input.operationId) assertOperationResource(operation, input.computerSessionId);
      return await controlRecordFromRows(scopedDb, input.workspaceId, row, operation);
    },
    CONSISTENT_READ,
  );
}

export async function findComputerSessionControlRecordByOperation(
  db: Database,
  input: { accountId: string; workspaceId: string; operationId: string },
): Promise<ComputerSessionControlRecord | null> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => {
      const operation = await loadOperation(scopedDb, input.workspaceId, input.operationId);
      if (!operation) return null;
      if (operation.resourceKind !== "computer_session") {
        throw new ComputerSessionOperationConflictError(
          "Interaction operation is bound to another resource",
        );
      }
      const [row] = await scopedDb
        .select()
        .from(schema.computerSessions)
        .where(
          and(
            eq(schema.computerSessions.accountId, input.accountId),
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, operation.resourceId),
          ),
        )
        .limit(1);
      if (!row) throw new Error("ComputerSession operation references a missing resource");
      return await controlRecordFromRows(scopedDb, input.workspaceId, row, operation);
    },
    CONSISTENT_READ,
  );
}

function placementToColumns(placement: InteractionPlacement): {
  placementKind: ComputerSessionRow["placementKind"];
  sandboxGroupId: string | null;
  connectedSandboxId: string | null;
  deviceId: string | null;
  externalProviderId: string | null;
  externalPlacementId: string | null;
} {
  return {
    placementKind: placement.kind,
    sandboxGroupId: placement.kind === "sandbox_group" ? placement.sandboxGroupId : null,
    connectedSandboxId: placement.kind === "connected_machine" ? placement.sandboxId : null,
    deviceId: placement.kind === "attached_device" ? placement.deviceId : null,
    externalProviderId: placement.kind === "external_provider" ? placement.providerId : null,
    externalPlacementId: placement.kind === "external_provider" ? placement.placementId : null,
  };
}

export async function prepareComputerSessionCreate(
  db: Database,
  input: PrepareComputerSessionCreateInput,
): Promise<ComputerSessionMutationResponseValue> {
  const digest = computerSessionCreateRequestDigest(input);
  const computerSessionId = randomUUID();
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await tx.execute(sql`
        select id from workspaces
        where id = ${input.workspaceId} and account_id = ${input.accountId}
        for key share
      `);
      const existingOperation = await loadOperation(tx, input.workspaceId, input.operationId);
      if (existingOperation) {
        return await replayedMutation(tx, input.workspaceId, existingOperation, {
          kind: "create",
          digest,
        });
      }
      const [sourceSession] = await tx
        .select({ id: schema.sessions.id })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.workspaceId, input.workspaceId),
            eq(schema.sessions.id, input.associatedSessionId),
          ),
        )
        .limit(1);
      if (!sourceSession) throw new ComputerSessionNotFoundError("Associated session not found");

      const [insertedOperation] = await tx
        .insert(schema.interactionOperations)
        .values({
          operationId: input.operationId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          resourceKind: "computer_session",
          resourceId: computerSessionId,
          kind: "create",
          requestDigest: digest,
          state: "prepared",
          actorSubjectId: input.actorSubjectId,
        })
        .onConflictDoNothing({ target: schema.interactionOperations.operationId })
        .returning();
      if (!insertedOperation) {
        const existing = await loadOperation(tx, input.workspaceId, input.operationId);
        if (!existing) {
          throw new ComputerSessionOperationConflictError(
            "Interaction operation id belongs to another workspace",
          );
        }
        return await replayedMutation(tx, input.workspaceId, existing, {
          kind: "create",
          digest,
        });
      }

      const [insertedSession] = await tx
        .insert(schema.computerSessions)
        .values({
          id: computerSessionId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          name: input.name,
          lifecycle: "starting",
          ...placementToColumns(input.placement),
          createOperationId: input.operationId,
          createdBySubjectId: input.actorSubjectId,
        })
        .returning();
      if (!insertedSession) throw new Error("ComputerSession insert did not return its row");
      const [association] = await tx
        .insert(schema.computerSessionAssociations)
        .values({
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          computerSessionId,
          sessionId: input.associatedSessionId,
          turnId: null,
          attemptId: null,
          relationship: "created",
          actorSubjectId: input.actorSubjectId,
        })
        .returning();
      if (!association) throw new Error("ComputerSession association insert failed");
      await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
      return ComputerSessionMutationResponse.parse({
        session: computerSessionFromRows(insertedSession, [association]),
        operation: operationReceipt(insertedOperation, false),
      });
    }),
  );
}

export async function dispatchComputerSessionOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    computerSessionId: string;
    controllerGeneration: string;
    controller?: InteractionControllerBindingValue;
  },
): Promise<InteractionLifecycleOperationReceiptValue> {
  const controller = input.controller ? InteractionControllerBinding.parse(input.controller) : null;
  if (controller && controller.controllerGeneration !== input.controllerGeneration) {
    throw new ComputerSessionOperationConflictError(
      "ComputerSession dispatch controller generations disagree",
    );
  }
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockOperation(tx, input.workspaceId, input.operationId);
      const operation = await loadOperation(tx, input.workspaceId, input.operationId);
      assertOperationResource(operation, input.computerSessionId);
      if (operation.state === "prepared") {
        if (controller) {
          await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
          const now = new Date();
          const [bound] = await tx
            .update(schema.computerSessions)
            .set({
              controllerId: controller.controllerId,
              controllerGeneration: controller.controllerGeneration,
              placementInstanceId: controller.placementInstanceId,
              controllerHeartbeatAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.computerSessions.workspaceId, input.workspaceId),
                eq(schema.computerSessions.id, input.computerSessionId),
                eq(schema.computerSessions.lifecycle, "starting"),
              ),
            )
            .returning();
          if (!bound) {
            throw new ComputerSessionStateError(
              "ComputerSession cannot accept a controller dispatch binding",
            );
          }
        }
        const now = new Date();
        const [updated] = await tx
          .update(schema.interactionOperations)
          .set({
            state: "dispatched",
            controllerGeneration: input.controllerGeneration,
            dispatchedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.interactionOperations.operationId, input.operationId))
          .returning();
        if (!updated) throw new Error("ComputerSession operation dispatch was lost");
        return operationReceipt(updated, false);
      }
      if (
        operation.controllerGeneration !== null &&
        operation.controllerGeneration !== input.controllerGeneration
      ) {
        throw new ComputerSessionOperationConflictError(
          "ComputerSession operation belongs to another controller generation",
        );
      }
      if (controller) {
        const [row] = await tx
          .select()
          .from(schema.computerSessions)
          .where(
            and(
              eq(schema.computerSessions.workspaceId, input.workspaceId),
              eq(schema.computerSessions.id, input.computerSessionId),
            ),
          )
          .limit(1);
        const current = row ? controllerFromRow(row) : null;
        if (
          !current ||
          current.controllerId !== controller.controllerId ||
          current.controllerGeneration !== controller.controllerGeneration ||
          current.placementInstanceId !== controller.placementInstanceId
        ) {
          throw new ComputerSessionOperationConflictError(
            "ComputerSession dispatch belongs to another controller binding",
          );
        }
      }
      return operationReceipt(operation, true);
    }),
  );
}

export async function activateComputerSession(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    computerSessionId: string;
    controller: InteractionControllerBindingValue;
    platform: "linux" | "macos" | "windows";
    adapter: string;
    seatId: string;
    displayId: string;
    capabilities: ComputerSessionCapabilitiesValue;
  },
): Promise<ComputerSessionMutationResponseValue> {
  const controller = InteractionControllerBinding.parse(input.controller);
  const capabilities = ComputerSessionCapabilities.parse(input.capabilities);
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockOperation(tx, input.workspaceId, input.operationId);
      const operation = await loadOperation(tx, input.workspaceId, input.operationId);
      assertOperationResource(operation, input.computerSessionId);
      if (operation.state === "completed") {
        return await replayedMutation(tx, input.workspaceId, operation, {
          kind: operation.kind,
          digest: operation.requestDigest,
        });
      }
      if (operation.state !== "prepared" && operation.state !== "dispatched") {
        throw new ComputerSessionStateError("ComputerSession operation is already terminal");
      }
      if (
        operation.controllerGeneration !== null &&
        operation.controllerGeneration !== controller.controllerGeneration
      ) {
        throw new ComputerSessionOperationConflictError(
          "ComputerSession activation has a stale controller generation",
        );
      }
      await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
      const now = new Date();
      const [sessionRow] = await tx
        .update(schema.computerSessions)
        .set({
          lifecycle: "active",
          controllerId: controller.controllerId,
          controllerGeneration: controller.controllerGeneration,
          placementInstanceId: controller.placementInstanceId,
          platform: input.platform,
          adapter: input.adapter,
          seatId: input.seatId,
          displayId: input.displayId,
          capabilities,
          controllerHeartbeatAt: now,
          lastUsedAt: now,
          failureCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
            inArray(schema.computerSessions.lifecycle, ["starting", "active"]),
          ),
        )
        .returning();
      if (!sessionRow) throw new ComputerSessionStateError("ComputerSession cannot be activated");
      const [operationRow] = await tx
        .update(schema.interactionOperations)
        .set({
          state: "completed",
          controllerGeneration: controller.controllerGeneration,
          dispatchedAt: operation.dispatchedAt ?? now,
          settledAt: now,
          updatedAt: now,
        })
        .where(eq(schema.interactionOperations.operationId, input.operationId))
        .returning();
      if (!operationRow) throw new Error("ComputerSession operation completion was lost");
      const associations = await loadAssociations(tx, input.workspaceId, [input.computerSessionId]);
      await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
      return ComputerSessionMutationResponse.parse({
        session: computerSessionFromRows(sessionRow, associations),
        operation: operationReceipt(operationRow, false),
      });
    }),
  );
}

export async function failComputerSessionOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    computerSessionId: string;
    state?: "failed" | "outcome_unknown";
    error: InteractionErrorValue;
  },
): Promise<ComputerSessionMutationResponseValue> {
  const failure = InteractionError.parse(input.error);
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockOperation(tx, input.workspaceId, input.operationId);
      const operation = await loadOperation(tx, input.workspaceId, input.operationId);
      assertOperationResource(operation, input.computerSessionId);
      if (["completed", "failed", "outcome_unknown"].includes(operation.state)) {
        return await replayedMutation(tx, input.workspaceId, operation, {
          kind: operation.kind,
          digest: operation.requestDigest,
        });
      }
      await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
      const now = new Date();
      const uncertain = input.state === "outcome_unknown";
      const [sessionRow] = await tx
        .update(schema.computerSessions)
        .set({
          lifecycle: uncertain ? "lost" : "failed",
          ...(uncertain
            ? {}
            : {
                controllerId: null,
                controllerGeneration: null,
                placementInstanceId: null,
                controllerHeartbeatAt: null,
              }),
          failureCode: failure.code,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
          ),
        )
        .returning();
      const [operationRow] = await tx
        .update(schema.interactionOperations)
        .set({
          state: input.state ?? "failed",
          errorCode: failure.code,
          errorMessage: failure.message,
          errorRetryable: failure.retryable,
          errorDetails: failure.details ?? null,
          settledAt: now,
          updatedAt: now,
        })
        .where(eq(schema.interactionOperations.operationId, input.operationId))
        .returning();
      if (!sessionRow || !operationRow) {
        throw new Error("ComputerSession failure settlement was lost");
      }
      const associations = await loadAssociations(tx, input.workspaceId, [input.computerSessionId]);
      await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
      return ComputerSessionMutationResponse.parse({
        session: computerSessionFromRows(sessionRow, associations),
        operation: operationReceipt(operationRow, false),
      });
    }),
  );
}

export async function prepareComputerSessionEnd(
  db: Database,
  input: PrepareComputerSessionEndInput,
): Promise<ComputerSessionMutationResponseValue> {
  const digest = lifecycleRequestDigest(input.computerSessionId, "end", input.actorSubjectId);
  try {
    return await withRlsContext(db, input, async (scopedDb) =>
      scopedDb.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Database;
        await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
        const session = await loadComputerSession(tx, input.workspaceId, input.computerSessionId);
        if (!session) throw new ComputerSessionNotFoundError("ComputerSession not found");
        const [dependentBrowser] = await tx
          .select({ id: schema.browserSessions.id })
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.linkedComputerSessionId, input.computerSessionId),
              inArray(schema.browserSessions.lifecycle, [
                "starting",
                "active",
                "suspending",
                "suspended",
                "restoring",
                "repair_required",
                "ending",
              ]),
            ),
          )
          .limit(1);
        if (dependentBrowser) {
          throw new ComputerSessionStateError(
            "ComputerSession is still used by a BrowserSession; end the browser first",
          );
        }
        const now = new Date();
        const terminal = session.lifecycle === "ended";
        const [insertedOperation] = await tx
          .insert(schema.interactionOperations)
          .values({
            operationId: input.operationId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            resourceKind: "computer_session",
            resourceId: input.computerSessionId,
            kind: "end",
            requestDigest: digest,
            state: terminal ? "completed" : "prepared",
            actorSubjectId: input.actorSubjectId,
            ...(terminal ? { dispatchedAt: now, settledAt: now } : {}),
          })
          .onConflictDoNothing({ target: schema.interactionOperations.operationId })
          .returning();
        if (!insertedOperation) {
          const existing = await loadOperation(tx, input.workspaceId, input.operationId);
          if (!existing) {
            throw new ComputerSessionOperationConflictError(
              "Interaction operation id belongs to another workspace",
            );
          }
          return await replayedMutation(tx, input.workspaceId, existing, {
            kind: "end",
            digest,
          });
        }
        if (terminal) {
          return ComputerSessionMutationResponse.parse({
            session,
            operation: operationReceipt(insertedOperation, false),
          });
        }
        const [sessionRow] = await tx
          .update(schema.computerSessions)
          .set({ lifecycle: "ending", failureCode: null, updatedAt: now })
          .where(
            and(
              eq(schema.computerSessions.workspaceId, input.workspaceId),
              eq(schema.computerSessions.id, input.computerSessionId),
            ),
          )
          .returning();
        if (!sessionRow) throw new ComputerSessionNotFoundError("ComputerSession not found");
        const associations = await loadAssociations(tx, input.workspaceId, [
          input.computerSessionId,
        ]);
        await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
        return ComputerSessionMutationResponse.parse({
          session: computerSessionFromRows(sessionRow, associations),
          operation: operationReceipt(insertedOperation, false),
        });
      }),
    );
  } catch (error) {
    if (safeDatabaseErrorFacts(error).constraint === "interaction_operations_active_resource_uq") {
      throw new ComputerSessionOperationConflictError(
        "ComputerSession already has an active lifecycle operation",
      );
    }
    throw error;
  }
}

export async function completeComputerSessionEnd(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    computerSessionId: string;
    expectedControllerGeneration: string | null;
  },
): Promise<ComputerSessionMutationResponseValue> {
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      await lockOperation(tx, input.workspaceId, input.operationId);
      const operation = await loadOperation(tx, input.workspaceId, input.operationId);
      assertOperationResource(operation, input.computerSessionId, "end");
      if (operation.state === "completed") {
        return await replayedMutation(tx, input.workspaceId, operation, {
          kind: "end",
          digest: operation.requestDigest,
        });
      }
      if (operation.state !== "prepared" && operation.state !== "dispatched") {
        throw new ComputerSessionStateError("ComputerSession end operation is already terminal");
      }
      await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
      const [current] = await tx
        .select()
        .from(schema.computerSessions)
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
          ),
        )
        .limit(1);
      if (!current) throw new ComputerSessionNotFoundError("ComputerSession not found");
      if (current.controllerGeneration !== input.expectedControllerGeneration) {
        throw new ComputerSessionOperationConflictError(
          "ComputerSession end has a stale controller generation",
        );
      }
      const now = new Date();
      const [sessionRow] = await tx
        .update(schema.computerSessions)
        .set({
          lifecycle: "ended",
          controllerId: null,
          controllerGeneration: null,
          placementInstanceId: null,
          controllerHeartbeatAt: null,
          failureCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
          ),
        )
        .returning();
      const [operationRow] = await tx
        .update(schema.interactionOperations)
        .set({
          state: "completed",
          controllerGeneration: input.expectedControllerGeneration,
          dispatchedAt: operation.dispatchedAt ?? now,
          settledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.interactionOperations.workspaceId, input.workspaceId),
            eq(schema.interactionOperations.operationId, input.operationId),
          ),
        )
        .returning();
      if (!sessionRow || !operationRow) throw new Error("ComputerSession end completion was lost");
      const associations = await loadAssociations(tx, input.workspaceId, [input.computerSessionId]);
      await advanceWorkspaceInteractionRevision(tx, input.accountId, input.workspaceId);
      return ComputerSessionMutationResponse.parse({
        session: computerSessionFromRows(sessionRow, associations),
        operation: operationReceipt(operationRow, false),
      });
    }),
  );
}

export async function touchComputerSessionController(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    computerSessionId: string;
    controllerGeneration: string;
  },
): Promise<boolean> {
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Database;
      const [observed] = await tx
        .select()
        .from(schema.computerSessions)
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
            eq(schema.computerSessions.lifecycle, "active"),
            eq(schema.computerSessions.controllerGeneration, input.controllerGeneration),
          ),
        )
        .limit(1);
      if (!observed) return false;
      if (observed.placementKind === "attached_device") {
        if (!observed.deviceId || !observed.placementInstanceId) return false;
        const current = await attachedDeviceGenerationMatches(tx, {
          workspaceId: input.workspaceId,
          deviceId: observed.deviceId,
          placementInstanceId: observed.placementInstanceId,
        });
        if (!current) return false;
      }
      if (observed.placementKind === "sandbox_group") {
        const lease = await tx.execute<{ id: string }>(sql`
          select lease.id
          from sandbox_leases lease
          join computer_sessions computer
            on computer.account_id = lease.account_id
           and computer.workspace_id = lease.workspace_id
           and computer.sandbox_group_id = lease.sandbox_group_id
          where computer.account_id = ${input.accountId}
            and computer.workspace_id = ${input.workspaceId}
            and computer.id = ${input.computerSessionId}
            and computer.lifecycle = 'active'
            and computer.controller_generation = ${input.controllerGeneration}
            and computer.placement_instance_id = lease.instance_id
          for update of lease
        `);
        if (!lease[0]) return false;
        const holder = await tx.execute<{ id: string }>(sql`
          update sandbox_lease_holders holder set last_heartbeat_at = now()
          from sandbox_leases lease
          where lease.id = holder.lease_id
            and holder.account_id = ${input.accountId}
            and holder.workspace_id = ${input.workspaceId}
            and holder.kind = 'interaction'
            and holder.holder_id = ${`computer-session:${input.computerSessionId}`}
            and lease.workspace_id = ${input.workspaceId}
            and lease.sandbox_group_id = ${observed.sandboxGroupId}
            and lease.instance_id = ${observed.placementInstanceId}
          returning holder.id
        `);
        if (!holder[0]) return false;
      }
      await lockComputerSession(tx, input.workspaceId, input.computerSessionId);
      const now = new Date();
      const [updated] = await tx
        .update(schema.computerSessions)
        .set({ controllerHeartbeatAt: now, lastUsedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.computerSessions.workspaceId, input.workspaceId),
            eq(schema.computerSessions.id, input.computerSessionId),
            eq(schema.computerSessions.lifecycle, "active"),
            eq(schema.computerSessions.controllerGeneration, input.controllerGeneration),
          ),
        )
        .returning({ id: schema.computerSessions.id });
      return updated !== undefined;
    }),
  );
}

async function lockOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<void> {
  await db.execute(sql`
    select operation_id from interaction_operations
    where workspace_id = ${workspaceId} and operation_id = ${operationId}
    for update
  `);
}

async function lockComputerSession(
  db: Database,
  workspaceId: string,
  computerSessionId: string,
): Promise<void> {
  await db.execute(sql`
    select id from computer_sessions
    where workspace_id = ${workspaceId} and id = ${computerSessionId}
    for update
  `);
}

function assertOperationResource(
  operation: InteractionOperationRow | null,
  computerSessionId: string,
  kind?: InteractionLifecycleOperationKind,
): asserts operation is InteractionOperationRow {
  if (!operation) throw new ComputerSessionNotFoundError("ComputerSession operation not found");
  if (
    operation.resourceKind !== "computer_session" ||
    operation.resourceId !== computerSessionId ||
    (kind !== undefined && operation.kind !== kind)
  ) {
    throw new ComputerSessionOperationConflictError(
      "Interaction operation is bound to another resource",
    );
  }
}
