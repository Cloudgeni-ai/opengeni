import { createHash } from "node:crypto";
import { AttemptToolApprovalRequiredError, type AttemptToolDefinition } from "@opengeni/codemode";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
  GOOGLE_DRIVE_PROVIDER_DOMAIN,
  GoogleDriveConnectionMetadata,
  GoogleDrivePublicationReceipt,
  GoogleDrivePublicationToolInput,
  googleDriveScopesAllowCapability,
  type GoogleDriveOutputDestination,
  type GoogleDrivePublicationReceipt as GoogleDrivePublicationReceiptValue,
  type GoogleDrivePublicationToolInput as GoogleDrivePublicationToolInputValue,
} from "@opengeni/contracts/google-drive";
import {
  beginConnectorActionExecution,
  completeConnectorActionExecution,
  getConnectionMetadata,
  getWorkspaceGrant,
  prepareConnectorActionApproval,
  requireFile,
  type ConnectorActionAttemptIdentity,
  type ConnectorActionInvocation,
  type Database,
  type ResolveConnectionCredentialInput,
  type ResolveConnectionCredentialResult,
} from "@opengeni/db";
import {
  readAuthorizedEditableArtifactMaterialization,
  type PersistedEditableArtifactMaterializationJob,
} from "@opengeni/db/editable-artifact-durable-export";
import { readResponseJsonBounded, undiciFetch, type FetchLike } from "@opengeni/network";
import type { ObjectStorage } from "@opengeni/storage";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const RESPONSE_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_PARTY_MCP_SUBJECT_ID = "worker:first-party-mcp";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class GoogleDrivePublicationAuthorizationError extends Error {}

export type GoogleDrivePublicationTarget = Readonly<{
  ownerSubjectId: string;
  connectionId: string;
  originWorkspaceId: string;
  destination: GoogleDriveOutputDestination;
  credentialScope: typeof GOOGLE_DRIVE_FILE_SCOPE | typeof GOOGLE_DRIVE_FULL_SCOPE;
}>;

export type GoogleDrivePublicationPorts = {
  getConnection: typeof getConnectionMetadata;
  getMembership: typeof getWorkspaceGrant;
  readMaterialization: typeof readAuthorizedEditableArtifactMaterialization;
  requireFile: typeof requireFile;
  prepare: typeof prepareConnectorActionApproval;
  begin: typeof beginConnectorActionExecution;
  complete: typeof completeConnectorActionExecution;
  fetch: FetchLike;
};

const defaultPorts: GoogleDrivePublicationPorts = {
  getConnection: getConnectionMetadata,
  getMembership: getWorkspaceGrant,
  readMaterialization: readAuthorizedEditableArtifactMaterialization,
  requireFile,
  prepare: prepareConnectorActionApproval,
  begin: beginConnectorActionExecution,
  complete: completeConnectorActionExecution,
  fetch: undiciFetch,
};

export async function resolveGoogleDrivePublicationTarget(
  db: Database,
  workspaceId: string,
  delegations: readonly McpPersonalConnectionDelegation[],
  ports: Pick<GoogleDrivePublicationPorts, "getConnection" | "getMembership"> = defaultPorts,
): Promise<GoogleDrivePublicationTarget | null> {
  const frozen = delegations.filter(
    (delegation) =>
      delegation.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID &&
      delegation.providerDomain.toLowerCase() === GOOGLE_DRIVE_PROVIDER_DOMAIN &&
      delegation.kind === "oauth2",
  );
  if (frozen.length !== 1) return null;
  const delegation = frozen[0]!;
  const activated = delegation.userDelegation !== undefined;
  if (!activated && !(await ports.getMembership(db, delegation.ownerSubjectId, workspaceId))) {
    return null;
  }
  const originWorkspaceId = activated ? delegation.originWorkspaceId : workspaceId;
  if (!originWorkspaceId) return null;
  const connection = await ports.getConnection(
    db,
    originWorkspaceId,
    delegation.connectionId,
    delegation.ownerSubjectId,
  );
  if (
    !connection ||
    connection.id !== delegation.connectionId ||
    connection.workspaceId !== originWorkspaceId ||
    connection.subjectId !== delegation.ownerSubjectId ||
    connection.providerDomain.toLowerCase() !== GOOGLE_DRIVE_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    connection.status !== "active" ||
    !googleDriveScopesAllowCapability(connection.grantedScopes, "publish_file")
  ) {
    return null;
  }
  const metadata = GoogleDriveConnectionMetadata.safeParse(connection.metadata);
  if (
    !metadata.success ||
    !metadata.data.outputDestination ||
    metadata.data.lifecycle?.state === "paused" ||
    (metadata.data.lifecycle && metadata.data.lifecycle.state !== "active")
  ) {
    return null;
  }
  // The destination frozen on the accepted delegation is the authority. A
  // live connection-settings change since acceptance fails the target closed
  // (personal-authority warning path) instead of silently redirecting the
  // publication; a pre-freeze delegation keeps the bounded legacy
  // live-resolution behavior.
  const frozenDestination = delegation.outputDestination;
  if (frozenDestination && !sameDestination(metadata.data.outputDestination, frozenDestination)) {
    return null;
  }
  return Object.freeze({
    ownerSubjectId: delegation.ownerSubjectId,
    connectionId: connection.id,
    originWorkspaceId,
    destination: frozenDestination ?? metadata.data.outputDestination,
    credentialScope: connection.grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)
      ? GOOGLE_DRIVE_FILE_SCOPE
      : GOOGLE_DRIVE_FULL_SCOPE,
  });
}

