import { createHash } from "node:crypto";
import {
  BrowserDownload,
  BrowserDownloadSaveRequest,
  BrowserDownloadSaveResponse,
  type BrowserDownload as BrowserDownloadValue,
  type BrowserDownloadSaveRequest as BrowserDownloadSaveRequestValue,
  type BrowserDownloadSaveResponse as BrowserDownloadSaveResponseValue,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import {
  type Database,
  withoutSessionRlsActor,
  withRlsContext,
  withWorkspaceRls,
} from "./database";
import {
  InteractionResourceConflictError,
  InteractionResourceNotFoundError,
  InteractionResourceStateError,
} from "./browser-auth";
import * as schema from "./schema";

type OperationRow = typeof schema.interactionResourceOperations.$inferSelect;

type SaveMetadata = {
  browserSessionId: string;
  controllerGeneration: string;
  sourceSessionId: string;
  destinationPath: string;
  overwrite: boolean;
  fileId: string;
  uploadId: string;
  objectKey: string;
  safeFilename: string;
  contentType: string;
  download: BrowserDownloadValue;
};

export type BrowserDownloadSavePreparation = SaveMetadata & {
  operationId: string;
  state: OperationRow["state"];
  errorCode: string | null;
  replayed: boolean;
  dispatchedNow: boolean;
  response: BrowserDownloadSaveResponseValue | null;
};

type SaveIdentity = {
  accountId: string;
  workspaceId: string;
  actorSubjectId: string;
  browserSessionId: string;
  downloadId: string;
  request: BrowserDownloadSaveRequestValue;
};

export async function findBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSavePreparation | null> {
  const input = parseIdentity(inputValue);
  return await withWorkspaceRls(db, input.workspaceId, async (scopedDb) => {
    const [operation] = await scopedDb
      .select()
      .from(schema.interactionResourceOperations)
      .where(
        and(
          eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
          eq(schema.interactionResourceOperations.operationId, input.request.operationId),
        ),
      )
      .limit(1);
    if (!operation) return null;
    return preparation(operation, input, true);
  });
}

export async function prepareBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity & {
    sourceSessionId: string;
    download: BrowserDownloadValue;
    fileId: string;
    safeFilename: string;
    contentType: string;
    bucket: string;
    objectKey: string;
    uploadExpiresAt: Date;
    /** The download was retained as this workspace file before its browser's
     * controller went away: the save reuses it instead of a new upload, and
     * does not need the browser to be running. */
    retained?: { fileId: string; uploadId: string };
  },
): Promise<BrowserDownloadSavePreparation> {
  const input = parseIdentity(inputValue);
  const download = BrowserDownload.parse(inputValue.download);
  if (
    download.id !== input.downloadId ||
    download.browserSessionId !== input.browserSessionId ||
    download.status !== "completed" ||
    !download.sha256
  ) {
    throw new InteractionResourceStateError("Browser download is not ready to save");
  }
  const sourceSessionId = requireUuid(inputValue.sourceSessionId, "sourceSessionId");
  const fileId = requireUuid(inputValue.fileId, "fileId");
  const safeFilename = requireBoundedString(inputValue.safeFilename, "safeFilename", 4_096);
  const contentType = requireBoundedString(inputValue.contentType, "contentType", 512);
  const bucket = requireBoundedString(inputValue.bucket, "bucket", 1_024);
  const objectKey = requireBoundedString(inputValue.objectKey, "objectKey", 2_048);
  const expectedObjectKey = `workspaces/${input.workspaceId}/files/${fileId}/original/${safeFilename}`;
  if (objectKey !== expectedObjectKey) {
    throw new InteractionResourceConflictError("Browser download object key is not canonical");
  }
  if (!Number.isFinite(inputValue.uploadExpiresAt.valueOf())) {
    throw new InteractionResourceStateError("Browser download upload expiry is invalid");
  }

  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const [existing] = await tx
          .select()
          .from(schema.interactionResourceOperations)
          .where(
            and(
              eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
              eq(schema.interactionResourceOperations.operationId, input.request.operationId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing) {
          const replay = preparation(existing, input, true);
          if (replay.state === "prepared" || replay.state === "dispatched") {
            await tx
              .update(schema.fileUploads)
              .set({ expiresAt: inputValue.uploadExpiresAt, updatedAt: sql`now()` })
              .where(
                and(
                  eq(schema.fileUploads.workspaceId, input.workspaceId),
                  eq(schema.fileUploads.id, replay.uploadId),
                  eq(schema.fileUploads.status, "pending"),
                ),
              );
          }
          return { ...replay, dispatchedNow: false };
        }

        const [session] = await tx
          .select({
            lifecycle: schema.browserSessions.lifecycle,
            controllerGeneration: schema.browserSessions.controllerGeneration,
          })
          .from(schema.browserSessions)
          .where(
            and(
              eq(schema.browserSessions.accountId, input.accountId),
              eq(schema.browserSessions.workspaceId, input.workspaceId),
              eq(schema.browserSessions.id, input.browserSessionId),
            ),
          )
          .limit(1);
        if (!session) throw new InteractionResourceNotFoundError("BrowserSession not found");
        const retained = inputValue.retained
          ? await requireRetainedDownload(tx, input, inputValue.retained, download)
          : null;
        if (
          !retained &&
          (session.lifecycle !== "active" ||
            session.controllerGeneration !== download.controllerGeneration)
        ) {
          throw new InteractionResourceStateError(
            "Browser download controller is no longer active",
          );
        }
        const [association] = await tx
          .select({ id: schema.browserSessionAssociations.id })
          .from(schema.browserSessionAssociations)
          .where(
            and(
              eq(schema.browserSessionAssociations.workspaceId, input.workspaceId),
              eq(schema.browserSessionAssociations.browserSessionId, input.browserSessionId),
              eq(schema.browserSessionAssociations.sessionId, sourceSessionId),
              eq(schema.browserSessionAssociations.relationship, "created"),
            ),
          )
          .limit(1);
        if (!association) {
          throw new InteractionResourceConflictError(
            "Browser download source session lost its creation binding",
          );
        }

        let upload: { id: string } | undefined = retained ? { id: retained.uploadId } : undefined;
        if (!retained) {
          await tx.insert(schema.files).values({
            id: fileId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            status: "pending_upload",
            filename: download.filename,
            safeFilename,
            contentType,
            sizeBytes: download.receivedBytes,
            sha256: download.sha256,
            bucket,
            objectKey,
            sourceSessionId,
            sourceSessionOwnerSubjectId: sql`(SELECT file_source_owner_snapshot_0913(
                CASE WHEN source.visibility = 'user_private' THEN coalesce(source.owner_subject_id,'') END,
                CASE WHEN source.site_access_root_id IS NOT NULL THEN coalesce(source.site_owner_subject_id,'') END,
                CASE WHEN slack.id IS NOT NULL THEN coalesce(slack.owning_subject_id,'') END,
                CASE WHEN source.memory_scope = 'user' THEN coalesce(source.scope_subject_id,'') END)
              FROM sessions source LEFT JOIN slack_interactions slack
                ON slack.account_id = source.account_id AND slack.workspace_id = source.workspace_id
                AND slack.session_reservation_id = source.root_session_id AND slack.visibility = 'private'
              WHERE source.account_id = ${input.accountId}::uuid
                AND source.workspace_id = ${input.workspaceId}::uuid AND source.id = ${sourceSessionId}::uuid)`,
            sourceSessionSharedUnrestricted: sql`coalesce((SELECT source.visibility = 'workspace_shared'
                AND source.memory_scope <> 'user'
                AND source.site_access_root_id IS NULL AND slack.id IS NULL
              FROM sessions source LEFT JOIN slack_interactions slack
                ON slack.account_id = source.account_id AND slack.workspace_id = source.workspace_id
                AND slack.session_reservation_id = source.root_session_id AND slack.visibility = 'private'
              WHERE source.account_id = ${input.accountId}::uuid
                AND source.workspace_id = ${input.workspaceId}::uuid AND source.id = ${sourceSessionId}::uuid), false)`,
          });
          [upload] = await tx
            .insert(schema.fileUploads)
            .values({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              fileId,
              status: "pending",
              expiresAt: inputValue.uploadExpiresAt,
            })
            .returning({ id: schema.fileUploads.id });
        }
        if (!upload) throw new Error("Browser download upload insert returned no row");
        const metadata: SaveMetadata = {
          browserSessionId: input.browserSessionId,
          controllerGeneration: download.controllerGeneration,
          sourceSessionId,
          destinationPath: input.request.destinationPath,
          overwrite: input.request.overwrite,
          fileId,
          uploadId: upload.id,
          objectKey,
          safeFilename,
          contentType,
          download,
        };
        const [operation] = await tx
          .insert(schema.interactionResourceOperations)
          .values({
            operationId: input.request.operationId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            resourceKind: "browser_download",
            resourceId: input.downloadId,
            kind: "save",
            requestDigest: requestDigest(input),
            metadata,
            state: "prepared",
            actorSubjectId: input.actorSubjectId,
          })
          .returning();
        if (!operation) throw new Error("Browser download save insert returned no row");
        return { ...preparation(operation, input, false), dispatchedNow: false };
      }),
  );
}

