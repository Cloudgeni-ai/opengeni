import {
  PreparedEditableArtifactPublicationSchema,
  PublishEditableArtifactReceiptSchema,
  signDelegatedAccessToken,
  type FileAsset,
  type PreparedEditableArtifactPublication,
  type PublishEditableArtifactReceipt,
  type PublishEditableArtifactToolInput,
} from "@opengeni/contracts";
import {
  firstPartyMcpWorkspaceUrl,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import { completeFileUpload, prepareEditableArtifactSourceFile, type Database } from "@opengeni/db";
import { readResponseJsonBounded, undiciFetch, type FetchLike } from "@opengeni/network";
import {
  createObjectStorageBoundedPorts,
  BoundedObjectReadError,
  type ObjectHead,
  type ObjectStorage,
} from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";

const SNAPSHOT_MIME_TYPE = "application/vnd.opengeni.editable-artifact-snapshot";
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const RANGE_BYTES = 1024 * 1024;
const API_RESPONSE_MAX_BYTES = 64 * 1024;
const UPLOAD_TTL_SECONDS = 15 * 60;
const UPLOAD_INTENT_TTL_MS = 60 * 60_000;

type SandboxCommandResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

export type ExecuteEditableArtifactPublicationInput = Readonly<{
  db: Database;
  objectStorage: ObjectStorage;
  sandboxObjectStorage: ObjectStorage;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
  toolCallId: string;
  request: PublishEditableArtifactToolInput;
  runtimeEntrypoint: string;
  runCommand: (input: {
    cmd: string;
    workdir: string;
    maxOutputTokens: number;
  }) => Promise<SandboxCommandResult>;
  signal?: AbortSignal;
}>;

type EditableArtifactPublicationPorts = Readonly<{
  prepareSourceFile: typeof prepareEditableArtifactSourceFile;
  completeSourceFile: typeof completeFileUpload;
  fetch: FetchLike;
}>;

const defaultPorts: EditableArtifactPublicationPorts = Object.freeze({
  prepareSourceFile: prepareEditableArtifactSourceFile,
  completeSourceFile: completeFileUpload,
  fetch: undiciFetch,
});

/**
 * Host-owned promotion transaction for an agent's final verified Office file.
 * The sandbox may supply bytes, but never chooses storage identity, authority,
 * snapshot metadata, API destination, or the returned durable receipt.
 */
export async function executeEditableArtifactPublication(
  input: ExecuteEditableArtifactPublicationInput,
  ports: EditableArtifactPublicationPorts = defaultPorts,
): Promise<PublishEditableArtifactReceipt> {
  throwIfAborted(input.signal);
  if (input.objectStorage.bucket !== input.sandboxObjectStorage.bucket) {
    throw new Error("Editable artifact publication storage authority differs by endpoint");
  }
  const identity = publicationIdentity(input);
  const runtimeCli = posix.join(
    posix.dirname(input.runtimeEntrypoint),
    "opengeni-artifact-runtime.mjs",
  );
  const snapshotPath = `/tmp/opengeni-artifact-publications/${identity.operationDigest}.snapshot`;
  const prepared = await preparePublicationInSandbox(input, runtimeCli, snapshotPath);
  if (prepared.modality !== input.request.modality) {
    throw new Error("Editable artifact publication modality changed during preparation");
  }

  const extension = officeExtension(input.request.modality);
  const filename = sourceFilename(input.request.path, identity.fileId, extension);
  const safeFilename = `editable-artifact-source-${identity.fileId}${extension}`;
  const sourceHash = prepared.source.contentHash.slice("sha256:".length);
  const sourceObjectKey = `workspaces/${input.workspaceId}/files/${identity.fileId}/editable-artifact-source/${safeFilename}`;
  const sourceIntent = await ports.prepareSourceFile(input.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    fileId: identity.fileId,
    uploadId: identity.uploadId,
    filename,
    safeFilename,
    contentType: prepared.source.mimeType,
    sizeBytes: prepared.source.byteSize,
    sha256: sourceHash,
    bucket: input.objectStorage.bucket,
    objectKey: sourceObjectKey,
    expiresAt: new Date(Date.now() + UPLOAD_INTENT_TTL_MS),
  });

  const snapshotReference = await ensurePublicationSnapshot({
    storage: input.objectStorage,
    sandboxStorage: input.sandboxObjectStorage,
    snapshotPath,
    snapshot: prepared.snapshot,
    runCommand: input.runCommand,
    operationDigest: identity.operationDigest,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  let sourceFile = sourceIntent.file;
  if (sourceFile.status !== "ready") {
    const upload = await input.sandboxObjectStorage.createPutUrl({
      key: sourceFile.objectKey,
      contentType: sourceFile.contentType,
      sha256: sourceHash,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    });
    await uploadSandboxFile(input, input.request.path, upload);
    await verifySourceFile(input.objectStorage, sourceFile);
    sourceFile = await ports.completeSourceFile(input.db, input.workspaceId, sourceIntent.uploadId);
  } else {
    await verifySourceFile(input.objectStorage, sourceFile);
  }

  const artifact = await importPublication(input, ports.fetch, {
    prepared,
    snapshotReference,
    sourceFile,
    replicaId: identity.replicaId,
    idempotencyKey: identity.idempotencyKey,
  });
  return PublishEditableArtifactReceiptSchema.parse({
    type: "editable_artifact",
    schemaVersion: 1,
    artifact: {
      id: artifact.id,
      modality: artifact.modality,
      title: artifact.title,
    },
    sourceFile: {
      id: sourceFile.id,
      filename: sourceFile.filename,
      contentType: sourceFile.contentType,
      sizeBytes: sourceFile.sizeBytes,
      sha256: sourceFile.sha256,
    },
    editorPath: `/workspaces/${input.workspaceId}/artifacts/editable/${artifact.id}`,
  });
}

async function preparePublicationInSandbox(
  input: ExecuteEditableArtifactPublicationInput,
  runtimeCli: string,
  snapshotPath: string,
): Promise<PreparedEditableArtifactPublication> {
  const result = await input.runCommand({
    cmd: [
      "set -eu",
      "umask 077",
      `mkdir -p -- ${shellQuote(posix.dirname(snapshotPath))}`,
      `rm -f -- ${shellQuote(snapshotPath)}`,
      `source_path=$(realpath -- ${shellQuote(input.request.path)})`,
      `exec ${shellQuote(runtimeCli)} prepare-publication --json --modality ${shellQuote(input.request.modality)} --input "$source_path" --snapshot-output ${shellQuote(snapshotPath)}`,
    ].join("\n"),
    workdir: "/workspace",
    maxOutputTokens: 16_384,
  });
  if (result.exitCode !== 0) {
    throw new Error("Verified editable artifact publication preparation failed");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Verified editable artifact publication returned invalid JSON");
  }
  return PreparedEditableArtifactPublicationSchema.parse(decoded);
}

async function ensurePublicationSnapshot(
  input: Readonly<{
    storage: ObjectStorage;
    sandboxStorage: ObjectStorage;
    snapshotPath: string;
    snapshot: PreparedEditableArtifactPublication["snapshot"];
    runCommand: ExecuteEditableArtifactPublicationInput["runCommand"];
    operationDigest: string;
    signal?: AbortSignal;
  }>,
): Promise<string> {
  const ports = createObjectStorageBoundedPorts(input.storage);
  const expectedReference = `editable-artifacts/snapshots/sha256/${input.snapshot.contentHash.slice("sha256:".length)}`;
  if (await snapshotExistsExactly(ports.read, expectedReference, input.snapshot, input.signal)) {
    return expectedReference;
  }

  const stagingKey = `workspaces/publication-staging/${input.operationDigest}/${randomUUID()}.snapshot`;
  try {
    const upload = await input.sandboxStorage.createPutUrl({
      key: stagingKey,
      contentType: SNAPSHOT_MIME_TYPE,
      sha256: input.snapshot.contentHash,
      expiresInSeconds: UPLOAD_TTL_SECONDS,
    });
    await uploadSandboxPath(input.runCommand, input.snapshotPath, upload);
    const written = await ports.write.write({
      chunks: rawObjectChunks(input.storage, stagingKey, input.snapshot, input.signal),
      contentType: SNAPSHOT_MIME_TYPE,
      maxBytes: MAX_SNAPSHOT_BYTES,
      expectedByteSize: input.snapshot.byteSize,
      expectedContentHash: input.snapshot.contentHash,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (
      written.opaqueReference !== expectedReference ||
      written.byteSize !== input.snapshot.byteSize ||
      written.contentHash !== input.snapshot.contentHash
    ) {
      throw new Error("Editable artifact snapshot promotion returned a different identity");
    }
    return written.opaqueReference;
  } finally {
    await input.storage.deleteObject(stagingKey).catch(() => undefined);
  }
}

async function snapshotExistsExactly(
  read: ReturnType<typeof createObjectStorageBoundedPorts>["read"],
  reference: string,
  snapshot: PreparedEditableArtifactPublication["snapshot"],
  signal?: AbortSignal,
): Promise<boolean> {
  let reader;
  try {
    reader = await read.open({
      opaqueReference: reference,
      maxBytes: MAX_SNAPSHOT_BYTES,
      expectedByteSize: snapshot.byteSize,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof BoundedObjectReadError && error.code === "object_missing") {
      return false;
    }
    throw error;
  }
  try {
    if (reader.contentType !== SNAPSHOT_MIME_TYPE) {
      throw new Error("Editable artifact snapshot content type is invalid");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of reader.chunks({ ...(signal ? { signal } : {}) })) {
      bytes += chunk.byteLength;
      hash.update(chunk);
    }
    await reader.assertUnchanged(signal);
    return bytes === snapshot.byteSize && `sha256:${hash.digest("hex")}` === snapshot.contentHash;
  } finally {
    await reader.close();
  }
}

async function* rawObjectChunks(
  storage: ObjectStorage,
  key: string,
  snapshot: PreparedEditableArtifactPublication["snapshot"],
  signal?: AbortSignal,
): AsyncIterableIterator<Uint8Array> {
  if (!storage.headObject || !storage.getObjectRange) {
    throw new Error("Object storage lacks versioned publication staging reads");
  }
  throwIfAborted(signal);
  const head = await storage.headObject(key);
  assertStagingHead(head, snapshot);
  const versionToken = head!.VersionToken!;
  for (let offset = 0; offset < snapshot.byteSize; offset += RANGE_BYTES) {
    throwIfAborted(signal);
    const endInclusive = Math.min(snapshot.byteSize - 1, offset + RANGE_BYTES - 1);
    const range = await storage.getObjectRange({
      key,
      start: offset,
      endInclusive,
      expectedVersionToken: versionToken,
    });
    if (
      !range ||
      range.versionToken !== versionToken ||
      range.bytes.byteLength !== endInclusive - offset + 1
    ) {
      throw new Error("Editable artifact snapshot staging object changed during read");
    }
    yield range.bytes;
  }
  throwIfAborted(signal);
  const after = await storage.headObject(key);
  assertStagingHead(after, snapshot);
  if (after!.VersionToken !== versionToken) {
    throw new Error("Editable artifact snapshot staging generation changed");
  }
}

function assertStagingHead(
  head: ObjectHead | null,
  snapshot: PreparedEditableArtifactPublication["snapshot"],
): void {
  if (
    !head ||
    head.ContentLength !== snapshot.byteSize ||
    head.ContentType !== SNAPSHOT_MIME_TYPE ||
    head.Metadata?.sha256 !== snapshot.contentHash ||
    typeof head.VersionToken !== "string" ||
    head.VersionToken.length < 1
  ) {
    throw new Error("Editable artifact snapshot staging metadata is invalid");
  }
}

async function verifySourceFile(storage: ObjectStorage, file: FileAsset): Promise<void> {
  const head = await storage.headFile(file);
  if (
    head.ContentLength !== file.sizeBytes ||
    head.ContentType !== file.contentType ||
    head.Metadata?.sha256 !== file.sha256
  ) {
    throw new Error("Editable artifact source upload differs from its verified bytes");
  }
}

async function uploadSandboxFile(
  input: ExecuteEditableArtifactPublicationInput,
  path: string,
  upload: Awaited<ReturnType<ObjectStorage["createPutUrl"]>>,
): Promise<void> {
  const result = await input.runCommand({
    cmd: uploadCommand(path, upload),
    workdir: "/workspace",
    maxOutputTokens: 4_096,
  });
  if (result.exitCode !== 0) throw new Error("Editable artifact source upload failed");
}

async function uploadSandboxPath(
  runCommand: ExecuteEditableArtifactPublicationInput["runCommand"],
  path: string,
  upload: Awaited<ReturnType<ObjectStorage["createPutUrl"]>>,
): Promise<void> {
  const result = await runCommand({
    cmd: uploadCommand(path, upload),
    workdir: "/workspace",
    maxOutputTokens: 4_096,
  });
  if (result.exitCode !== 0) throw new Error("Editable artifact snapshot staging upload failed");
}

function uploadCommand(
  path: string,
  upload: Awaited<ReturnType<ObjectStorage["createPutUrl"]>>,
): string {
  const headers = Object.entries(upload.requiredHeaders)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `--header ${shellQuote(`${name}: ${value}`)}`)
    .join(" ");
  return [
    "set -eu",
    `source_path=$(realpath -- ${shellQuote(path)})`,
    `curl --silent --show-error --fail --connect-timeout 20 --max-time 600 --request PUT ${headers} --upload-file "$source_path" --output /dev/null ${shellQuote(upload.url)}`,
  ].join("\n");
}

async function importPublication(
  input: ExecuteEditableArtifactPublicationInput,
  fetchImpl: FetchLike,
  publication: Readonly<{
    prepared: PreparedEditableArtifactPublication;
    snapshotReference: string;
    sourceFile: FileAsset;
    replicaId: string;
    idempotencyKey: string;
  }>,
): Promise<Readonly<{ id: string; modality: string; title: string }>> {
  const secret = resolveFirstPartyDelegationSecret(input.settings);
  if (!secret) throw new Error("Editable artifact publication authority is unavailable");
  const bearer = await signDelegatedAccessToken(secret, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: `agent:${input.sessionId}`,
    subjectLabel: "OpenGeni agent",
    permissions: ["artifacts:publish", "files:read"],
    principalKind: "agent_attempt",
    sessionId: input.sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    executionGeneration: input.executionGeneration,
    exp: Math.floor(Date.now() / 1000) + 5 * 60,
  });
  const url = editableArtifactImportUrl(input.settings, input.workspaceId);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      ...(input.settings.authRequired && input.settings.accessKey
        ? { "x-opengeni-access-key": input.settings.accessKey }
        : {}),
    },
    body: JSON.stringify({
      replicaId: publication.replicaId,
      idempotencyKey: publication.idempotencyKey,
      modality: input.request.modality,
      title: input.request.title,
      sourceFileId: publication.sourceFile.id,
      snapshot: {
        ...publication.prepared.snapshot,
        blobReference: publication.snapshotReference,
      },
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const body = await readResponseJsonBounded(
    response,
    API_RESPONSE_MAX_BYTES,
    "editable artifact publication response",
    { ...(input.signal ? { signal: input.signal } : {}) },
  );
  if (!response.ok) throw new Error(`Editable artifact import failed with HTTP ${response.status}`);
  return parseImportedArtifact(body, input.request, publication.prepared.snapshot.stateHash);
}

function parseImportedArtifact(
  value: unknown,
  request: PublishEditableArtifactToolInput,
  expectedStateHash: string,
): Readonly<{ id: string; modality: string; title: string }> {
  if (!isRecord(value)) throw new Error("Editable artifact import returned invalid metadata");
  const keys = [
    "id",
    "modality",
    "title",
    "lifecycle",
    "headSequence",
    "stateHash",
    "createdAt",
    "updatedAt",
  ];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error("Editable artifact import returned unknown metadata");
  }
  if (
    typeof value.id !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.id) ||
    /^0+$/u.test(value.id) ||
    value.modality !== request.modality ||
    value.title !== request.title ||
    value.lifecycle !== "active" ||
    value.headSequence !== 0 ||
    value.stateHash !== expectedStateHash ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Editable artifact import returned mismatched metadata");
  }
  return Object.freeze({ id: value.id, modality: request.modality, title: value.title });
}

function publicationIdentity(
  input: Pick<
    ExecuteEditableArtifactPublicationInput,
    "workspaceId" | "sessionId" | "turnId" | "toolCallId"
  >,
): Readonly<{
  operationDigest: string;
  fileId: string;
  uploadId: string;
  replicaId: string;
  idempotencyKey: string;
}> {
  const basis = `${input.workspaceId}\0${input.sessionId}\0${input.turnId}\0${input.toolCallId}`;
  const hex = (label: string) =>
    createHash("sha256").update(label).update("\0").update(basis).digest("hex");
  const uuid = (label: string) => uuidFromHex(hex(label));
  const replicaCandidate = hex("replica").slice(0, 16);
  return Object.freeze({
    operationDigest: hex("operation"),
    fileId: uuid("file"),
    uploadId: uuid("upload"),
    replicaId: /^0+$/u.test(replicaCandidate) ? `1${replicaCandidate.slice(1)}` : replicaCandidate,
    idempotencyKey: `publish-editable-artifact:${hex("import")}`,
  });
}

function uuidFromHex(hex: string): string {
  const value = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function editableArtifactImportUrl(settings: Settings, workspaceId: string): string {
  const url = new URL(firstPartyMcpWorkspaceUrl(settings, workspaceId));
  if (!url.pathname.endsWith("/mcp")) {
    throw new Error("First-party workspace URL does not end in /mcp");
  }
  url.pathname = `${url.pathname.slice(0, -"/mcp".length)}/editable-artifacts/imports`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function sourceFilename(path: string, fileId: string, extension: string): string {
  const candidate = posix.basename(path);
  return candidate.length > extension.length &&
    candidate.toLowerCase().endsWith(extension) &&
    candidate.trim() === candidate &&
    !/[\u0000-\u001f\u007f]/u.test(candidate) &&
    new TextEncoder().encode(candidate).byteLength <= 512
    ? candidate
    : `editable-artifact-${fileId}${extension}`;
}

function officeExtension(modality: PublishEditableArtifactToolInput["modality"]): string {
  return modality === "document" ? ".docx" : modality === "spreadsheet" ? ".xlsx" : ".pptx";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Editable artifact publication aborted");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
