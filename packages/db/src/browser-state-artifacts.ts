import { randomUUID } from "node:crypto";
import {
  BrowserRevisionMaterialization,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type Database, rawRows, withRlsContext } from "./database";
import * as schema from "./schema";

type BrowserStateArtifactRow = typeof schema.browserStateArtifacts.$inferSelect;
type BrowserStateUploadRow = typeof schema.browserStateUploads.$inferSelect;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OBJECT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._=-]+$/u;

export type BrowserStateArtifactCommitInput = {
  kind: BrowserStateArtifactRow["kind"];
  format: string;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  objectKey: string;
  encryptedDataKey: string;
  sizeBytes: number;
  materialization: BrowserRevisionMaterializationValue;
};

export type BrowserStateArtifactCleanupClaim = {
  claimId: string;
  artifactId: string;
  accountId: string;
  workspaceId: string;
  objectKey: string;
};

export type BrowserStateUploadPurpose = BrowserStateUploadRow["purpose"];

export type BrowserStateUploadCleanupClaim = {
  claimId: string;
  uploadId: string;
  accountId: string;
  workspaceId: string;
  objectKey: string;
};

export class BrowserStateUploadStateError extends Error {
  readonly name = "BrowserStateUploadStateError";
}

export type BrowserStateUploadPreparationInput = {
  accountId: string;
  workspaceId: string;
  operationId: string;
  sourceBrowserSessionId: string;
  purpose: BrowserStateUploadPurpose;
  objectKey: string;
  cleanupAfter: Date;
};

/** Validate storage authority before it can become durable state. */
export function validateBrowserStateArtifactCommitInput(
  workspaceId: string,
  value: BrowserStateArtifactCommitInput,
): BrowserStateArtifactCommitInput {
  if (
    !SHA256_PATTERN.test(value.artifactDigest) ||
    !SHA256_PATTERN.test(value.contentDigest) ||
    !SHA256_PATTERN.test(value.manifestDigest) ||
    !validBrowserStateObjectKey(workspaceId, value.objectKey) ||
    value.format.trim() !== value.format ||
    Buffer.byteLength(value.format) < 1 ||
    Buffer.byteLength(value.format) > 512 ||
    Buffer.byteLength(value.encryptedDataKey) < 16 ||
    Buffer.byteLength(value.encryptedDataKey) > 8_192 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1
  ) {
    throw new Error("Browser state artifact metadata is invalid");
  }
  const materialization = BrowserRevisionMaterialization.parse(value.materialization);
  if (value.kind === "provider_snapshot" && materialization.portability !== "provider_bound") {
    throw new Error("Provider snapshots must declare their provider binding");
  }
  return { ...value, materialization };
}

/** Establish durable cleanup authority before a controller receives a PUT URL. */
export async function prepareBrowserStateUpload(
  db: Database,
  input: BrowserStateUploadPreparationInput,
): Promise<{ uploadId: string; state: BrowserStateUploadRow["state"] }> {
  return await withRlsContext(db, input, async (scopedDb) =>
    scopedDb.transaction(async (tx) =>
      prepareBrowserStateUploadInTransaction(tx as unknown as Database, input),
    ),
  );
}

