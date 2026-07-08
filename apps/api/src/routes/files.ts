import {
  CompleteFileUploadResponse,
  CreateFileUploadRequest,
  CreateFileUploadResponse,
  FileAsset,
  FileDownloadUrlResponse,
} from "@opengeni/contracts";
import {
  completeFileUpload,
  createFileUpload,
  getFileUpload,
  markFileUploadFailed,
  requireFile,
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
    if (upload.status !== "pending") {
      throw new HTTPException(409, { message: `file upload is ${upload.status}` });
    }
    if (upload.expiresAt.getTime() < Date.now()) {
      await markFileUploadFailed(db, workspaceId, upload.id, upload.file.id);
      throw new HTTPException(409, { message: "file upload has expired" });
    }
    const head = await objectStorage.headFile(upload.file).catch((error) => {
      throw new HTTPException(409, {
        message: `uploaded object is not available: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    if (Number(head.ContentLength ?? -1) !== upload.file.sizeBytes) {
      await markFileUploadFailed(db, workspaceId, upload.id, upload.file.id);
      throw new HTTPException(422, {
        message: "uploaded object size does not match file metadata",
      });
    }
    if (
      upload.file.contentType &&
      head.ContentType &&
      head.ContentType !== upload.file.contentType
    ) {
      await markFileUploadFailed(db, workspaceId, upload.id, upload.file.id);
      throw new HTTPException(422, {
        message: "uploaded object content type does not match file metadata",
      });
    }
    if (upload.file.sha256 && head.Metadata?.sha256 !== upload.file.sha256) {
      await markFileUploadFailed(db, workspaceId, upload.id, upload.file.id);
      throw new HTTPException(422, {
        message: "uploaded object checksum metadata does not match file metadata",
      });
    }
    const file = await completeFileUpload(db, workspaceId, upload.id);
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
