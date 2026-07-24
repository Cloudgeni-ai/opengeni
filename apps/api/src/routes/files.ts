import {
  CompleteFileUploadResponse,
  CreateFileUploadRequest,
  CreateFileUploadResponse,
  FileAsset,
  FileDownloadUrlResponse,
  RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
  RETAINED_OUTPUT_MAX_PAGE_BYTES,
  RetainedArtifactMetadataSchema,
  retainedArtifactReferenceFromFile,
  resolveRetainedOutputRange,
  type RetainedArtifactMetadata,
  type RetainedOutputUnavailableReason,
} from "@opengeni/contracts";
import {
  claimFileUploadCleanup,
  completeFileUploadCleanup,
  completeFileUpload,
  createFileUpload,
  getFileUpload,
  getRetainedFileArtifact,
  requireFile,
  type RetainedFileArtifact,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";

export function registerFileRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, objectStorage } = deps;

  app.post("/v1/workspaces/:workspaceId/files/uploads", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "files:upload");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const payload = CreateFileUploadRequest.parse(await c.req.json());
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "file:upload",
      quantity: payload.sizeBytes,
    });
    if (payload.sizeBytes > objectStorage.maxSinglePutSizeBytes) {
      throw new HTTPException(413, {
        message: `file exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
      });
    }
    const fileId = crypto.randomUUID();
    const safeFilename = sanitizeFilename(payload.filename);
    const objectKey = `workspaces/${workspaceId}/files/${fileId}/original/${safeFilename}`;
    const signed = await objectStorage.createPutUrl({
      key: objectKey,
      contentType: payload.contentType,
      ...(payload.sha256 ? { sha256: payload.sha256 } : {}),
    });
    const upload = await createFileUpload(db, {
      accountId: grant.accountId,
      workspaceId,
      fileId,
      filename: payload.filename,
      safeFilename,
      contentType: payload.contentType,
      sizeBytes: payload.sizeBytes,
      sha256: payload.sha256 ?? null,
      bucket: objectStorage.bucket,
      objectKey,
      expiresAt: signed.expiresAt,
    });
    return c.json(
      CreateFileUploadResponse.parse({
        fileId: upload.file.id,
        uploadId: upload.uploadId,
        putUrl: signed.url,
        requiredHeaders: signed.requiredHeaders,
        expiresAt: upload.expiresAt,
        maxSizeBytes: objectStorage.maxSinglePutSizeBytes,
      }),
      201,
    );
  });

  app.post("/v1/workspaces/:workspaceId/files/uploads/:uploadId/complete", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "files:upload");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const upload = await getFileUpload(db, workspaceId, c.req.param("uploadId"));
    if (!upload) {
      throw new HTTPException(404, { message: "file upload not found" });
    }
    const recordUploadedFileUsage = async (file: typeof upload.file): Promise<void> => {
      await recordWorkspaceUsage(deps, {
        accountId: grant.accountId,
        workspaceId,
        subjectId: grant.subjectId,
        eventType: "file.uploaded",
        quantity: file.sizeBytes,
        unit: "byte",
        sourceResourceType: "file",
        sourceResourceId: file.id,
        idempotencyKey: `file.uploaded:${workspaceId}:${file.id}`,
      });
    };
    const completeAndRecordUsage = async (): Promise<typeof upload.file> => {
      let file: typeof upload.file;
      try {
        file = await completeFileUpload(db, workspaceId, upload.id);
      } catch (error) {
        // HEAD runs outside the DB transaction. If the expiry reaper claims the
        // row in that window, report the durable state instead of leaking an
        // internal 500. A concurrent successful finalize remains a normal
        // idempotent completion and still repairs usage below.
        const current = await getFileUpload(db, workspaceId, upload.id);
        if (current?.status === "completed" && current.file.status === "ready") {
          file = current.file;
        } else if (current && current.status !== "pending") {
          throw new HTTPException(409, {
            message: `file upload is ${publicFileUploadStatus(current.status)}`,
          });
        } else {
          throw error;
        }
      }
      await recordUploadedFileUsage(file);
      return file;
    };
    const rejectAndCleanObject = async (
      status: 409 | 422,
      message: string,
      terminalStatus: "failed" | "expired",
    ): Promise<typeof upload.file> => {
      const claim = await claimFileUploadCleanup(db, {
        workspaceId,
        uploadId: upload.id,
        fileId: upload.file.id,
      });
      // A concurrent valid finalize may have committed while this request was
      // checking expiry/provider metadata. Never delete that ready object's
      // key; preserve normal idempotent finalize and repair usage instead.
      if (claim.outcome === "completed") {
        await recordUploadedFileUsage(claim.file);
        return claim.file;
      }
      if (claim.outcome === "unavailable") {
        throw new HTTPException(409, {
          message: `file upload is ${publicFileUploadStatus(claim.status)}`,
        });
      }
      try {
        await objectStorage.deleteObject(upload.file.objectKey);
      } catch (error) {
        // The row remains cleanup_pending and the file non-ready. The global
        // reaper can reclaim the idempotent delete after its claim timeout.
        deps.observability?.warn(
          "file upload rejection cleanup failed; claim remains reclaimable",
          {
            workspaceId,
            fileId: upload.file.id,
            uploadId: upload.id,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        throw new HTTPException(status, { message });
      }
      const settled = await completeFileUploadCleanup(db, {
        accountId: grant.accountId,
        workspaceId,
        uploadId: upload.id,
        fileId: upload.file.id,
        terminalStatus,
      });
      if (!settled) {
        throw new HTTPException(409, { message: "file upload cleanup claim was superseded" });
      }
      throw new HTTPException(status, { message });
    };
    // A client can lose the response after the server commits completion, or two
    // tabs can race the same completion request. A ready object is durable and
    // safe to return again. Re-enter the row-locked DB finalize and retry the
    // idempotent usage write before returning: the previous request may have
    // died after completion committed but before `file.uploaded` was recorded.
    if (upload.status === "completed" && upload.file.status === "ready") {
      const file = await completeAndRecordUsage();
      return c.json(CompleteFileUploadResponse.parse({ file }));
    }
    if (upload.status !== "pending") {
      throw new HTTPException(409, {
        message: `file upload is ${publicFileUploadStatus(upload.status)}`,
      });
    }
    if (upload.expiresAt.getTime() < Date.now()) {
      const file = await rejectAndCleanObject(409, "file upload has expired", "expired");
      return c.json(CompleteFileUploadResponse.parse({ file }));
    }
    const head = await objectStorage.headFile(upload.file).catch((error) => {
      throw new HTTPException(409, {
        message: `uploaded object is not available: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    if (Number(head.ContentLength ?? -1) !== upload.file.sizeBytes) {
      const file = await rejectAndCleanObject(
        422,
        "uploaded object size does not match file metadata",
        "failed",
      );
      return c.json(CompleteFileUploadResponse.parse({ file }));
    }
    if (
      upload.file.contentType &&
      head.ContentType &&
      head.ContentType !== upload.file.contentType
    ) {
      const file = await rejectAndCleanObject(
        422,
        "uploaded object content type does not match file metadata",
        "failed",
      );
      return c.json(CompleteFileUploadResponse.parse({ file }));
    }
    if (upload.file.sha256 && head.Metadata?.sha256 !== upload.file.sha256) {
      const file = await rejectAndCleanObject(
        422,
        "uploaded object checksum metadata does not match file metadata",
        "failed",
      );
      return c.json(CompleteFileUploadResponse.parse({ file }));
    }
    const file = await completeAndRecordUsage();
    return c.json(CompleteFileUploadResponse.parse({ file }));
  });

  app.get("/v1/workspaces/:workspaceId/files/:fileId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const file = await requireFile(db, workspaceId, c.req.param("fileId")).catch(() => null);
    if (!file) {
      throw new HTTPException(404, { message: "file not found" });
    }
    return c.json(FileAsset.parse(file));
  });

  app.get("/v1/workspaces/:workspaceId/artifacts/:artifactId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const artifactId = retainedArtifactId(c.req.param("artifactId"));
    const artifact = await getRetainedFileArtifact(db, workspaceId, artifactId);
    if (!artifact) {
      return c.json(retainedArtifactUnavailable(artifactId, "deleted"), 404);
    }
    return c.json(retainedArtifactMetadata(artifact));
  });

  app.get("/v1/workspaces/:workspaceId/artifacts/:artifactId/content", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    const artifactId = retainedArtifactId(c.req.param("artifactId"));
    const artifact = await getRetainedFileArtifact(db, workspaceId, artifactId);
    if (!artifact) {
      return c.json(retainedArtifactUnavailable(artifactId, "deleted"), 404);
    }

    const metadata = retainedArtifactMetadata(artifact);
    if (!metadata.available) {
      return c.json(metadata, retainedArtifactUnavailableStatus(metadata.reason));
    }
    if (!objectStorage) {
      return c.json(retainedArtifactUnavailable(artifactId, "missing_storage"), 503);
    }

    const rangeHeader = c.req.header("range");
    const range = resolveRetainedOutputRange(
      rangeHeader,
      metadata.originalBytes,
      rangeHeader ? RETAINED_OUTPUT_MAX_PAGE_BYTES : RETAINED_OUTPUT_DEFAULT_PAGE_BYTES,
    );
    if (range.kind === "invalid") {
      return c.json(
        {
          message: "invalid retained artifact byte range",
          reason: range.reason,
          maxRangeBytes: RETAINED_OUTPUT_MAX_PAGE_BYTES,
        },
        400,
      );
    }
    if (range.kind === "unsatisfiable") {
      return c.json(
        { message: "retained artifact byte range is not satisfiable", reason: range.reason },
        416,
        {
          "Accept-Ranges": "bytes",
          "Content-Range": range.contentRange,
          "Cache-Control": "private, no-store",
        },
      );
    }

    const headers = {
      "Accept-Ranges": range.acceptRanges,
      "Cache-Control": "private, no-store",
      "Content-Length": String(range.length),
      "Content-Type": metadata.contentType,
      "X-Content-Type-Options": "nosniff",
      ...(range.contentRange ? { "Content-Range": range.contentRange } : {}),
    };
    if (range.kind === "empty") {
      if (!(await objectStorage.fileExists(artifact.file))) {
        return c.json(retainedArtifactUnavailable(artifactId, "missing_storage"), 410);
      }
      return c.body(null, 200, headers);
    }

    const bytes = await objectStorage.getFileRange(artifact.file, {
      start: range.start,
      end: range.end,
    });
    if (!bytes) {
      return c.json(retainedArtifactUnavailable(artifactId, "missing_storage"), 410);
    }
    if (bytes.byteLength !== range.length) {
      throw new HTTPException(502, { message: "object storage returned an invalid byte range" });
    }
    return c.body(new Uint8Array(bytes), range.status, headers);
  });

  app.post("/v1/workspaces/:workspaceId/files/:fileId/download-url", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "files:read");
    if (!objectStorage) {
      throw new HTTPException(503, { message: "object storage is not configured" });
    }
    const file = await requireFile(db, workspaceId, c.req.param("fileId")).catch(() => null);
    if (!file) {
      throw new HTTPException(404, { message: "file not found" });
    }
    if (file.status !== "ready") {
      throw new HTTPException(409, { message: `file is ${file.status}` });
    }
    const signed = await objectStorage.createGetUrl({ key: file.objectKey });
    return c.json(
      FileDownloadUrlResponse.parse({
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
      }),
    );
  });
}

