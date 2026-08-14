import { createHash } from "node:crypto";

import {
  CapabilityPack as CapabilityPackSchema,
  stableJson,
  type CapabilityPack,
  type PackInstallation,
  type PackInstallationStatus,
} from "@opengeni/contracts";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { withRlsContext, type Database } from "./database";
import * as schema from "./schema";

export class PackOperationIdempotencyError extends Error {
  readonly name = "PackOperationIdempotencyError";
}

export class PackOperationInProgressError extends Error {
  readonly name = "PackOperationInProgressError";
}

export class PackOperationClaimLostError extends Error {
  readonly name = "PackOperationClaimLostError";
}

export class PackManifestChangedError extends Error {
  readonly name = "PackManifestChangedError";
}

export class PackInstallationVersionConflictError extends Error {
  readonly name = "PackInstallationVersionConflictError";

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Pack installation changed: expected version ${expectedVersion}, current version ${actualVersion}`,
    );
  }
}

export class PackInstallationVersionRequiredError extends Error {
  readonly name = "PackInstallationVersionRequiredError";
}

export type PreparedPackInstallation = {
  installation: PackInstallation;
  operationId: string;
  operationVersion: number;
  replayResult: Record<string, unknown> | null;
};

export async function preparePackInstallationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    pack: CapabilityPack;
    manifestDigest: string;
    selectedRigId: string | null;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
    requestDigest: string;
    registeredManifestDigest?: string;
    expectedInstallationVersion?: number;
  },
): Promise<PreparedPackInstallation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`capability-operation:${input.workspaceId}:${input.idempotencyKey}`}, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`pack-installation:${input.workspaceId}:${input.pack.id}`}, 0))`,
        );
        let [operation] = await tx
          .select()
          .from(schema.capabilityOperations)
          .where(
            and(
              eq(schema.capabilityOperations.workspaceId, input.workspaceId),
              eq(schema.capabilityOperations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .for("update")
          .limit(1);
        let [existing] = await tx
          .select()
          .from(schema.packInstallations)
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.packId, input.pack.id),
            ),
          )
          .for("update")
          .limit(1);
        if (operation && operation.requestDigest !== input.requestDigest) {
          throw new PackOperationIdempotencyError("Pack idempotency key was reused");
        }
        if (operation?.status === "completed" && operation.result) {
          if (!existing) throw new Error("Completed Pack operation lost its installation");
          return {
            installation: mapPackInstallation(existing),
            operationId: operation.id,
            operationVersion: operation.version,
            replayResult: operation.result,
          };
        }
        if (input.registeredManifestDigest) {
          await assertRegisteredPackManifestCurrent(tx as unknown as Database, {
            workspaceId: input.workspaceId,
            packId: input.pack.id,
            expectedDigest: input.registeredManifestDigest,
            admittedDigest: input.manifestDigest,
          });
        }
        assertPackOperationRetryableStatus(operation);
        const resuming = Boolean(operation);
        if (!resuming && existing) {
          if (input.expectedInstallationVersion === undefined) {
            throw new PackInstallationVersionRequiredError(
              "Updating or repairing a Pack requires the previewed installation version",
            );
          }
          if (existing.version !== input.expectedInstallationVersion) {
            throw new PackInstallationVersionConflictError(
              input.expectedInstallationVersion,
              existing.version,
            );
          }
        }
        const otherOperation = await findOtherPackOperationInProgress(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          packId: input.pack.id,
          ...(operation ? { operationId: operation.id } : {}),
        });
        if (operation && otherOperation) {
          throw new PackOperationInProgressError("Another Pack operation is already in progress");
        }
        if (!operation) {
          if (otherOperation?.status === "running") {
            if (
              !existing ||
              !["install", "update", "repair"].includes(otherOperation.kind) ||
              !samePackInstallationIntent(existing, input)
            ) {
              throw new PackOperationInProgressError(
                "Another Pack operation is already in progress",
              );
            }
            await supersedeStaleRunningPackOperation(tx as unknown as Database, otherOperation);
          } else if (otherOperation?.status === "pending") {
            await supersedePendingPackOperation(tx as unknown as Database, otherOperation);
          }
          [operation] = await tx
            .insert(schema.capabilityOperations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              idempotencyKey: input.idempotencyKey,
              requestDigest: input.requestDigest,
              kind: !existing
                ? "install"
                : existing.manifestDigest === input.manifestDigest
                  ? "repair"
                  : "update",
              targetKind: "pack",
              targetId: input.pack.id,
              status: "running",
              phase: "admitted",
              createdBySubjectId: input.subjectId,
            })
            .returning();
        } else {
          operation = await resumePackOperation(tx as unknown as Database, operation);
        }
        if (!operation) throw new Error("Failed to admit Pack operation");
        const now = new Date();
        if (!existing) {
          [existing] = await tx
            .insert(schema.packInstallations)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              packId: input.pack.id,
              status: "installing",
              manifestSnapshot: input.pack as unknown as Record<string, unknown>,
              manifestDigest: input.manifestDigest,
              selectedRigId: input.selectedRigId,
              installedBySubjectId: input.subjectId,
              metadata: input.metadata,
            })
            .returning();
        } else if (!resuming) {
          [existing] = await tx
            .update(schema.packInstallations)
            .set({
              status: "needs_attention",
              version: existing.version + 1,
              manifestSnapshot: input.pack as unknown as Record<string, unknown>,
              manifestDigest: input.manifestDigest,
              selectedRigId: input.selectedRigId,
              installedBySubjectId: input.subjectId,
              metadata: input.metadata,
              enabledAt: now,
              updatedAt: now,
            })
            .where(eq(schema.packInstallations.id, existing.id))
            .returning();
        } else {
          [existing] = await tx
            .update(schema.packInstallations)
            .set({
              status: existing.status === "installing" ? "installing" : "needs_attention",
              updatedAt: now,
            })
            .where(eq(schema.packInstallations.id, existing.id))
            .returning();
        }
        if (!existing) throw new Error("Failed to prepare Pack installation");
        return {
          installation: mapPackInstallation(existing),
          operationId: operation.id,
          operationVersion: operation.version,
          replayResult: null,
        };
      }),
  );
}

