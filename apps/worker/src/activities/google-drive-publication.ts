import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import type {
  PublishEditableArtifactReceipt,
  PublishEditableArtifactToolInput,
} from "@opengeni/contracts/editable-artifact-publication";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GoogleDriveConnectionMetadata,
  googleDriveScopesAllowCapability,
} from "@opengeni/contracts/google-drive";
import {
  beginConnectorActionExecution,
  buildConnectionTokenResolver,
  completeConnectorActionExecution,
  getConnectionMetadata,
  requireFile,
  type ConnectorActionAttemptIdentity,
  type ConnectorActionInvocation,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import { readResponseJsonBounded, undiciFetch, type FetchLike } from "@opengeni/network";
import type { ObjectStorage } from "@opengeni/storage";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const RESPONSE_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

type DriveRequest = NonNullable<PublishEditableArtifactToolInput["googleDrive"]>;
type DriveReceipt = NonNullable<PublishEditableArtifactReceipt["googleDrive"]>;

export type GoogleDrivePublicationPorts = {
  getConnection: typeof getConnectionMetadata;
  requireFile: typeof requireFile;
  begin: typeof beginConnectorActionExecution;
  complete: typeof completeConnectorActionExecution;
  resolveCredential: (
    db: Database,
    settings: Settings,
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  fetch: FetchLike;
};

const defaultPorts: GoogleDrivePublicationPorts = {
  getConnection: getConnectionMetadata,
  requireFile,
  begin: beginConnectorActionExecution,
  complete: completeConnectorActionExecution,
  resolveCredential: async (db, settings, input) =>
    await buildConnectionTokenResolver(db, settings)(input),
  fetch: undiciFetch,
};

export function googleDrivePublicationConnectorCall(
  request: PublishEditableArtifactToolInput,
  toolCallId: string,
): ConnectorActionInvocation {
  if (!request.googleDrive) {
    throw new Error("Google Drive publication request is missing");
  }
  return {
    approvalId: toolCallId,
    connectionId: request.googleDrive.connectionId,
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
    arguments: {
      action: GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
      destination: request.googleDrive.destination,
      artifact: { title: request.title, modality: request.modality },
      idempotencyKeyDigest: createHash("sha256")
        .update(request.googleDrive.idempotencyKey, "utf8")
        .digest("hex"),
    },
  };
}

export async function executeGoogleDriveEditableArtifactPublication(
  input: {
    db: Database;
    objectStorage: ObjectStorage;
    settings: Settings;
    identity: ConnectorActionAttemptIdentity;
    subjectId: string;
    toolCallId: string;
    request: PublishEditableArtifactToolInput;
    artifact: PublishEditableArtifactReceipt;
    signal?: AbortSignal;
  },
  ports: GoogleDrivePublicationPorts = defaultPorts,
): Promise<DriveReceipt> {
  const drive = input.request.googleDrive;
  if (!drive) throw new Error("Google Drive publication request is missing");
  const connection = await ports.getConnection(
    input.db,
    input.identity.workspaceId,
    drive.connectionId,
    input.subjectId,
  );
  if (!connection || connection.subjectId !== input.subjectId) {
    throw new Error("Google Drive publication connection is unavailable");
  }
  const metadata = GoogleDriveConnectionMetadata.parse(connection.metadata);
  if (
    connection.providerDomain !== GOOGLE_DRIVE_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    connection.status !== "active" ||
    metadata.lifecycle?.state === "paused" ||
    (metadata.lifecycle && metadata.lifecycle.state !== "active")
  ) {
    throw new Error("Google Drive publication connection is not active");
  }
  if (!googleDriveScopesAllowCapability(connection.grantedScopes, "publish_file")) {
    throw new Error("Google Drive publication requires separate drive.file consent");
  }
  const credentialScope = connection.grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)
    ? GOOGLE_DRIVE_FILE_SCOPE
    : GOOGLE_DRIVE_FULL_SCOPE;
  if (!metadata.outputDestination || !sameDestination(metadata.outputDestination, drive)) {
    throw new Error("Google Drive publication destination is not the configured output folder");
  }
  const sourceFile = await ports.requireFile(
    input.db,
    input.identity.workspaceId,
    input.artifact.sourceFile.id,
  );
  if (
    sourceFile.status !== "ready" ||
    sourceFile.sha256 !== input.artifact.sourceFile.sha256 ||
    sourceFile.sizeBytes !== input.artifact.sourceFile.sizeBytes ||
    sourceFile.contentType !== input.artifact.sourceFile.contentType
  ) {
    throw new Error("Editable artifact source file changed before Drive publication");
  }
  const bytes = await input.objectStorage.getFileBytes(sourceFile);
  if (
    bytes.byteLength !== sourceFile.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== sourceFile.sha256
  ) {
    throw new Error("Editable artifact source bytes failed verification");
  }

  const admission = await ports.begin(
    input.db,
    input.identity,
    googleDrivePublicationConnectorCall(input.request, input.toolCallId),
  );
  if (!admission.allowed) {
    throw new Error(`Google Drive publication was not executed: ${admission.reason}`);
  }
  if (!admission.managed) {
    throw new Error("Google Drive publication has no explicit connector action policy");
  }

  try {
    const receipt = await publishToGoogleDrive({
      workspaceId: input.identity.workspaceId,
      subjectId: input.subjectId,
      connectionId: drive.connectionId,
      drive,
      request: input.request,
      artifact: input.artifact,
      bytes,
      credentialScope,
      resolveCredential: async (credentialInput) =>
        await ports.resolveCredential(input.db, input.settings, credentialInput),
      fetchImpl: ports.fetch,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    await ports.complete(input.db, {
      accountId: input.identity.accountId,
      workspaceId: input.identity.workspaceId,
      requestId: admission.requestId,
      attemptId: input.identity.attemptId,
      outcome: "completed",
    });
    return receipt;
  } catch (error) {
    await ports.complete(input.db, {
      accountId: input.identity.accountId,
      workspaceId: input.identity.workspaceId,
      requestId: admission.requestId,
      attemptId: input.identity.attemptId,
      outcome: "uncertain",
    });
    throw new Error("Google Drive publication failed after connector execution began", {
      cause: error,
    });
  }
}

async function publishToGoogleDrive(input: {
  workspaceId: string;
  subjectId: string;
  connectionId: string;
  drive: DriveRequest;
  request: PublishEditableArtifactToolInput;
  artifact: PublishEditableArtifactReceipt;
  bytes: Uint8Array;
  credentialScope: typeof GOOGLE_DRIVE_FILE_SCOPE | typeof GOOGLE_DRIVE_FULL_SCOPE;
  resolveCredential: (
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<DriveReceipt> {
  const credential = await input.resolveCredential({
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
    connectionRef: {
      providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
      connectionId: input.connectionId,
      kind: "oauth2",
      subjectScope: "subject",
      scopes: [input.credentialScope],
    },
    destinationUrl: `${DRIVE_UPLOAD_API}/files`,
    forceRefresh: false,
  });
  if (credential.status !== "ok") {
    throw new Error("Google Drive publication credential is unavailable");
  }
  const headers = credential.headers;
  await verifyDestinationAtWriteTime(input, headers);
  const operationKey = publicationOperationKey(input);
  const existing = await findExistingPublication(input, headers, operationKey);
  if (existing) return driveReceipt(input, existing, true);

  const mimeType = googleNativeMime(input.request.modality);
  const boundary = `opengeni_${operationKey.slice(0, 32)}`;
  const metadata = JSON.stringify({
    name: input.request.title,
    mimeType,
    parents: [input.drive.destination.folderId],
    appProperties: {
      opengeniPublicationKey: operationKey,
      opengeniArtifactId: input.artifact.artifact.id,
      opengeniSourceSha256: input.artifact.sourceFile.sha256,
    },
  });
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.artifact.sourceFile.contentType}\r\n\r\n`,
  );
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(prefix.byteLength + input.bytes.byteLength + suffix.byteLength);
  body.set(prefix, 0);
  body.set(input.bytes, prefix.byteLength);
  body.set(suffix, prefix.byteLength + input.bytes.byteLength);
  const url = new URL(`${DRIVE_UPLOAD_API}/files`);
  url.searchParams.set("uploadType", "multipart");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "id,name,mimeType,parents,driveId,webViewLink,appProperties,trashed",
  );
  const created = parseDriveFile(
    await requestJson(input.fetchImpl, url, {
      method: "POST",
      headers: {
        ...headers,
        accept: "application/json",
        "content-type": `multipart/related; boundary=${boundary}`,
        "content-length": String(body.byteLength),
      },
      body,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  );
  assertPublicationMatch(input, created, operationKey);
  return driveReceipt(input, created, false);
}

async function verifyDestinationAtWriteTime(
  input: Parameters<typeof publishToGoogleDrive>[0],
  headers: Record<string, string>,
): Promise<void> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(input.drive.destination.folderId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,driveId,trashed,capabilities(canAddChildren)");
  const folder = record(await requestJson(input.fetchImpl, url, { headers }));
  const capabilities = record(folder.capabilities);
  if (
    folder.id !== input.drive.destination.folderId ||
    folder.name !== input.drive.destination.folderName ||
    folder.mimeType !== DRIVE_FOLDER_MIME ||
    folder.trashed === true ||
    capabilities.canAddChildren !== true ||
    (folder.driveId ?? null) !== input.drive.destination.driveId
  ) {
    throw new Error("Google Drive output destination changed or is no longer writable");
  }
}

async function findExistingPublication(
  input: Parameters<typeof publishToGoogleDrive>[0],
  headers: Record<string, string>,
  operationKey: string,
): Promise<DriveFile | null> {
  const destination = input.drive.destination;
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `trashed = false and '${driveQuery(destination.folderId)}' in parents and appProperties has { key='opengeniPublicationKey' and value='${operationKey}' }`,
  );
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (destination.driveId) {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", destination.driveId);
  } else {
    url.searchParams.set("corpora", "user");
  }
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,parents,driveId,webViewLink,appProperties,trashed)",
  );
  const payload = record(await requestJson(input.fetchImpl, url, { headers }));
  const files = Array.isArray(payload.files) ? payload.files.map(parseDriveFile) : [];
  if (files.length > 1) {
    throw new Error("Google Drive publication idempotency marker is ambiguous");
  }
  const existing = files[0] ?? null;
  if (existing) assertPublicationMatch(input, existing, operationKey);
  return existing;
}

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId: string | null;
  webViewLink: string;
  appProperties: Record<string, string>;
  trashed: boolean;
};

function parseDriveFile(value: unknown): DriveFile {
  const item = record(value);
  const appProperties = record(item.appProperties);
  if (
    typeof item.id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.mimeType !== "string" ||
    !Array.isArray(item.parents) ||
    !item.parents.every((entry) => typeof entry === "string") ||
    (item.driveId !== undefined && item.driveId !== null && typeof item.driveId !== "string") ||
    typeof item.webViewLink !== "string" ||
    typeof item.trashed !== "boolean"
  ) {
    throw new Error("Google Drive returned an invalid publication receipt");
  }
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    parents: item.parents,
    driveId: (item.driveId as string | null | undefined) ?? null,
    webViewLink: item.webViewLink,
    appProperties: Object.fromEntries(
      Object.entries(appProperties).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    trashed: item.trashed,
  };
}

function assertPublicationMatch(
  input: Parameters<typeof publishToGoogleDrive>[0],
  file: DriveFile,
  operationKey: string,
): void {
  if (
    file.trashed ||
    file.name !== input.request.title ||
    file.mimeType !== googleNativeMime(input.request.modality) ||
    file.parents.length !== 1 ||
    file.parents[0] !== input.drive.destination.folderId ||
    file.driveId !== input.drive.destination.driveId ||
    file.appProperties.opengeniPublicationKey !== operationKey ||
    file.appProperties.opengeniArtifactId !== input.artifact.artifact.id ||
    file.appProperties.opengeniSourceSha256 !== input.artifact.sourceFile.sha256
  ) {
    throw new Error("Google Drive publication idempotency key conflicts with another file");
  }
}

function driveReceipt(
  input: Parameters<typeof publishToGoogleDrive>[0],
  file: DriveFile,
  replayed: boolean,
): DriveReceipt {
  return {
    connectionId: input.connectionId,
    providerFileId: file.id,
    webViewLink: file.webViewLink,
    mimeType: googleNativeMime(input.request.modality),
    destination: input.drive.destination,
    replayed,
  };
}

function publicationOperationKey(input: Parameters<typeof publishToGoogleDrive>[0]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        destination: input.drive.destination,
        artifactId: input.artifact.artifact.id,
        sourceSha256: input.artifact.sourceFile.sha256,
        idempotencyKey: input.drive.idempotencyKey,
      }),
      "utf8",
    )
    .digest("hex");
}

function googleNativeMime(
  modality: PublishEditableArtifactToolInput["modality"],
): DriveReceipt["mimeType"] {
  switch (modality) {
    case "document":
      return "application/vnd.google-apps.document";
    case "spreadsheet":
      return "application/vnd.google-apps.spreadsheet";
    case "presentation":
      return "application/vnd.google-apps.presentation";
  }
}

function sameDestination(
  configured: {
    folderId: string;
    folderName: string;
    driveId: string | null;
    location: "my_drive" | "shared_drive";
  },
  requested: DriveRequest,
): boolean {
  return (
    configured.folderId === requested.destination.folderId &&
    configured.folderName === requested.destination.folderName &&
    configured.driveId === requested.destination.driveId &&
    configured.location === requested.destination.location
  );
}

async function requestJson(fetchImpl: FetchLike, url: URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Google Drive publication transport failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Google Drive publication request failed with status ${response.status}`);
  }
  return await readResponseJsonBounded(response, RESPONSE_MAX_BYTES, "Google Drive publication");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function driveQuery(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");
}