/** Compose upload authority with operation dispatch in one transaction. */
export async function prepareBrowserStateUploadInTransaction(
  db: Database,
  input: BrowserStateUploadPreparationInput,
): Promise<{ uploadId: string; state: BrowserStateUploadRow["state"] }> {
  if (
    !validBrowserStateObjectKey(input.workspaceId, input.objectKey) ||
    !Number.isFinite(input.cleanupAfter.getTime()) ||
    input.cleanupAfter.getTime() <= Date.now()
  ) {
    throw new BrowserStateUploadStateError("Browser state upload authority is invalid");
  }
  const [operation] = await db
    .select({
      resourceKind: schema.interactionOperations.resourceKind,
      resourceId: schema.interactionOperations.resourceId,
      kind: schema.interactionOperations.kind,
      state: schema.interactionOperations.state,
    })
    .from(schema.interactionOperations)
    .where(
      and(
        eq(schema.interactionOperations.workspaceId, input.workspaceId),
        eq(schema.interactionOperations.operationId, input.operationId),
      ),
    )
    .for("update")
    .limit(1);
  const expectedKind = input.purpose === "revision_component" ? "publish" : "suspend";
  if (
    !operation ||
    operation.resourceKind !== "browser_session" ||
    operation.resourceId !== input.sourceBrowserSessionId ||
    operation.kind !== expectedKind ||
    (operation.state !== "prepared" && operation.state !== "dispatched")
  ) {
    throw new BrowserStateUploadStateError(
      "Browser state upload does not belong to an active capture operation",
    );
  }

  const [existing] = await db
    .select()
    .from(schema.browserStateUploads)
    .where(eq(schema.browserStateUploads.objectKey, input.objectKey))
    .limit(1);
  if (existing) {
    if (
      existing.accountId !== input.accountId ||
      existing.workspaceId !== input.workspaceId ||
      existing.operationId !== input.operationId ||
      existing.sourceBrowserSessionId !== input.sourceBrowserSessionId ||
      existing.purpose !== input.purpose ||
      existing.state !== "prepared"
    ) {
      throw new BrowserStateUploadStateError(
        "Browser state object key belongs to another upload authority",
      );
    }
    if (
      existing.state === "prepared" &&
      existing.cleanupAfter !== null &&
      existing.cleanupAfter < input.cleanupAfter
    ) {
      const [renewed] = await db
        .update(schema.browserStateUploads)
        .set({ cleanupAfter: input.cleanupAfter, updatedAt: new Date() })
        .where(
          and(
            eq(schema.browserStateUploads.workspaceId, input.workspaceId),
            eq(schema.browserStateUploads.id, existing.id),
            eq(schema.browserStateUploads.state, "prepared"),
          ),
        )
        .returning({ id: schema.browserStateUploads.id });
      if (!renewed) throw new Error("Browser state upload authority renewal was lost");
    }
    return { uploadId: existing.id, state: existing.state };
  }

  const [created] = await db
    .insert(schema.browserStateUploads)
    .values({
      id: randomUUID(),
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      sourceBrowserSessionId: input.sourceBrowserSessionId,
      purpose: input.purpose,
      objectKey: input.objectKey,
      cleanupAfter: input.cleanupAfter,
    })
    .returning({ id: schema.browserStateUploads.id, state: schema.browserStateUploads.state });
  if (!created) throw new Error("Browser state upload authority insert was lost");
  return { uploadId: created.id, state: created.state };
}

/** Queue every uncommitted object owned by a terminal capture operation. */
export async function markBrowserStateUploadsDeletePendingInTransaction(
  db: Database,
  input: { workspaceId: string; operationId: string },
): Promise<void> {
  const now = new Date();
  await db
    .update(schema.browserStateUploads)
    .set({ state: "delete_pending", cleanupAfter: now, updatedAt: now })
    .where(
      and(
        eq(schema.browserStateUploads.workspaceId, input.workspaceId),
        eq(schema.browserStateUploads.operationId, input.operationId),
        eq(schema.browserStateUploads.state, "prepared"),
      ),
    );
}

/** Atomically turn one pre-upload authority into the exact artifact root. */
export async function commitBrowserStateUploadInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    sourceBrowserSessionId: string;
    purpose: BrowserStateUploadPurpose;
    objectKey: string;
    artifactId: string;
  },
): Promise<void> {
  const [upload] = await db
    .select({ id: schema.browserStateUploads.id, state: schema.browserStateUploads.state })
    .from(schema.browserStateUploads)
    .where(
      and(
        eq(schema.browserStateUploads.workspaceId, input.workspaceId),
        eq(schema.browserStateUploads.operationId, input.operationId),
        eq(schema.browserStateUploads.sourceBrowserSessionId, input.sourceBrowserSessionId),
        eq(schema.browserStateUploads.purpose, input.purpose),
        eq(schema.browserStateUploads.objectKey, input.objectKey),
      ),
    )
    .for("update")
    .limit(1);
  if (!upload || upload.state !== "prepared") {
    throw new BrowserStateUploadStateError(
      "Browser state upload is not available for durable publication",
    );
  }
  const [committed] = await db
    .update(schema.browserStateUploads)
    .set({
      state: "committed",
      cleanupAfter: null,
      committedArtifactId: input.artifactId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.browserStateUploads.workspaceId, input.workspaceId),
        eq(schema.browserStateUploads.id, upload.id),
        eq(schema.browserStateUploads.state, "prepared"),
      ),
    )
    .returning({ id: schema.browserStateUploads.id });
  if (!committed) throw new Error("Browser state upload publication was lost");
}

/**
 * Claim a bounded cross-workspace batch of retired private checkpoints. The
 * privileged SQL function is the only FORCE-RLS bypass; stale claims are
 * reclaimable and published revision components are structurally ineligible.
 */
export async function claimBrowserStateArtifactCleanup(
  db: Database,
  input: { claimTimeoutMs: number; limit: number },
): Promise<BrowserStateArtifactCleanupClaim[]> {
  const rows = await rawRows<{
    claim_id: string;
    artifact_id: string;
    account_id: string;
    workspace_id: string;
    object_key: string;
  }>(
    db,
    sql`
      select claim_id, artifact_id, account_id, workspace_id, object_key
      from opengeni_private.claim_browser_state_artifact_cleanup(
        ${input.claimTimeoutMs},
        ${input.limit}
      )
    `,
  );
  return rows.map((row) => ({
    claimId: row.claim_id,
    artifactId: row.artifact_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
  }));
}

