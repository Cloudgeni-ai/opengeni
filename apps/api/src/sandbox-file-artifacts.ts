import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  SANDBOX_FILE_ARTIFACT_MAX_BYTES,
  SandboxFileArtifactReceipt,
  retainedArtifactReferenceFromFile,
  type AccessGrant,
  type Session,
} from "@opengeni/contracts";
import {
  fileOwnerContextForAccess,
  fileOwnerContextForAgent,
  recordWorkspaceUsage,
  requireLimit,
  type ApiRouteDeps,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import {
  completeFileUpload,
  getFile,
  prepareGeneratedWorkspaceFile,
  getSessionAuthorityProjection,
  requireWorkspace,
  recordSandboxFilePublication,
  withSessionRlsActorContext,
} from "@opengeni/db";
import { retryWhileMissing, type ObjectHead, type ObjectStorage } from "@opengeni/storage";
import { HTTPException } from "hono/http-exception";
import {
  isConnectedMachineAbsolutePath,
  relativeConnectedMachinePath,
  resolveConnectedMachinePath,
  type SandboxChannelAService,
} from "@opengeni/runtime/sandbox";

import { withChannelARead } from "./sandbox/channel-a";
import { sanitizeFilename } from "./routes/files";

const FILE_READ_SENTINEL_BYTES = 1;
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;
const SANDBOX_ARTIFACT_ABSOLUTE_PATH_MAX_CHARS = 4_096;
const SANDBOX_ARTIFACT_SAFE_FILENAME_MAX_CHARS = 200;

/** Original bytes inherit the already-authorized source session's ownership. */
export async function publishSandboxFileArtifact(
  deps: ApiRouteDeps,
  input: Parameters<typeof publishSandboxFileArtifactInScope>[1],
): Promise<SandboxFileArtifactReceipt> {
  const actor = input.authorization
    ? await fileOwnerContextForAccess(deps, input.authorization, "files:upload")
    : input.grant.principalKind === "agent_attempt"
      ? await fileOwnerContextForAgent(deps, input.grant, "files:upload")
      : { subjectId: input.grant.subjectId, privateFileOwnerSubjectId: null };
  return withSessionRlsActorContext(actor, async () => {
    const [authority, workspace] = await Promise.all([
      getSessionAuthorityProjection(deps.db, input.grant.workspaceId, input.session.id),
      requireWorkspace(deps.db, input.grant.workspaceId),
    ]);
    if (!authority) throw new HTTPException(404, { message: "Source session is unavailable" });
    const personal =
      authority.visibility === "user_private" ||
      authority.memoryScope === "user" ||
      workspace.kind === "personal";
    const expectedOwner =
      authority.visibility === "user_private"
        ? authority.ownerSubjectId
        : authority.memoryScope === "user"
          ? authority.scopeSubjectId
          : actor.privateFileOwnerSubjectId;
    if (personal && (!expectedOwner || actor.privateFileOwnerSubjectId !== expectedOwner))
      throw new HTTPException(403, {
        message: "Personal file publication requires the session owner's authority",
      });
    return withSessionRlsActorContext(
      { ...actor, privateFileOwnerSubjectId: personal ? (expectedOwner ?? null) : null },
      () => publishSandboxFileArtifactInScope(deps, input),
    );
  });
}

async function publishSandboxFileArtifactInScope(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    authorization?: AccessGrantAuthorization;
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
  if (!storage.headObject) {
    throw new HTTPException(503, {
      message: "object storage cannot verify immutable artifact files",
    });
  }

  const maxArtifactBytes = Math.min(SANDBOX_FILE_ARTIFACT_MAX_BYTES, storage.maxSinglePutSizeBytes);
  if (maxArtifactBytes < 1) {
    throw new HTTPException(503, { message: "object storage cannot accept artifact files" });
  }
  const readLimit = Math.min(25 * 1024 * 1024, maxArtifactBytes + FILE_READ_SENTINEL_BYTES);
  const { path, sandboxPath, read } = await withChannelARead(
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
    ({ service }) => readSandboxArtifactFile(service, input.path, readLimit),
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
  const safeFilename = sandboxArtifactSafeFilename(filename);
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
    bucket: storage.bucket,
    objectKey,
  });
  if (file.status !== "ready") {
    const existingObject = await storage.headObject(file.objectKey);
    if (existingObject) {
      assertStoredSandboxArtifact(existingObject, file);
    } else {
      const put = {
        key: file.objectKey,
        contentType: file.contentType,
        body: bytes,
        sha256,
      };
      if (storage.putObjectIfAbsent) {
        const created = await storage.putObjectIfAbsent(put);
        if (!created) await assertVisibleSandboxArtifact(storage, file);
      } else {
        await storage.putObject(put);
      }
    }
    file = await completeFileUpload(deps.db, input.grant.workspaceId, identity.uploadId);
  } else {
    await assertVisibleSandboxArtifact(storage, file);
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
  await recordSandboxFilePublication(deps.db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    fileId: file.id,
    sourceSessionId: input.session.id,
  });
  return SandboxFileArtifactReceipt.parse({
    type: "sandbox_file",
    sandboxPath,
    filename,
    artifact,
  });
}

