import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  SANDBOX_FILE_ARTIFACT_MAX_BYTES,
  SandboxFileArtifactReceipt,
  retainedArtifactReferenceFromFile,
  type AccessGrant,
  type Session,
} from "@opengeni/contracts";
import { recordWorkspaceUsage, requireLimit, type ApiRouteDeps } from "@opengeni/core";
import { completeFileUpload, getFile, prepareGeneratedWorkspaceFile } from "@opengeni/db";
import type { ObjectHead } from "@opengeni/storage";
import { HTTPException } from "hono/http-exception";

import { withChannelARead } from "./sandbox/channel-a";
import { sanitizeFilename } from "./routes/files";

const FILE_READ_SENTINEL_BYTES = 1;
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;

export async function publishSandboxFileArtifact(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    session: Session;
    path: string;
    signal?: AbortSignal | undefined;
  },
): Promise<SandboxFileArtifactReceipt> {
  if (!deps.settings.sandboxOwnershipEnabled) {
    throw new HTTPException(404, {
      message: "sandbox ownership is not enabled for this deployment",
    });
  }
  const storage = deps.objectStorage;
  if (!storage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }

  const path = sandboxArtifactRelativePath(input.path);
  const maxArtifactBytes = Math.min(SANDBOX_FILE_ARTIFACT_MAX_BYTES, storage.maxSinglePutSizeBytes);
  if (maxArtifactBytes < 1) {
    throw new HTTPException(503, { message: "object storage cannot accept artifact files" });
  }
  const readLimit = Math.min(25 * 1024 * 1024, maxArtifactBytes + FILE_READ_SENTINEL_BYTES);
  const read = await withChannelARead(
    {
      db: deps.db,
      settings: deps.settings,
      bus: deps.bus,
      ...(deps.observability ? { observability: deps.observability } : {}),
    },
    {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      session: input.session,
      subjectId: input.grant.subjectId,
      ...(input.signal ? { waitSignal: input.signal } : {}),
      operation: "artifact.publish",
    },
    ({ service }) => service.fsRead({ path, encoding: "base64", maxBytes: readLimit }),
  );
  if (read.truncated || read.sizeBytes > maxArtifactBytes) {
    throw new HTTPException(413, {
      message: `sandbox file exceeds the ${maxArtifactBytes}-byte artifact publication limit`,
    });
  }
  if (read.sizeBytes === 0) {
    throw new HTTPException(422, { message: "sandbox artifact file is empty" });
  }
  if (read.encoding !== "base64") {
    throw new HTTPException(502, { message: "sandbox returned an invalid binary file response" });
  }
  const bytes = Buffer.from(read.content, "base64");
  if (bytes.byteLength !== read.sizeBytes) {
    throw new HTTPException(502, { message: "sandbox returned an invalid file length" });
  }

  const filename = posix.basename(path);
  if (filename.length > 1_024) {
    throw new HTTPException(422, { message: "sandbox artifact filename is too long" });
  }
  const safeFilename = sanitizeFilename(filename);
  const contentType = sandboxFileContentType(filename);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const identity = sandboxArtifactIdentity({
    workspaceId: input.grant.workspaceId,
    sessionId: input.session.id,
    path,
    sha256,
  });
  const objectKey = `workspaces/${input.grant.workspaceId}/files/${identity.fileId}/sandbox/${safeFilename}`;
  const existing = await getFile(deps.db, input.grant.workspaceId, identity.fileId);
  let file = existing;

  if (!file) {
    await requireLimit(deps, {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      action: "file:upload",
      quantity: bytes.byteLength,
    });
    const prepared = await prepareGeneratedWorkspaceFile(deps.db, {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      fileId: identity.fileId,
      uploadId: identity.uploadId,
      filename,
      safeFilename,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256,
      bucket: storage.bucket,
      objectKey,
      expiresAt: new Date(Date.now() + UPLOAD_INTENT_TTL_MS),
    });
    file = prepared.file;
  }

  assertSandboxArtifactFile(file, {
    filename,
    safeFilename,
    contentType,
    sizeBytes: bytes.byteLength,
    sha256,
    objectKey,
  });
  if (file.status !== "ready") {
    const exists = await storage.fileExists(file);
    if (exists) {
      assertStoredSandboxArtifact(await storage.headFile(file), file);
    } else {
      await storage.putObject({
        key: file.objectKey,
        contentType: file.contentType,
        body: bytes,
        sha256,
      });
      assertStoredSandboxArtifact(await storage.headFile(file), file);
    }
    file = await completeFileUpload(deps.db, input.grant.workspaceId, identity.uploadId);
  } else {
    assertStoredSandboxArtifact(await storage.headFile(file), file);
  }

  await recordWorkspaceUsage(deps, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    subjectId: input.grant.subjectId,
    eventType: "file.uploaded",
    quantity: file.sizeBytes,
    unit: "byte",
    sourceResourceType: "file",
    sourceResourceId: file.id,
    idempotencyKey: `file.uploaded:${input.grant.workspaceId}:${file.id}`,
  });

  const artifact = retainedArtifactReferenceFromFile(file, "file");
  if (!artifact) {
    throw new HTTPException(502, { message: "published sandbox artifact is not ready" });
  }
  return SandboxFileArtifactReceipt.parse({
    type: "sandbox_file",
    sandboxPath: `/workspace/${path}`,
    filename,
    artifact,
  });
}