/** A completed download kept as a workspace file after its browser's
 * working directory went away (suspension removes it). */
export type RetainedBrowserDownload = {
  download: BrowserDownloadValue;
  fileId: string;
  uploadId: string;
  objectKey: string;
  safeFilename: string;
  contentType: string;
};

type RetainedScope = { accountId: string; workspaceId: string; browserSessionId: string };

/** The browser's chat lost its creation binding, or its private chat has no owner. */
export class BrowserDownloadOwnerUnavailableError extends Error {}

/**
 * Whose private files a browser's kept downloads are: the owner of the chat
 * that created the browser when that chat is private, else null (workspace
 * files). Read with system authority, because the request saving the browser
 * (a capacity save) may not see another person's private chat; the read is
 * bound to the browser's own creating chat and only decides file ownership.
 */
export async function getBrowserDownloadPrivateOwner(
  db: Database,
  input: RetainedScope & { sourceSessionId: string },
): Promise<string | null> {
  const [row] = await withoutSessionRlsActor(
    async () =>
      await withRlsContext(
        db,
        { accountId: input.accountId, workspaceId: input.workspaceId },
        async (scopedDb) =>
          await scopedDb
            .select({
              visibility: schema.sessions.visibility,
              ownerSubjectId: schema.sessions.ownerSubjectId,
            })
            .from(schema.browserSessionAssociations)
            .innerJoin(
              schema.sessions,
              and(
                eq(schema.sessions.workspaceId, schema.browserSessionAssociations.workspaceId),
                eq(schema.sessions.id, schema.browserSessionAssociations.sessionId),
              ),
            )
            .where(
              and(
                eq(schema.browserSessionAssociations.workspaceId, input.workspaceId),
                eq(schema.browserSessionAssociations.browserSessionId, input.browserSessionId),
                eq(schema.browserSessionAssociations.sessionId, input.sourceSessionId),
                eq(schema.browserSessionAssociations.relationship, "created"),
              ),
            )
            .limit(1),
      ),
  );
  if (!row) throw new BrowserDownloadOwnerUnavailableError("the browser's chat is unavailable");
  if (row.visibility !== "user_private") return null;
  if (!row.ownerSubjectId?.trim()) {
    throw new BrowserDownloadOwnerUnavailableError("the browser's private chat has no owner");
  }
  return row.ownerSubjectId;
}