/** Use the root captured by the same fenced Channel-A service that reads bytes,
 * not the session's placement-home label or a caller-supplied root. */
export async function readSandboxArtifactFile(
  service: Pick<SandboxChannelAService, "capabilities" | "fsRead">,
  value: string,
  maxBytes: number,
) {
  const root = service.capabilities().FileSystem.root;
  const path = sandboxArtifactRelativePath(value, root);
  const sandboxPath = resolveConnectedMachinePath(root, path);
  const read = await service.fsRead({ path, encoding: "base64", maxBytes });
  return { path, sandboxPath, read };
}

export function sandboxArtifactRelativePath(value: string, workspaceRoot = "/workspace"): string {
  let path = value.trim();
  if (path.startsWith("sandbox:")) {
    path = path.slice("sandbox:".length);
  }
  if (!path || /[\\/]$/.test(path)) {
    throw new HTTPException(400, { message: "sandbox artifact path must name a file" });
  }
  let absolute: string;
  let relative: string | null;
  try {
    if (!isConnectedMachineAbsolutePath(workspaceRoot)) throw new Error("Missing workspace root");
    absolute = resolveConnectedMachinePath(workspaceRoot, path);
    relative = relativeConnectedMachinePath(workspaceRoot, absolute);
  } catch {
    throw new HTTPException(400, {
      message: "sandbox artifact path is invalid for this workspace",
    });
  }
  if (!relative) {
    throw new HTTPException(400, {
      message: "sandbox artifact path must name a file inside the active workspace root",
    });
  }
  if (absolute.length > SANDBOX_ARTIFACT_ABSOLUTE_PATH_MAX_CHARS) {
    throw new HTTPException(400, { message: "sandbox artifact path is too long" });
  }
  return relative;
}

export function sandboxArtifactSafeFilename(filename: string): string {
  return sanitizeFilename(filename).slice(0, SANDBOX_ARTIFACT_SAFE_FILENAME_MAX_CHARS);
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
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".ogv": "video/ogg",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".wav": "audio/wav",
      ".flac": "audio/flac",
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

export function sandboxArtifactIdentity(input: {
  workspaceId: string;
  sessionId: string;
  path: string;
  sha256: string;
}): { fileId: string; uploadId: string } {
  const digest = createHash("sha256")
    // Newly classified media must not collide with old binary-typed publications.
    // Preserve the v1 identity for every previously supported format.
    .update(
      /^(audio|video)\//.test(sandboxFileContentType(input.path))
        ? "opengeni-sandbox-media-artifact-v1\0"
        : "opengeni-sandbox-file-artifact-v1\0",
    )
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

export function assertSandboxArtifactFile(
  file: NonNullable<Awaited<ReturnType<typeof getFile>>>,
  expected: {
    filename: string;
    safeFilename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    bucket: string;
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
    file.bucket !== expected.bucket ||
    file.objectKey !== expected.objectKey
  ) {
    throw new HTTPException(409, { message: "sandbox artifact identity is unavailable" });
  }
}

async function assertVisibleSandboxArtifact(
  storage: ObjectStorage,
  file: NonNullable<Awaited<ReturnType<typeof getFile>>>,
): Promise<void> {
  const head = await retryWhileMissing(async () => await storage.headObject!(file.objectKey));
  assertStoredSandboxArtifact(head, file);
}

function assertStoredSandboxArtifact(
  head: ObjectHead | null,
  file: NonNullable<Awaited<ReturnType<typeof getFile>>>,
): void {
  if (
    !head ||
    head.ContentLength !== file.sizeBytes ||
    head.ContentType !== file.contentType ||
    (file.sha256 !== null && head.Metadata?.sha256 !== file.sha256) ||
    typeof head.VersionToken !== "string" ||
    head.VersionToken.length < 1
  ) {
    throw new HTTPException(502, { message: "sandbox artifact failed storage verification" });
  }
}
