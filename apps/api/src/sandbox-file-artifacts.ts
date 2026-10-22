import { createHash } from "node:crypto";
import { posix } from "node:path";

import {
  SANDBOX_FILE_ARTIFACT_INLINE_MAX_BYTES,
  SANDBOX_FILE_ARTIFACT_MAX_BYTES,
  SandboxFileArtifactReceipt,
  retainedArtifactReferenceFromFile,
  type AccessGrant,
  type Session,
  type WorkspaceArtifactVisibility,
  type Workspace,
} from "@opengeni/contracts";
import {
  changeFileVisibility,
  fileAccessFor,
  fileOwnerContextForAccess,
  fileOwnerContextForAgent,
  grantHasAgentAttemptAuthority,
  recordWorkspaceUsage,
  requireLimit,
  resolveNewFileAudience,
  sourceSessionRequiresHumanShare,
  type ApiRouteDeps,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import {
  completeFileUpload,
  getFile,
  getGeneratedVideoArtifact,
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

import { withChannelA, withChannelARead } from "./sandbox/channel-a";
import { sanitizeFilename } from "./routes/files";

const FILE_READ_SENTINEL_BYTES = 1;
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;
/** Covers the longest box upload (three hours at the 1 MB/s floor) plus margin. */
const SANDBOX_EXPORT_URL_TTL_SECONDS = 4 * 60 * 60;
const SANDBOX_ARTIFACT_ABSOLUTE_PATH_MAX_CHARS = 4_096;
const SANDBOX_ARTIFACT_SAFE_FILENAME_MAX_CHARS = 200;

/**
 * Original bytes inherit the already-authorized source session's audience:
 * Only me in an Only me chat, else the workspace. A person may explicitly
 * share a private-chat file; an agent may not widen it. Republishing keeps
 * the audience its owner has given it unless a visibility is asked for.
 */
export async function publishSandboxFileArtifact(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    authorization?: AccessGrantAuthorization;
    session: Session;
    path: string;
    visibility?: WorkspaceArtifactVisibility | undefined;
    signal?: AbortSignal | undefined;
  },
): Promise<SandboxFileArtifactReceipt> {
  const actor = input.authorization
    ? await fileOwnerContextForAccess(deps, input.authorization, "files:upload")
    : grantHasAgentAttemptAuthority(input.grant)
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
    if (
      grantHasAgentAttemptAuthority(input.grant) &&
      input.visibility === "workspace" &&
      (await sourceSessionRequiresHumanShare(deps.db, input.grant.workspaceId, input.session.id))
    ) {
      throw new HTTPException(403, {
        message: "Only the person can share a private chat file with the workspace",
      });
    }
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
    // The person this publication acts for: the human caller, or the human
    // whose turn the agent is running. Keys and services act for nobody.
    const person = grantHasAgentAttemptAuthority(input.grant)
      ? (actor.initiatingHumanSubjectId ?? null)
      : (actor.privateFileOwnerSubjectId ?? null);
    const audience = await resolveNewFileAudience({
      db: deps.db,
      settings: deps.settings,
      workspace,
      chatOwner: personal ? (expectedOwner ?? null) : null,
      person,
      requested: input.visibility,
    });
    return withSessionRlsActorContext(
      // Scoped as the file's owner so an existing copy is found whatever
      // audience the owner has since given it.
      { ...actor, privateFileOwnerSubjectId: audience.ownerSubjectId },
      () =>
        publishSandboxFileArtifactInScope(deps, {
          ...input,
          workspace,
          person,
          privateOwnerSubjectId: audience.privateOwnerSubjectId,
        }),
    );
  });
}

/** Who can open a file now, after an agent changed it for its owner. */
export type FileAccessReceipt = {
  type: "file_access";
  artifactId: string;
  filename: string;
  access: import("@opengeni/contracts").FileAccess;
};

/**
 * Change who can open a file the caller can already open (a published file,
 * generated image or video, download or upload), on the owner's behalf. An
 * agent acts for the person whose turn it runs and sees only what its chat's
 * own audience lets it see, so it can never reach another chat's private file.
 */