export function googleDrivePublicationConnectorCall(
  target: GoogleDrivePublicationTarget,
  rawRequest: unknown,
  approvalId: string,
): ConnectorActionInvocation {
  const request = GoogleDrivePublicationToolInput.parse(rawRequest);
  return {
    approvalId,
    connectionId: target.connectionId,
    serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
    toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
    arguments: {
      action: GOOGLE_DRIVE_PUBLICATION_CREATE_ACTION,
      destination: target.destination,
      artifact: {
        id: request.file.artifactId,
        versionId: request.file.versionId,
        title: request.title,
        modality: request.modality,
        sourceSha256: request.file.sha256,
      },
      canonicalReceipt: { ...request.file },
      idempotencyKeyDigest: createHash("sha256")
        .update(request.idempotencyKey, "utf8")
        .digest("hex"),
    },
  };
}

export function createGoogleDrivePublicationAttemptTool(input: {
  db: Database;
  objectStorage: ObjectStorage;
  identity: ConnectorActionAttemptIdentity;
  subjectId: string;
  target: GoogleDrivePublicationTarget;
  resolveCredential: (
    input: ResolveConnectionCredentialInput,
  ) => Promise<ResolveConnectionCredentialResult>;
  signal?: AbortSignal;
  ports?: GoogleDrivePublicationPorts;
}): AttemptToolDefinition {
  const ports = input.ports ?? defaultPorts;
  return {
    identity: {
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
    },
    modelName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
    codemodePath: ["google_drive", "publish_file"],
    title: "Publish artifact to Google Drive",
    description:
      "Publish a completed editable-artifact Office export into the configured Google Drive output folder. First call editable_artifact_export and poll editable_artifact_export_status until it returns a file receipt, then pass that exact receipt here.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 512 },
        modality: {
          type: "string",
          enum: ["document", "spreadsheet", "presentation"],
        },
        file: {
          type: "object",
          properties: {
            fileId: { type: "string", format: "uuid" },
            filename: { type: "string", minLength: 1, maxLength: 512 },
            contentType: { type: "string", minLength: 1, maxLength: 256 },
            sizeBytes: { type: "integer", minimum: 1 },
            sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            artifactId: { type: "string", pattern: "^[0-9a-f]{32}$" },
            versionId: { type: "string", pattern: "^[0-9a-f]{32}$" },
            materializationJobId: { type: "string", pattern: "^[0-9a-f]{32}$" },
            sourceHeadSequence: { type: "integer", minimum: 0 },
            sourceStateHash: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
          },
          required: [
            "fileId",
            "filename",
            "contentType",
            "sizeBytes",
            "sha256",
            "artifactId",
            "versionId",
            "materializationJobId",
            "sourceHeadSequence",
            "sourceStateHash",
          ],
          additionalProperties: false,
        },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["title", "modality", "file", "idempotencyKey"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string", format: "uuid" },
        providerFileId: { type: "string" },
        webViewLink: { type: "string", format: "uri" },
        mimeType: {
          type: "string",
          enum: [
            "application/vnd.google-apps.document",
            "application/vnd.google-apps.spreadsheet",
            "application/vnd.google-apps.presentation",
          ],
        },
        destination: {
          type: "object",
          properties: {
            folderId: { type: "string" },
            folderName: { type: "string" },
            driveId: { type: ["string", "null"] },
            location: { type: "string", enum: ["my_drive", "shared_drive"] },
            selectedAt: { type: "string" },
          },
          required: ["folderId", "folderName", "driveId", "location", "selectedAt"],
          additionalProperties: false,
        },
        replayed: { type: "boolean" },
      },
      required: [
        "connectionId",
        "providerFileId",
        "webViewLink",
        "mimeType",
        "destination",
        "replayed",
      ],
      additionalProperties: false,
    },
    annotations: {
      title: "Publish artifact to Google Drive",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    source: "mcp",
    approval: "policy",
    execute: async (raw, context) => {
      const request = GoogleDrivePublicationToolInput.parse(raw);
      const connectorCall = googleDrivePublicationConnectorCall(
        input.target,
        request,
        context.operationId,
      );
      // The durable execute-once fence is unconditional: every caller - model
      // or Codemode - registers the POST before it can happen, so a crashed
      // attempt is denied a blind replay and surfaces an unknown outcome
      // instead of a silent duplicate publication.
      const admission = await ports.begin(input.db, input.identity, connectorCall);
      if (!admission.allowed) {
        throw new Error(
          admission.reason === "uncertain_retry" || admission.reason === "already_executed"
            ? "Google Drive publication outcome is unknown: a previous attempt may have already sent this publication to Google Drive. Verify in Drive before retrying with a new idempotency key."
            : admission.reason === "not_executed"
              ? "Google Drive publication was not executed: the previous attempt failed before any request reached Google Drive. Retrying with a new call is safe."
              : `Google Drive publication was not executed: ${admission.reason}. No request reached Google Drive.`,
        );
      }
      if (!admission.managed) {
        throw new Error("Google Drive publication has no explicit connector action policy");
      }
      const requestId = admission.requestId;
      let providerRequestStarted = false;
      try {
        const receipt = await executeGoogleDrivePublication(
          {
            db: input.db,
            objectStorage: input.objectStorage,
            identity: input.identity,
            subjectId: input.subjectId,
            target: input.target,
            request,
            resolveCredential: input.resolveCredential,
            onProviderRequest: () => {
              providerRequestStarted = true;
            },
            ...((context.signal ?? input.signal) ? { signal: context.signal ?? input.signal } : {}),
          },
          ports,
        );
        if (requestId) {
          await ports.complete(input.db, {
            accountId: input.identity.accountId,
            workspaceId: input.identity.workspaceId,
            requestId,
            attemptId: input.identity.attemptId,
            outcome: "completed",
          });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        };
      } catch (error) {
        if (requestId) {
          await ports.complete(input.db, {
            accountId: input.identity.accountId,
            workspaceId: input.identity.workspaceId,
            requestId,
            attemptId: input.identity.attemptId,
            outcome: providerRequestStarted ? "uncertain" : "not_executed",
          });
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          providerRequestStarted
            ? `Google Drive publication outcome is unknown: a provider request may have been sent before the failure. Verify in Drive before retrying. Cause: ${detail}`
            : `Google Drive publication was not executed: no request reached Google Drive. Cause: ${detail}`,
          { cause: error },
        );
      }
    },
  };
}