export function sandboxArtifactRelativePath(value: string): string {
  let path = value.trim();
  if (path.startsWith("sandbox:")) {
    path = path.slice("sandbox:".length);
  }
  if (path === "/workspace" || path === "/workspace/") {
    throw new HTTPException(400, { message: "sandbox artifact path must name a file" });
  }
  if (path.startsWith("/workspace/")) {
    path = path.slice("/workspace/".length);
  } else if (path.startsWith("/")) {
    throw new HTTPException(400, {
      message: "sandbox artifact path must be inside /workspace",
    });
  }
  if (!path) {
    throw new HTTPException(400, { message: "sandbox artifact path must name a file" });
  }
  if (path.includes("\0")) {
    throw new HTTPException(400, { message: "sandbox artifact path is invalid" });
  }
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new HTTPException(400, {
      message: "sandbox artifact path must be inside /workspace",
    });
  }
  return normalized;
}

export function sandboxFileContentType(filename: string): string {
  const extension = posix.extname(filename).toLowerCase();
  return (
    {
      ".csv": "text/csv",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".gz": "application/gzip",
      ".html": "text/html",
      ".htm": "text/html",
      ".jpeg": "image/jpeg",
      ".jpg": "image/jpeg",
      ".json": "application/json",
      ".md": "text/markdown",
      ".pdf": "application/pdf",
      ".png": "image/png",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".tar": "application/x-tar",
      ".txt": "text/plain",
      ".webp": "image/webp",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".zip": "application/zip",
    }[extension] ?? "application/octet-stream"
  );
}

function sandboxArtifactIdentity(input: {
  workspaceId: string;
  sessionId: string;
  path: string;
  sha256: string;
}): { fileId: string; uploadId: string } {
  const digest = createHash("sha256")
    .update("opengeni-sandbox-file-artifact-v1\0")
    .update(input.workspaceId)
    .update("\0")
    .update(input.sessionId)
    .update("\0")
    .update(input.path)
    .update("\0")
    .update(input.sha256)
    .digest("hex");
  return {
    fileId: uuidFromDigest(digest, 0),
    uploadId: uuidFromDigest(digest, 16),
  };
}

function uuidFromDigest(digest: string, startByte: number): string {
  const bytes = Buffer.from(digest, "hex").subarray(startByte, startByte + 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertSandboxArtifactFile(
  file: NonNullable<Awaited<ReturnType<typeof getFile>>>,
  expected: {
    filename: string;
    safeFilename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    objectKey: string;
  },
): void {
  if (
    !["pending_upload", "ready"].includes(file.status) ||
    file.filename !== expected.filename ||
    file.safeFilename !== expected.safeFilename ||
    file.contentType !== expected.contentType ||
    file.sizeBytes !== expected.sizeBytes ||
    file.sha256 !== expected.sha256 ||
    file.objectKey !== expected.objectKey
  ) {
    throw new HTTPException(409, { message: "sandbox artifact identity is unavailable" });
  }
}

function assertStoredSandboxArtifact(
  head: ObjectHead,
  file: NonNullable<Awaited<ReturnType<typeof getFile>>>,
): void {
  if (
    Number(head.ContentLength ?? -1) !== file.sizeBytes ||
    (head.ContentType !== undefined && head.ContentType !== file.contentType) ||
    (file.sha256 !== null && head.Metadata?.sha256 !== file.sha256)
  ) {
    throw new HTTPException(502, { message: "sandbox artifact failed storage verification" });
  }
}