export async function changeWorkspaceFileVisibility(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    artifactId: string;
    visibility: WorkspaceArtifactVisibility;
  },
): Promise<FileAccessReceipt> {
  const actor = grantHasAgentAttemptAuthority(input.grant)
    ? await fileOwnerContextForAgent(deps, input.grant, "files:upload")
    : { subjectId: input.grant.subjectId, privateFileOwnerSubjectId: null };
  return withSessionRlsActorContext(actor, async () => {
    const workspace = await requireWorkspace(deps.db, input.grant.workspaceId);
    const fileId =
      (await getFile(deps.db, input.grant.workspaceId, input.artifactId))?.id ??
      (await getGeneratedVideoArtifact(deps.db, input.grant.workspaceId, input.artifactId))?.file
        .id;
    if (!fileId) throw new HTTPException(404, { message: "file not found" });
    const { file } = await changeFileVisibility({
      db: deps.db,
      settings: deps.settings,
      grant: input.grant,
      workspace,
      person: actor.initiatingHumanSubjectId ?? null,
      fileId,
      visibility: input.visibility,
    });
    return {
      type: "file_access",
      artifactId: input.artifactId,
      filename: file.filename,
      access: await fileAccessFor(deps.db, { workspace, file }),
    };
  });
}

async function publishSandboxFileArtifactInScope(
  deps: ApiRouteDeps,
  input: {
    grant: AccessGrant;
    authorization?: AccessGrantAuthorization;
    session: Session;
    path: string;
    visibility?: WorkspaceArtifactVisibility | undefined;
    workspace: Workspace;
    person: string | null;
    privateOwnerSubjectId: string | null;
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

  const maxReadBytes = Math.min(
    SANDBOX_FILE_ARTIFACT_INLINE_MAX_BYTES,
    storage.maxSinglePutSizeBytes,
  );
  const maxArtifactBytes = Math.min(SANDBOX_FILE_ARTIFACT_MAX_BYTES, storage.maxSinglePutSizeBytes);
  if (maxReadBytes < 1) {
    throw new HTTPException(503, { message: "object storage cannot accept artifact files" });
  }
  const readLimit = Math.min(25 * 1024 * 1024, maxReadBytes + FILE_READ_SENTINEL_BYTES);
  const channelServices = {
    db: deps.db,
    settings: deps.settings,
    bus: deps.bus,
    ...(deps.observability ? { observability: deps.observability } : {}),
  };
  const channelContext = {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    session: input.session,
    subjectId: input.grant.subjectId,
    grant: input.grant,
    ...(input.signal ? { waitSignal: input.signal } : {}),
    operation: "artifact.publish" as const,
  };
  // Small files come through the API in one read. A larger file is hashed
  // where it lives and uploaded from there straight to object storage, so its
  // bytes never cross the control plane.
  const { path, sandboxPath, content } = await withChannelARead(
    channelServices,
    channelContext,
    async ({ service }) => {
      const small = await readSandboxArtifactFile(service, input.path, readLimit);
      if (!small.read.truncated && small.read.sizeBytes <= maxReadBytes) {
        return { ...small, content: sandboxArtifactBytes(small.read) };
      }
      const digest = await service.digestWorkspaceFile(small.path);
      return {
        path: small.path,
        sandboxPath: small.sandboxPath,
        content: { kind: "box" as const, sizeBytes: digest.sizeBytes, sha256: digest.sha256 },
      };
    },
  );
  if (content.sizeBytes > maxArtifactBytes) {
    throw new HTTPException(413, {
      message: `sandbox file exceeds the ${maxArtifactBytes}-byte artifact publication limit`,
    });
  }
  if (content.sizeBytes === 0) {
    throw new HTTPException(422, { message: "sandbox artifact file is empty" });
  }
  const sizeBytes = content.sizeBytes;
  const sha256 = content.sha256;

  const filename = posix.basename(path);
  if (filename.length > 1_024) {
    throw new HTTPException(422, { message: "sandbox artifact filename is too long" });
  }
  const safeFilename = sandboxArtifactSafeFilename(filename);
  const contentType = sandboxFileContentType(filename);
  const identity = sandboxArtifactIdentity({
    workspaceId: input.grant.workspaceId,
    sessionId: input.session.id,
    path,
    sha256,
  });
  const objectKey = `workspaces/${input.grant.workspaceId}/files/${identity.fileId}/sandbox/${safeFilename}`;
  const existing = await getFile(deps.db, input.grant.workspaceId, identity.fileId);
  let file = existing;
  let newlyPrepared = false;

  if (!file) {
    await requireLimit(deps, {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      action: "file:upload",
      quantity: sizeBytes,
    });
    const prepared = await prepareGeneratedWorkspaceFile(deps.db, {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      fileId: identity.fileId,
      uploadId: identity.uploadId,
      filename,
      safeFilename,
      contentType,
      sizeBytes,
      sha256,
      bucket: storage.bucket,
      objectKey,
      privateOwnerSubjectId: input.privateOwnerSubjectId,
      sourceSessionId: input.session.id,
      expiresAt: new Date(
        Date.now() +
          (content.kind === "box" ? SANDBOX_EXPORT_URL_TTL_SECONDS * 1_000 : UPLOAD_INTENT_TTL_MS),
      ),
    });
    file = prepared.file;
    newlyPrepared = prepared.created;
  }

  assertSandboxArtifactFile(file, {
    filename,
    safeFilename,
    contentType,
    sizeBytes,
    sha256,
    bucket: storage.bucket,
    objectKey,
  });
  if (file.status !== "ready" && content.kind === "box") {
    // Always upload again: an object left by an earlier attempt whose file
    // changed mid-upload carries this digest's metadata but not its bytes.
    const target = file;
    await withChannelA(channelServices, channelContext, async ({ service, lease }) => {
      // A Connected Machine reaches storage on its public endpoint; a leased
      // managed sandbox uses the sandbox-facing one.
      const put = await storage.createPutUrl({
        key: target.objectKey,
        contentType: target.contentType,
        sha256,
        expiresInSeconds: SANDBOX_EXPORT_URL_TTL_SECONDS,
        audience: lease ? "sandbox" : "public",
      });
      await service.exportWorkspaceFile({
        path,
        sizeBytes,
        sha256,
        upload: {
          url: put.url,
          requiredHeaders: put.requiredHeaders,
          expiresAt: put.expiresAt.toISOString(),
        },
      });
    });
    await assertVisibleSandboxArtifact(storage, file);
    file = await completeFileUpload(deps.db, input.grant.workspaceId, identity.uploadId);
  } else if (file.status !== "ready" && content.kind === "bytes") {
    const existingObject = await storage.headObject(file.objectKey);
    if (existingObject) {
      assertStoredSandboxArtifact(existingObject, file);
    } else {
      const put = {
        key: file.objectKey,
        contentType: file.contentType,
        body: content.bytes,
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
  const firstHumanShare =
    newlyPrepared &&
    input.visibility === "workspace" &&
    input.workspace.kind !== "personal" &&
    (await sourceSessionRequiresHumanShare(deps.db, input.grant.workspaceId, input.session.id));
  if (
    input.visibility &&
    input.workspace.kind !== "personal" &&
    (!newlyPrepared || firstHumanShare)
  ) {
    file = (
      await changeFileVisibility({
        db: deps.db,
        settings: deps.settings,
        grant: input.grant,
        workspace: input.workspace,
        person: input.person,
        fileId: file.id,
        visibility: input.visibility,
      })
    ).file;
  }
  return SandboxFileArtifactReceipt.parse({
    type: "sandbox_file",
    sandboxPath,
    filename,
    artifact,
    access: await fileAccessFor(deps.db, { workspace: input.workspace, file }),
  });
}

function sandboxArtifactBytes(read: { encoding: string; content: string; sizeBytes: number }): {
  kind: "bytes";
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
} {
  if (read.encoding !== "base64") {
    throw new HTTPException(502, { message: "sandbox returned an invalid binary file response" });
  }
  const bytes = Buffer.from(read.content, "base64");
  if (bytes.byteLength !== read.sizeBytes) {
    throw new HTTPException(502, { message: "sandbox returned an invalid file length" });
  }
  return {
    kind: "bytes",
    bytes,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
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
      // Say which root: on a connected machine the file may exist outside it,
      // and copying it in is the way forward.
      message: `sandbox artifact path must name a file inside this session's workspace root ${workspaceRoot}; ${path} is outside it, so copy the file into the workspace first and use that path`,
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