export async function authorizeGoogleDrivePublicationAttempt(input: {
  db: Database;
  identity: ConnectorActionAttemptIdentity;
  target: GoogleDrivePublicationTarget;
  approvalId: string;
  arguments: unknown;
  ports?: Pick<GoogleDrivePublicationPorts, "prepare">;
}): Promise<void> {
  const request = GoogleDrivePublicationToolInput.parse(input.arguments);
  const preparation = await (input.ports ?? defaultPorts).prepare(
    input.db,
    input.identity,
    googleDrivePublicationConnectorCall(input.target, request, input.approvalId),
  );
  if (!preparation.managed) {
    throw new Error("Google Drive publication has no explicit connector action policy");
  }
  if (preparation.decision === "ask") throw new AttemptToolApprovalRequiredError();
  if (preparation.decision === "block") {
    throw new Error("Google Drive publication is blocked by connector action policy");
  }
}

export async function executeGoogleDrivePublication(
  input: {
    db: Database;
    objectStorage: ObjectStorage;
    identity: ConnectorActionAttemptIdentity;
    subjectId: string;
    target: GoogleDrivePublicationTarget;
    request: GoogleDrivePublicationToolInputValue;
    resolveCredential: (
      input: ResolveConnectionCredentialInput,
    ) => Promise<ResolveConnectionCredentialResult>;
    signal?: AbortSignal;
    /** Invoked immediately before the first provider request is sent. */
    onProviderRequest?: () => void;
  },
  ports: Pick<
    GoogleDrivePublicationPorts,
    "getConnection" | "readMaterialization" | "requireFile" | "fetch"
  > = defaultPorts,
): Promise<GoogleDrivePublicationReceiptValue> {
  const request = GoogleDrivePublicationToolInput.parse(input.request);
  const connection = await ports.getConnection(
    input.db,
    input.target.originWorkspaceId,
    input.target.connectionId,
    input.subjectId,
  );
  if (!connection || connection.subjectId !== input.subjectId) {
    throw new Error("Google Drive publication connection is unavailable");
  }
  assertPublicationConnection(input, connection);
  const materialization = await ports.readMaterialization(input.db, {
    scope: {
      accountId: input.identity.accountId,
      workspaceId: input.identity.workspaceId,
    },
    artifactId: request.file.artifactId,
    jobId: request.file.materializationJobId,
    actor: {
      kind: "agent",
      subjectId: FIRST_PARTY_MCP_SUBJECT_ID,
      replicaId: publicationActorReplicaId(input.identity),
      sessionId: input.identity.sessionId,
      turnId: input.identity.turnId,
      attemptId: input.identity.attemptId,
      generation: input.identity.executionGeneration,
    },
  });
  assertCanonicalMaterialization(input.identity, request, materialization);
  const expected = expectedExportWorkspaceFile(input.identity.workspaceId, request);
  if (request.file.fileId !== expected.fileId) {
    throw new Error("Google Drive publication requires a canonical editable-artifact export file");
  }
  const sourceFile = await ports.requireFile(
    input.db,
    input.identity.workspaceId,
    request.file.fileId,
  );
  if (
    sourceFile.status !== "ready" ||
    sourceFile.id !== expected.fileId ||
    sourceFile.safeFilename !== expected.safeFilename ||
    sourceFile.objectKey !== expected.objectKey ||
    sourceFile.filename !== request.file.filename ||
    sourceFile.contentType !== request.file.contentType ||
    sourceFile.sizeBytes !== request.file.sizeBytes ||
    sourceFile.sha256 !== request.file.sha256
  ) {
    throw new Error("Editable artifact export file differs from its canonical receipt");
  }
  const bytes = await input.objectStorage.getFileBytes(sourceFile);
  if (
    bytes.byteLength !== request.file.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== request.file.sha256
  ) {
    throw new Error("Editable artifact export bytes failed verification");
  }
  const authorizedFetch: FetchLike = async (url, init) => {
    const destinationUrl = url instanceof Request ? url.url : url.toString();
    const credential = await input.resolveCredential({
      workspaceId: input.identity.workspaceId,
      subjectId: input.subjectId,
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
      connectionRef: {
        providerDomain: GOOGLE_DRIVE_PROVIDER_DOMAIN,
        connectionId: input.target.connectionId,
        kind: "oauth2",
        subjectScope: "subject",
        scopes: [input.target.credentialScope],
      },
      destinationUrl,
      forceRefresh: false,
    });
    if (credential.status !== "ok" || credential.connectionId !== input.target.connectionId) {
      throw new GoogleDrivePublicationAuthorizationError(
        "Google Drive publication credential is unavailable",
      );
    }
    const resolvedConnection = await ports.getConnection(
      input.db,
      input.target.originWorkspaceId,
      input.target.connectionId,
      input.subjectId,
    );
    if (!resolvedConnection) {
      throw new GoogleDrivePublicationAuthorizationError(
        "Google Drive publication authority changed; retry on a new turn",
      );
    }
    try {
      assertPublicationConnection(input, resolvedConnection);
    } catch (error) {
      throw new GoogleDrivePublicationAuthorizationError(
        error instanceof Error ? error.message : "Google Drive publication authority changed",
      );
    }
    if (credential.authorizeProviderRequest) {
      let authorized = false;
      try {
        authorized = await credential.authorizeProviderRequest();
      } catch {
        authorized = false;
      }
      if (!authorized) {
        throw new GoogleDrivePublicationAuthorizationError(
          "Google Drive publication authority changed; retry on a new turn",
        );
      }
    }
    const headers = new Headers(credential.headers);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    // Past this point a provider request may reach Google: any later failure
    // is an unknown outcome, never a safe retry.
    input.onProviderRequest?.();
    return await ports.fetch(url, { ...init, headers });
  };
  return await publishToGoogleDrive({
    workspaceId: input.identity.workspaceId,
    connectionId: input.target.connectionId,
    destination: input.target.destination,
    request,
    bytes,
    fetchImpl: authorizedFetch,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function assertPublicationConnection(
  input: { subjectId: string; target: GoogleDrivePublicationTarget },
  connection: NonNullable<Awaited<ReturnType<typeof getConnectionMetadata>>>,
): void {
  const metadata = GoogleDriveConnectionMetadata.parse(connection.metadata);
  const credentialScope = connection.grantedScopes.includes(GOOGLE_DRIVE_FILE_SCOPE)
    ? GOOGLE_DRIVE_FILE_SCOPE
    : GOOGLE_DRIVE_FULL_SCOPE;
  if (
    input.subjectId !== input.target.ownerSubjectId ||
    connection.id !== input.target.connectionId ||
    connection.workspaceId !== input.target.originWorkspaceId ||
    connection.subjectId !== input.target.ownerSubjectId ||
    connection.providerDomain.toLowerCase() !== GOOGLE_DRIVE_PROVIDER_DOMAIN ||
    connection.kind !== "oauth2" ||
    connection.status !== "active" ||
    metadata.lifecycle?.state === "paused" ||
    (metadata.lifecycle && metadata.lifecycle.state !== "active") ||
    !googleDriveScopesAllowCapability(connection.grantedScopes, "publish_file") ||
    credentialScope !== input.target.credentialScope ||
    !metadata.outputDestination ||
    !sameDestination(metadata.outputDestination, input.target.destination)
  ) {
    throw new Error("Google Drive publication authority changed; retry on a new turn");
  }
}

function publicationActorReplicaId(identity: ConnectorActionAttemptIdentity): string {
  const value = createHash("sha256")
    .update(
      `google-drive-publication:${identity.sessionId}:${identity.turnId}:${identity.attemptId}:${identity.executionGeneration}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return /^0+$/u.test(value) ? `1${value.slice(1)}` : value;
}

function assertCanonicalMaterialization(
  identity: ConnectorActionAttemptIdentity,
  request: GoogleDrivePublicationToolInputValue,
  job: PersistedEditableArtifactMaterializationJob | null,
): void {
  const format = officeFormat(request.modality, request.file.contentType);
  if (
    !job ||
    job.scope.accountId !== identity.accountId ||
    job.scope.workspaceId !== identity.workspaceId ||
    job.artifactId !== request.file.artifactId ||
    job.id !== request.file.materializationJobId ||
    job.versionId !== request.file.versionId ||
    job.targetHeadSequence !== request.file.sourceHeadSequence ||
    job.stateHash !== request.file.sourceStateHash ||
    job.format !== format ||
    job.state !== "succeeded" ||
    !job.result ||
    job.result.byteSize !== request.file.sizeBytes ||
    job.result.mimeType !== request.file.contentType ||
    job.result.contentHash !== `sha256:${request.file.sha256}`
  ) {
    throw new Error("Google Drive publication receipt differs from its canonical materialization");
  }
}

function expectedExportWorkspaceFile(
  workspaceId: string,
  request: GoogleDrivePublicationToolInputValue,
): { fileId: string; safeFilename: string; objectKey: string } {
  const format = officeFormat(request.modality, request.file.contentType);
  const fileId = deterministicUuid(
    `editable-artifact-export:file:${workspaceId}:${request.file.artifactId}:${request.file.versionId}:${request.file.materializationJobId}`,
  );
  const safeFilename = `artifact-${request.file.artifactId}-${request.file.materializationJobId}.${format}`;
  return {
    fileId,
    safeFilename,
    objectKey: `workspaces/${workspaceId}/files/${fileId}/artifact-exports/${safeFilename}`,
  };
}

function officeFormat(
  modality: GoogleDrivePublicationToolInputValue["modality"],
  contentType: string,
): "docx" | "xlsx" | "pptx" {
  const expected = {
    document: {
      format: "docx" as const,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    spreadsheet: {
      format: "xlsx" as const,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
    presentation: {
      format: "pptx" as const,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  }[modality];
  if (contentType !== expected.contentType) {
    throw new Error("Google Drive native publication requires the matching Office export format");
  }
  return expected.format;
}

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID_PATTERN.test(value)) throw new Error("Generated workspace file identity is invalid");
  return value;
}

async function publishToGoogleDrive(input: {
  workspaceId: string;
  connectionId: string;
  destination: GoogleDriveOutputDestination;
  request: GoogleDrivePublicationToolInputValue;
  bytes: Uint8Array;
  fetchImpl: FetchLike;
  signal?: AbortSignal;
}): Promise<GoogleDrivePublicationReceiptValue> {
  await verifyDestinationAtWriteTime(input);
  const operationKey = publicationOperationKey(input);
  const existing = await findExistingPublication(input, operationKey);
  if (existing) return driveReceipt(input, existing, true);

  const mimeType = googleNativeMime(input.request.modality);
  const boundary = `opengeni_${operationKey.slice(0, 32)}`;
  const metadata = JSON.stringify({
    name: input.request.title,
    mimeType,
    parents: [input.destination.folderId],
    appProperties: {
      opengeniPublicationKey: operationKey,
      opengeniArtifactId: input.request.file.artifactId,
      opengeniArtifactVersionId: input.request.file.versionId,
      opengeniSourceSha256: input.request.file.sha256,
    },
  });
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${input.request.file.contentType}\r\n\r\n`,
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
): Promise<void> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(input.destination.folderId)}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "id,name,mimeType,driveId,trashed,capabilities(canAddChildren)");
  const folder = record(await requestJson(input.fetchImpl, url, {}));
  const capabilities = record(folder.capabilities);
  if (
    folder.id !== input.destination.folderId ||
    folder.name !== input.destination.folderName ||
    folder.mimeType !== DRIVE_FOLDER_MIME ||
    folder.trashed === true ||
    capabilities.canAddChildren !== true ||
    (folder.driveId ?? null) !== input.destination.driveId
  ) {
    throw new Error("Google Drive output destination changed or is no longer writable");
  }
}

async function findExistingPublication(
  input: Parameters<typeof publishToGoogleDrive>[0],
  operationKey: string,
): Promise<DriveFile | null> {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set(
    "q",
    `trashed = false and '${driveQuery(input.destination.folderId)}' in parents and appProperties has { key='opengeniPublicationKey' and value='${operationKey}' }`,
  );
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  if (input.destination.driveId) {
    url.searchParams.set("corpora", "drive");
    url.searchParams.set("driveId", input.destination.driveId);
  } else {
    url.searchParams.set("corpora", "user");
  }
  url.searchParams.set(
    "fields",
    "files(id,name,mimeType,parents,driveId,webViewLink,appProperties,trashed)",
  );
  const payload = record(await requestJson(input.fetchImpl, url, {}));
  const files = Array.isArray(payload.files) ? payload.files.map(parseDriveFile) : [];
  if (files.length > 1) throw new Error("Google Drive publication idempotency marker is ambiguous");
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
    file.parents[0] !== input.destination.folderId ||
    file.driveId !== input.destination.driveId ||
    file.appProperties.opengeniPublicationKey !== operationKey ||
    file.appProperties.opengeniArtifactId !== input.request.file.artifactId ||
    file.appProperties.opengeniArtifactVersionId !== input.request.file.versionId ||
    file.appProperties.opengeniSourceSha256 !== input.request.file.sha256
  ) {
    throw new Error("Google Drive publication idempotency key conflicts with another file");
  }
}