/** Record that a completed download is retained as a ready workspace file.
 * Idempotent per download: the first retained file wins. */
export async function recordRetainedBrowserDownload(
  db: Database,
  input: RetainedScope & { download: BrowserDownloadValue; fileId: string; uploadId: string },
): Promise<RetainedBrowserDownload> {
  const download = BrowserDownload.parse(input.download);
  if (
    download.browserSessionId !== input.browserSessionId ||
    download.status !== "completed" ||
    !download.sha256
  ) {
    throw new InteractionResourceStateError("Only a completed download can be retained");
  }
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await tx
          .insert(schema.browserSessionRetainedDownloads)
          .values({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            browserSessionId: input.browserSessionId,
            downloadId: download.id,
            download,
            fileId: requireUuid(input.fileId, "fileId"),
            uploadId: requireUuid(input.uploadId, "uploadId"),
          })
          .onConflictDoNothing();
        const retained = await readRetainedDownloads(tx, input, download.id);
        if (!retained[0]) throw new Error("Retained browser download insert returned no row");
        return retained[0];
      }),
  );
}

/** Every download of a browser kept as a ready workspace file, oldest first. */
export async function listRetainedBrowserDownloads(
  db: Database,
  input: RetainedScope,
): Promise<RetainedBrowserDownload[]> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) => await readRetainedDownloads(scopedDb, input, null),
  );
}