function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim().replace(/[/\\]/g, "_");
  const safe = trimmed
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return safe || "file";
}

/** Keep the cleanup lease internal; clients only consume terminal upload states. */
function publicFileUploadStatus(status: string): string {
  return status === "cleanup_pending" ? "failed" : status;
}

function retainedArtifactId(value: string): string {
  const parsed = FileAsset.shape.id.safeParse(value);
  if (!parsed.success) {
    throw new HTTPException(404, { message: "artifact not found" });
  }
  return parsed.data;
}

function retainedArtifactUnavailable(
  artifactId: string,
  reason: RetainedOutputUnavailableReason,
): RetainedArtifactMetadata {
  return RetainedArtifactMetadataSchema.parse({ available: false, artifactId, reason });
}

function retainedArtifactMetadata(artifact: RetainedFileArtifact): RetainedArtifactMetadata {
  const reference = retainedArtifactReferenceFromFile(artifact.file);
  if (reference) return reference;

  const { file, uploadStatus, uploadExpiresAt } = artifact;
  if (file.status === "deleted") {
    return retainedArtifactUnavailable(file.id, "deleted");
  }
  if (
    file.status === "expired" ||
    uploadStatus === "expired" ||
    (uploadStatus === "pending" &&
      uploadExpiresAt !== null &&
      uploadExpiresAt.getTime() < Date.now())
  ) {
    return retainedArtifactUnavailable(file.id, "expired");
  }
  if (file.status === "failed" || uploadStatus === "failed" || uploadStatus === "cleanup_pending") {
    return retainedArtifactUnavailable(file.id, "failed");
  }
  if (file.status === "pending_upload" || uploadStatus === "pending") {
    return retainedArtifactUnavailable(file.id, "pending");
  }
  return retainedArtifactUnavailable(file.id, "unsupported");
}

function retainedArtifactUnavailableStatus(
  reason: RetainedOutputUnavailableReason,
): 404 | 409 | 410 | 422 {
  switch (reason) {
    case "deleted":
      return 404;
    case "expired":
    case "missing_storage":
      return 410;
    case "unsupported":
    case "not_retained":
    case "storage_write_failed":
      return 422;
    case "pending":
    case "failed":
      return 409;
  }
}