function driveReceipt(
  input: Parameters<typeof publishToGoogleDrive>[0],
  file: DriveFile,
  replayed: boolean,
): GoogleDrivePublicationReceiptValue {
  return GoogleDrivePublicationReceipt.parse({
    connectionId: input.connectionId,
    providerFileId: file.id,
    webViewLink: file.webViewLink,
    mimeType: googleNativeMime(input.request.modality),
    destination: input.destination,
    replayed,
  });
}

function publicationOperationKey(input: Parameters<typeof publishToGoogleDrive>[0]): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        destination: input.destination,
        artifactId: input.request.file.artifactId,
        versionId: input.request.file.versionId,
        materializationJobId: input.request.file.materializationJobId,
        sourceSha256: input.request.file.sha256,
        idempotencyKey: input.request.idempotencyKey,
      }),
      "utf8",
    )
    .digest("hex");
}

function googleNativeMime(
  modality: GoogleDrivePublicationToolInputValue["modality"],
): GoogleDrivePublicationReceiptValue["mimeType"] {
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
  left: GoogleDriveOutputDestination,
  right: GoogleDriveOutputDestination,
): boolean {
  return (
    left.folderId === right.folderId &&
    left.folderName === right.folderName &&
    left.driveId === right.driveId &&
    left.location === right.location &&
    left.selectedAt === right.selectedAt
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
  } catch (error) {
    if (error instanceof GoogleDrivePublicationAuthorizationError) throw error;
    throw new Error("Google Drive publication transport failed", { cause: error });
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