export async function getRetainedBrowserDownload(
  db: Database,
  input: RetainedScope & { downloadId: string },
): Promise<RetainedBrowserDownload | null> {
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      (
        await readRetainedDownloads(scopedDb, input, requireUuid(input.downloadId, "downloadId"))
      )[0] ?? null,
  );
}

async function readRetainedDownloads(
  tx: Pick<Database, "select">,
  input: RetainedScope,
  downloadId: string | null,
): Promise<RetainedBrowserDownload[]> {
  const rows = await tx
    .select({
      download: schema.browserSessionRetainedDownloads.download,
      fileId: schema.browserSessionRetainedDownloads.fileId,
      uploadId: schema.browserSessionRetainedDownloads.uploadId,
      objectKey: schema.files.objectKey,
      safeFilename: schema.files.safeFilename,
      contentType: schema.files.contentType,
      fileStatus: schema.files.status,
    })
    .from(schema.browserSessionRetainedDownloads)
    .innerJoin(
      schema.files,
      and(
        eq(schema.files.accountId, schema.browserSessionRetainedDownloads.accountId),
        eq(schema.files.workspaceId, schema.browserSessionRetainedDownloads.workspaceId),
        eq(schema.files.id, schema.browserSessionRetainedDownloads.fileId),
      ),
    )
    .where(
      and(
        eq(schema.browserSessionRetainedDownloads.accountId, input.accountId),
        eq(schema.browserSessionRetainedDownloads.workspaceId, input.workspaceId),
        eq(schema.browserSessionRetainedDownloads.browserSessionId, input.browserSessionId),
        ...(downloadId ? [eq(schema.browserSessionRetainedDownloads.downloadId, downloadId)] : []),
      ),
    )
    .orderBy(
      schema.browserSessionRetainedDownloads.createdAt,
      schema.browserSessionRetainedDownloads.downloadId,
    );
  return rows
    .filter((row) => row.fileStatus === "ready")
    .map((row) => ({
      download: BrowserDownload.parse(row.download),
      fileId: row.fileId,
      uploadId: row.uploadId,
      objectKey: row.objectKey,
      safeFilename: row.safeFilename,
      contentType: row.contentType,
    }));
}

async function requireRetainedDownload(
  tx: Pick<Database, "select">,
  input: SaveIdentity,
  retained: { fileId: string; uploadId: string },
  download: BrowserDownloadValue,
): Promise<RetainedBrowserDownload> {
  const [current] = await readRetainedDownloads(tx, input, input.downloadId);
  if (
    !current ||
    current.fileId !== retained.fileId ||
    current.uploadId !== retained.uploadId ||
    current.download.sha256 !== download.sha256 ||
    current.download.receivedBytes !== download.receivedBytes
  ) {
    throw new InteractionResourceStateError("Browser download is no longer retained");
  }
  return current;
}