/**
 * Settle one exact claim only after its provider object was deleted. Completion
 * is idempotent after a lost response and erases the wrapped data key.
 */
export async function completeBrowserStateArtifactCleanup(
  db: Database,
  input: BrowserStateArtifactCleanupClaim,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [artifact] = await tx
          .select({
            state: schema.browserStateArtifacts.state,
            deleteClaimId: schema.browserStateArtifacts.deleteClaimId,
          })
          .from(schema.browserStateArtifacts)
          .where(
            and(
              eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
              eq(schema.browserStateArtifacts.id, input.artifactId),
              eq(schema.browserStateArtifacts.purpose, "private_checkpoint"),
              eq(schema.browserStateArtifacts.objectKey, input.objectKey),
            ),
          )
          .for("update")
          .limit(1);
        if (!artifact) return false;
        if (artifact.state === "deleted") return true;
        if (artifact.state !== "deleting" || artifact.deleteClaimId !== input.claimId) {
          return false;
        }
        const [settled] = await tx
          .update(schema.browserStateArtifacts)
          .set({
            state: "deleted",
            encryptedDataKey: null,
            deleteClaimId: null,
            deleteClaimedAt: null,
            deletedAt: new Date(),
          })
          .where(
            and(
              eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
              eq(schema.browserStateArtifacts.id, input.artifactId),
              eq(schema.browserStateArtifacts.state, "deleting"),
              eq(schema.browserStateArtifacts.deleteClaimId, input.claimId),
            ),
          )
          .returning({ id: schema.browserStateArtifacts.id });
        return settled !== undefined;
      }),
  );
}

/** Claim orphan/failed upload objects after their safety horizon. */
export async function claimBrowserStateUploadCleanup(
  db: Database,
  input: { claimTimeoutMs: number; limit: number },
): Promise<BrowserStateUploadCleanupClaim[]> {
  const rows = await rawRows<{
    claim_id: string;
    upload_id: string;
    account_id: string;
    workspace_id: string;
    object_key: string;
  }>(
    db,
    sql`
      select claim_id, upload_id, account_id, workspace_id, object_key
      from opengeni_private.claim_browser_state_upload_cleanup(
        ${input.claimTimeoutMs},
        ${input.limit}
      )
    `,
  );
  return rows.map((row) => ({
    claimId: row.claim_id,
    uploadId: row.upload_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
  }));
}

/** Tombstone one exact orphan upload after its provider object is absent. */
export async function completeBrowserStateUploadCleanup(
  db: Database,
  input: BrowserStateUploadCleanupClaim,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      scopedDb.transaction(async (tx) => {
        const [upload] = await tx
          .select({
            state: schema.browserStateUploads.state,
            deleteClaimId: schema.browserStateUploads.deleteClaimId,
          })
          .from(schema.browserStateUploads)
          .where(
            and(
              eq(schema.browserStateUploads.workspaceId, input.workspaceId),
              eq(schema.browserStateUploads.id, input.uploadId),
              eq(schema.browserStateUploads.objectKey, input.objectKey),
            ),
          )
          .for("update")
          .limit(1);
        if (!upload) return false;
        if (upload.state === "deleted") return true;
        if (upload.state !== "deleting" || upload.deleteClaimId !== input.claimId) return false;
        const [settled] = await tx
          .update(schema.browserStateUploads)
          .set({
            state: "deleted",
            deleteClaimId: null,
            deleteClaimedAt: null,
            deletedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.browserStateUploads.workspaceId, input.workspaceId),
              eq(schema.browserStateUploads.id, input.uploadId),
              eq(schema.browserStateUploads.state, "deleting"),
              eq(schema.browserStateUploads.deleteClaimId, input.claimId),
            ),
          )
          .returning({ id: schema.browserStateUploads.id });
        return settled !== undefined;
      }),
  );
}

function validBrowserStateObjectKey(workspaceId: string, objectKey: string): boolean {
  const prefix = `workspaces/${workspaceId}/browser-state/`;
  if (!objectKey.startsWith(prefix) || Buffer.byteLength(objectKey) > 2_048) return false;
  const suffix = objectKey.slice(prefix.length);
  return (
    suffix.length > 0 &&
    suffix
      .split("/")
      .every(
        (segment) =>
          OBJECT_KEY_SEGMENT_PATTERN.test(segment) && segment !== "." && segment !== "..",
      )
  );
}