export async function finalizePackInstallationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationVersion: number;
    packInstallationId: string;
    packId: string;
    result: Record<string, unknown>;
  },
): Promise<PackInstallation> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await assertActivePackOperationClaim(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          operationVersion: input.operationVersion,
          packInstallationId: input.packInstallationId,
        });
        const now = new Date();
        const [installation] = await tx
          .update(schema.packInstallations)
          .set({ status: "active", updatedAt: now })
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.id, input.packInstallationId),
              eq(schema.packInstallations.packId, input.packId),
            ),
          )
          .returning();
        if (!installation) throw new Error("Pack installation was not found during finalize");
        const [completed] = await tx
          .update(schema.capabilityOperations)
          .set({
            status: "completed",
            phase: "completed",
            result: input.result,
            errorCode: null,
            version: sql`${schema.capabilityOperations.version} + 1`,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.capabilityOperations.id, input.operationId),
              eq(schema.capabilityOperations.status, "running"),
              eq(schema.capabilityOperations.version, input.operationVersion),
            ),
          )
          .returning({ id: schema.capabilityOperations.id });
        if (!completed) throw new PackOperationClaimLostError("Pack operation claim was lost");
        return mapPackInstallation(installation);
      }),
  );
}

export async function deferPackInstallationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationVersion: number;
    packInstallationId: string;
    phase: string;
    errorCode: string;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const operation = await assertActivePackOperationClaim(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          operationVersion: input.operationVersion,
          packInstallationId: input.packInstallationId,
        });
        await tx
          .update(schema.packInstallations)
          .set({ status: "needs_attention", updatedAt: new Date() })
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.id, input.packInstallationId),
              eq(schema.packInstallations.packId, operation.targetId),
            ),
          );
        const [deferred] = await tx
          .update(schema.capabilityOperations)
          .set({
            status: "pending",
            phase: input.phase.slice(0, 120),
            errorCode: input.errorCode.slice(0, 120),
            version: sql`${schema.capabilityOperations.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.capabilityOperations.id, input.operationId),
              eq(schema.capabilityOperations.status, "running"),
              eq(schema.capabilityOperations.version, input.operationVersion),
            ),
          )
          .returning({ id: schema.capabilityOperations.id });
        if (!deferred) throw new PackOperationClaimLostError("Pack operation claim was lost");
      }),
  );
}

export async function touchPackInstallationOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationVersion: number;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) => {
      const [touched] = await scopedDb
        .update(schema.capabilityOperations)
        .set({ updatedAt: sql`now()` })
        .where(
          and(
            eq(schema.capabilityOperations.workspaceId, input.workspaceId),
            eq(schema.capabilityOperations.id, input.operationId),
            eq(schema.capabilityOperations.status, "running"),
            eq(schema.capabilityOperations.version, input.operationVersion),
          ),
        )
        .returning({ id: schema.capabilityOperations.id });
      if (!touched) throw new PackOperationClaimLostError("Pack operation claim was lost");
    },
  );
}

export async function preparePackUninstallOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    packId: string;
    expectedInstallationVersion: number;
    idempotencyKey: string;
    requestDigest: string;
  },
): Promise<PreparedPackInstallation | { replayResult: Record<string, unknown> }> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`capability-operation:${input.workspaceId}:${input.idempotencyKey}`}, 0))`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`pack-installation:${input.workspaceId}:${input.packId}`}, 0))`,
        );
        const [operation] = await tx
          .select()
          .from(schema.capabilityOperations)
          .where(
            and(
              eq(schema.capabilityOperations.workspaceId, input.workspaceId),
              eq(schema.capabilityOperations.idempotencyKey, input.idempotencyKey),
            ),
          )
          .for("update")
          .limit(1);
        const [installation] = await tx
          .select()
          .from(schema.packInstallations)
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.packId, input.packId),
            ),
          )
          .for("update")
          .limit(1);
        if (operation) {
          if (operation.requestDigest !== input.requestDigest) {
            throw new PackOperationIdempotencyError("Pack idempotency key was reused");
          }
          if (operation.status === "completed" && operation.result) {
            return { replayResult: operation.result };
          }
          assertPackOperationRetryableStatus(operation);
          const otherOperation = await findOtherPackOperationInProgress(tx as unknown as Database, {
            workspaceId: input.workspaceId,
            packId: input.packId,
            operationId: operation.id,
          });
          if (otherOperation) {
            throw new PackOperationInProgressError("Another Pack operation is already in progress");
          }
          const resumed = await resumePackOperation(tx as unknown as Database, operation);
          if (!installation || installation.status === "disabled") {
            const result = { status: "not_installed" };
            await completePackOperation(
              tx as unknown as Database,
              operation.id,
              resumed.version,
              result,
            );
            return { replayResult: result };
          }
          return {
            installation: mapPackInstallation(installation),
            operationId: operation.id,
            operationVersion: resumed.version,
            replayResult: null,
          };
        }
        if (!installation || installation.status === "disabled") {
          const result = { status: "not_installed" };
          const otherOperation = await findOtherPackOperationInProgress(tx as unknown as Database, {
            workspaceId: input.workspaceId,
            packId: input.packId,
          });
          if (otherOperation?.status === "running") {
            if (otherOperation.kind !== "uninstall") {
              throw new PackOperationInProgressError(
                "Another Pack operation is already in progress",
              );
            }
            await supersedeStaleRunningPackOperation(tx as unknown as Database, otherOperation);
          } else if (otherOperation?.status === "pending") {
            await supersedePendingPackOperation(tx as unknown as Database, otherOperation);
          }
          await tx.insert(schema.capabilityOperations).values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            kind: "uninstall",
            targetKind: "pack",
            targetId: input.packId,
            status: "completed",
            phase: "completed",
            result,
            createdBySubjectId: input.subjectId,
            completedAt: new Date(),
          });
          return { replayResult: result };
        }
        if (installation.version !== input.expectedInstallationVersion) {
          throw new PackInstallationVersionConflictError(
            input.expectedInstallationVersion,
            installation.version,
          );
        }
        const otherOperation = await findOtherPackOperationInProgress(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          packId: input.packId,
        });
        if (otherOperation?.status === "running") {
          if (otherOperation.kind !== "uninstall") {
            throw new PackOperationInProgressError("Another Pack operation is already in progress");
          }
          await supersedeStaleRunningPackOperation(tx as unknown as Database, otherOperation);
        } else if (otherOperation?.status === "pending") {
          await supersedePendingPackOperation(tx as unknown as Database, otherOperation);
        }
        const [createdOperation] = await tx
          .insert(schema.capabilityOperations)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            kind: "uninstall",
            targetKind: "pack",
            targetId: input.packId,
            status: "running",
            phase: "admitted",
            createdBySubjectId: input.subjectId,
          })
          .returning();
        if (!createdOperation) throw new Error("Failed to admit Pack uninstall");
        const [prepared] = await tx
          .update(schema.packInstallations)
          .set({
            status: "needs_attention",
            version: installation.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.packInstallations.id, installation.id))
          .returning();
        if (!prepared) throw new Error("Failed to prepare Pack uninstall");
        return {
          installation: mapPackInstallation(prepared),
          operationId: createdOperation.id,
          operationVersion: createdOperation.version,
          replayResult: null,
        };
      }),
  );
}

export async function finalizePackUninstallOperation(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationVersion: number;
    packInstallationId: string;
    packId: string;
    result: Record<string, unknown>;
  },
): Promise<void> {
  await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await assertActivePackOperationClaim(tx as unknown as Database, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          operationId: input.operationId,
          operationVersion: input.operationVersion,
          packInstallationId: input.packInstallationId,
        });
        const now = new Date();
        await tx
          .update(schema.packInstallations)
          .set({ status: "disabled", updatedAt: now })
          .where(
            and(
              eq(schema.packInstallations.workspaceId, input.workspaceId),
              eq(schema.packInstallations.id, input.packInstallationId),
              eq(schema.packInstallations.packId, input.packId),
            ),
          );
        const [completed] = await tx
          .update(schema.capabilityOperations)
          .set({
            status: "completed",
            phase: "completed",
            result: input.result,
            errorCode: null,
            version: sql`${schema.capabilityOperations.version} + 1`,
            completedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.capabilityOperations.id, input.operationId),
              eq(schema.capabilityOperations.status, "running"),
              eq(schema.capabilityOperations.version, input.operationVersion),
            ),
          )
          .returning({ id: schema.capabilityOperations.id });
        if (!completed) throw new PackOperationClaimLostError("Pack operation claim was lost");
      }),
  );
}

async function findOtherPackOperationInProgress(
  db: Database,
  input: { workspaceId: string; packId: string; operationId?: string },
): Promise<Pick<
  typeof schema.capabilityOperations.$inferSelect,
  "id" | "kind" | "status" | "version" | "updatedAt"
> | null> {
  const [operation] = await db
    .select({
      id: schema.capabilityOperations.id,
      kind: schema.capabilityOperations.kind,
      status: schema.capabilityOperations.status,
      version: schema.capabilityOperations.version,
      updatedAt: schema.capabilityOperations.updatedAt,
    })
    .from(schema.capabilityOperations)
    .where(
      and(
        eq(schema.capabilityOperations.workspaceId, input.workspaceId),
        eq(schema.capabilityOperations.targetKind, "pack"),
        eq(schema.capabilityOperations.targetId, input.packId),
        inArray(schema.capabilityOperations.status, ["running", "pending"]),
        input.operationId ? ne(schema.capabilityOperations.id, input.operationId) : sql`true`,
      ),
    )
    .orderBy(schema.capabilityOperations.createdAt)
    .limit(1);
  return operation ?? null;
}

async function resumePackOperation(
  db: Database,
  operation: typeof schema.capabilityOperations.$inferSelect,
): Promise<typeof schema.capabilityOperations.$inferSelect> {
  if (operation.status === "completed") {
    if (operation.result) return operation;
    throw new Error("Completed Pack operation has no replay result");
  }
  if (operation.status !== "pending" && operation.status !== "running") {
    throw new PackOperationIdempotencyError("Pack idempotency key is no longer retryable");
  }
  const [resumed] = await db
    .update(schema.capabilityOperations)
    .set({
      status: "running",
      phase: operation.status === "running" ? "recovering_stale" : "resuming",
      errorCode: null,
      version: operation.version + 1,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(schema.capabilityOperations.id, operation.id),
        eq(schema.capabilityOperations.status, operation.status),
        eq(schema.capabilityOperations.version, operation.version),
        operation.status === "running"
          ? sql`${schema.capabilityOperations.updatedAt} <= now() - interval '15 minutes'`
          : sql`true`,
      ),
    )
    .returning();
  if (!resumed) {
    throw new PackOperationInProgressError(
      operation.status === "running"
        ? "This Pack operation is still running"
        : "This Pack operation changed before retry admission",
    );
  }
  return resumed;
}

function assertPackOperationRetryableStatus(
  operation: typeof schema.capabilityOperations.$inferSelect | undefined,
): void {
  if (!operation || operation.status === "pending" || operation.status === "running") return;
  if (operation.status === "completed") {
    throw new Error("Completed Pack operation has no replay result");
  }
  throw new PackOperationIdempotencyError("Pack idempotency key is no longer retryable");
}

async function supersedePendingPackOperation(
  db: Database,
  operation: Pick<typeof schema.capabilityOperations.$inferSelect, "id" | "status" | "version">,
): Promise<void> {
  const now = new Date();
  const [superseded] = await db
    .update(schema.capabilityOperations)
    .set({
      status: "failed",
      phase: "superseded",
      errorCode: "superseded_by_retry",
      version: sql`${schema.capabilityOperations.version} + 1`,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capabilityOperations.id, operation.id),
        eq(schema.capabilityOperations.status, "pending"),
        eq(schema.capabilityOperations.version, operation.version),
      ),
    )
    .returning({ id: schema.capabilityOperations.id });
  if (!superseded) {
    throw new PackOperationInProgressError("Another Pack operation changed before retry admission");
  }
}

async function supersedeStaleRunningPackOperation(
  db: Database,
  operation: Pick<typeof schema.capabilityOperations.$inferSelect, "id" | "status" | "version">,
): Promise<void> {
  const now = new Date();
  const [superseded] = await db
    .update(schema.capabilityOperations)
    .set({
      status: "failed",
      phase: "superseded_stale",
      errorCode: "superseded_by_recovery",
      version: operation.version + 1,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capabilityOperations.id, operation.id),
        eq(schema.capabilityOperations.status, "running"),
        eq(schema.capabilityOperations.version, operation.version),
        sql`${schema.capabilityOperations.updatedAt} <= now() - interval '15 minutes'`,
      ),
    )
    .returning({ id: schema.capabilityOperations.id });
  if (!superseded) {
    throw new PackOperationInProgressError("Another Pack operation is still running");
  }
}

async function assertActivePackOperationClaim(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    operationId: string;
    operationVersion: number;
    packInstallationId: string;
  },
): Promise<typeof schema.capabilityOperations.$inferSelect> {
  const [operation] = await db
    .select()
    .from(schema.capabilityOperations)
    .where(
      and(
        eq(schema.capabilityOperations.id, input.operationId),
        eq(schema.capabilityOperations.accountId, input.accountId),
        eq(schema.capabilityOperations.workspaceId, input.workspaceId),
        eq(schema.capabilityOperations.targetKind, "pack"),
        eq(schema.capabilityOperations.status, "running"),
        eq(schema.capabilityOperations.version, input.operationVersion),
      ),
    )
    .for("update")
    .limit(1);
  if (!operation) throw new PackOperationClaimLostError("Pack operation claim was lost");
  const [installation] = await db
    .select({ id: schema.packInstallations.id })
    .from(schema.packInstallations)
    .where(
      and(
        eq(schema.packInstallations.id, input.packInstallationId),
        eq(schema.packInstallations.accountId, input.accountId),
        eq(schema.packInstallations.workspaceId, input.workspaceId),
        eq(schema.packInstallations.packId, operation.targetId),
      ),
    )
    .limit(1);
  if (!installation) {
    throw new PackOperationClaimLostError("Pack operation no longer matches its installation");
  }
  return operation;
}

function samePackInstallationIntent(
  existing: typeof schema.packInstallations.$inferSelect,
  input: {
    manifestDigest: string;
    selectedRigId: string | null;
    metadata: Record<string, unknown>;
  },
): boolean {
  return (
    existing.manifestDigest === input.manifestDigest &&
    existing.selectedRigId === input.selectedRigId &&
    stableJson(existing.metadata) === stableJson(input.metadata)
  );
}

async function assertRegisteredPackManifestCurrent(
  db: Database,
  input: {
    workspaceId: string;
    packId: string;
    expectedDigest: string;
    admittedDigest: string;
  },
): Promise<void> {
  const [registration] = await db
    .select({ manifest: schema.workspacePacks.manifest })
    .from(schema.workspacePacks)
    .where(
      and(
        eq(schema.workspacePacks.workspaceId, input.workspaceId),
        eq(schema.workspacePacks.packId, input.packId),
      ),
    )
    .for("update")
    .limit(1);
  const parsed = registration ? CapabilityPackSchema.safeParse(registration.manifest) : null;
  const currentDigest =
    parsed?.success === true
      ? createHash("sha256").update(stableJson(parsed.data)).digest("hex")
      : null;
  if (input.expectedDigest !== input.admittedDigest || currentDigest !== input.expectedDigest) {
    throw new PackManifestChangedError(
      "Pack manifest changed after preview; review the current installation plan",
    );
  }
}

async function completePackOperation(
  db: Database,
  operationId: string,
  operationVersion: number,
  result: Record<string, unknown>,
): Promise<void> {
  const now = new Date();
  const [completed] = await db
    .update(schema.capabilityOperations)
    .set({
      status: "completed",
      phase: "completed",
      result,
      errorCode: null,
      version: sql`${schema.capabilityOperations.version} + 1`,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.capabilityOperations.id, operationId),
        eq(schema.capabilityOperations.status, "running"),
        eq(schema.capabilityOperations.version, operationVersion),
      ),
    )
    .returning({ id: schema.capabilityOperations.id });
  if (!completed) throw new PackOperationClaimLostError("Pack operation claim was lost");
}

function mapPackInstallation(row: typeof schema.packInstallations.$inferSelect): PackInstallation {
  return {
    id: row.id,
    accountId: row.accountId,
    workspaceId: row.workspaceId,
    packId: row.packId,
    status: row.status as PackInstallationStatus,
    version: row.version,
    manifestSnapshot: row.manifestSnapshot
      ? (row.manifestSnapshot as unknown as CapabilityPack)
      : null,
    manifestDigest: row.manifestDigest,
    selectedRigId: row.selectedRigId,
    installedBySubjectId: row.installedBySubjectId,
    metadata: row.metadata,
    enabledAt: row.enabledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