export async function dispatchBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSavePreparation> {
  const input = parseIdentity(inputValue);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
        const current = preparation(operation, input, true);
        if (current.state === "prepared") {
          const [updated] = await tx
            .update(schema.interactionResourceOperations)
            .set({ state: "dispatched" })
            .where(
              and(
                eq(schema.interactionResourceOperations.operationId, input.request.operationId),
                eq(schema.interactionResourceOperations.state, "prepared"),
              ),
            )
            .returning();
          if (!updated) throw new InteractionResourceConflictError("Save dispatch lost its fence");
          return { ...preparation(updated, input, current.replayed), dispatchedNow: true };
        }
        return { ...current, dispatchedNow: false };
      }),
  );
}

export async function completeBrowserDownloadSave(
  db: Database,
  inputValue: SaveIdentity,
): Promise<BrowserDownloadSaveResponseValue> {
  const input = parseIdentity(inputValue);
  return await withRlsContext(
    db,
    input,
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        await lockOperation(tx, input.request.operationId);
        const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
        const current = preparation(operation, input, true);
        if (current.response) return { ...current.response, replayed: true };
        if (current.state !== "dispatched") {
          throw terminalStateError(current);
        }
        const response = BrowserDownloadSaveResponse.parse({
          download: current.download,
          destinationPath: current.destinationPath,
          fileId: current.fileId,
          operationId: input.request.operationId,
          replayed: false,
        });
        const [completed] = await tx
          .update(schema.interactionResourceOperations)
          .set({
            state: "completed",
            resultVersion: current.download.version,
            result: response,
            settledAt: sql`now()`,
          })
          .where(
            and(
              eq(schema.interactionResourceOperations.operationId, input.request.operationId),
              eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
              eq(schema.interactionResourceOperations.state, "dispatched"),
            ),
          )
          .returning({ operationId: schema.interactionResourceOperations.operationId });
        if (!completed)
          throw new InteractionResourceConflictError("Save completion lost its fence");
        return response;
      }),
  );
}

export async function settleBrowserDownloadSaveFailure(
  db: Database,
  inputValue: SaveIdentity & {
    state: "failed" | "outcome_unknown";
    errorCode: string;
  },
): Promise<void> {
  const input = parseIdentity(inputValue);
  const errorCode = requireBoundedString(inputValue.errorCode, "errorCode", 512);
  await withRlsContext(db, input, async (scopedDb) => {
    await scopedDb.transaction(async (tx) => {
      await lockOperation(tx, input.request.operationId);
      const operation = await requireOperation(tx, input.workspaceId, input.request.operationId);
      const current = preparation(operation, input, true);
      if (
        current.state === "completed" ||
        current.state === "failed" ||
        current.state === "outcome_unknown"
      ) {
        return;
      }
      const [settled] = await tx
        .update(schema.interactionResourceOperations)
        .set({ state: inputValue.state, errorCode, settledAt: sql`now()` })
        .where(
          and(
            eq(schema.interactionResourceOperations.operationId, input.request.operationId),
            eq(schema.interactionResourceOperations.workspaceId, input.workspaceId),
            sql`${schema.interactionResourceOperations.state} in ('prepared', 'dispatched')`,
          ),
        )
        .returning({ operationId: schema.interactionResourceOperations.operationId });
      if (!settled) throw new InteractionResourceConflictError("Save failure lost its fence");
    });
  });
}

function parseIdentity(input: SaveIdentity): SaveIdentity {
  const request = BrowserDownloadSaveRequest.parse(input.request);
  return {
    accountId: requireUuid(input.accountId, "accountId"),
    workspaceId: requireUuid(input.workspaceId, "workspaceId"),
    actorSubjectId: requireBoundedString(input.actorSubjectId, "actorSubjectId", 1_024),
    browserSessionId: requireUuid(input.browserSessionId, "browserSessionId"),
    downloadId: requireUuid(input.downloadId, "downloadId"),
    request,
  };
}

function requestDigest(input: SaveIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        browserSessionId: input.browserSessionId,
        destinationPath: input.request.destinationPath,
        downloadId: input.downloadId,
        overwrite: input.request.overwrite,
      }),
    )
    .digest("hex");
}

function preparation(
  operation: OperationRow,
  input: SaveIdentity,
  replayed: boolean,
): BrowserDownloadSavePreparation {
  if (
    operation.accountId !== input.accountId ||
    operation.workspaceId !== input.workspaceId ||
    operation.resourceKind !== "browser_download" ||
    operation.resourceId !== input.downloadId ||
    operation.kind !== "save" ||
    operation.requestDigest !== requestDigest(input) ||
    operation.actorSubjectId !== input.actorSubjectId
  ) {
    throw new InteractionResourceConflictError(
      "Operation id is already bound to another browser download save",
    );
  }
  const metadata = saveMetadata(operation.metadata);
  if (
    metadata.browserSessionId !== input.browserSessionId ||
    metadata.download.id !== input.downloadId
  ) {
    throw new InteractionResourceConflictError("Browser download save metadata lost its binding");
  }
  let response: BrowserDownloadSaveResponseValue | null = null;
  if (operation.state === "completed") {
    response = BrowserDownloadSaveResponse.parse(operation.result);
    if (
      response.operationId !== operation.operationId ||
      response.download.id !== input.downloadId ||
      response.fileId !== metadata.fileId ||
      response.destinationPath !== metadata.destinationPath
    ) {
      throw new InteractionResourceStateError("Browser download save result is corrupted");
    }
    response = { ...response, replayed: true };
  }
  return {
    ...metadata,
    operationId: operation.operationId,
    state: operation.state,
    errorCode: operation.errorCode,
    replayed,
    dispatchedNow: false,
    response,
  };
}

function saveMetadata(value: unknown): SaveMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InteractionResourceStateError("Browser download save metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  return {
    browserSessionId: requireUuid(record.browserSessionId, "metadata.browserSessionId"),
    controllerGeneration: requireBoundedString(
      record.controllerGeneration,
      "metadata.controllerGeneration",
      256,
    ),
    sourceSessionId: requireUuid(record.sourceSessionId, "metadata.sourceSessionId"),
    destinationPath: BrowserDownloadSaveRequest.shape.destinationPath.parse(record.destinationPath),
    overwrite: requireBoolean(record.overwrite, "metadata.overwrite"),
    fileId: requireUuid(record.fileId, "metadata.fileId"),
    uploadId: requireUuid(record.uploadId, "metadata.uploadId"),
    objectKey: requireBoundedString(record.objectKey, "metadata.objectKey", 2_048),
    safeFilename: requireBoundedString(record.safeFilename, "metadata.safeFilename", 4_096),
    contentType: requireBoundedString(record.contentType, "metadata.contentType", 512),
    download: BrowserDownload.parse(record.download),
  };
}

async function lockOperation(db: Database, operationId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`browser-download-save:${operationId}`}, 0))`,
  );
}

async function requireOperation(
  db: Database,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow> {
  const [operation] = await db
    .select()
    .from(schema.interactionResourceOperations)
    .where(
      and(
        eq(schema.interactionResourceOperations.workspaceId, workspaceId),
        eq(schema.interactionResourceOperations.operationId, operationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!operation) throw new InteractionResourceNotFoundError("Browser download save not found");
  return operation;
}

function terminalStateError(
  prepared: BrowserDownloadSavePreparation,
): InteractionResourceStateError {
  return new InteractionResourceStateError(
    `Browser download save is ${prepared.state.replace("_", " ")}${prepared.errorCode ? ` (${prepared.errorCode})` : ""}`,
  );
}

function requireUuid(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new InteractionResourceStateError(`${label} is invalid`);
  }
  return value;
}

function requireBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value) > maxBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InteractionResourceStateError(`${label} is invalid`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new InteractionResourceStateError(`${label} is invalid`);
  return value;
}
