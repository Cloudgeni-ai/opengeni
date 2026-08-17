import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AttemptToolApprovalRequiredError } from "@opengeni/codemode";
import type { FileAsset } from "@opengeni/contracts";
import {
  GOOGLE_DRIVE_FILE_SCOPE,
  GOOGLE_DRIVE_FULL_SCOPE,
  GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
  type GoogleDrivePublicationToolInput,
} from "@opengeni/contracts/google-drive";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import {
  authorizeGoogleDrivePublicationAttempt,
  createGoogleDrivePublicationAttemptTool,
  executeGoogleDrivePublication,
  googleDrivePublicationConnectorCall,
  resolveGoogleDrivePublicationTarget,
  type GoogleDrivePublicationPorts,
  type GoogleDrivePublicationTarget,
} from "../src/activities/google-drive-publication";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const connectionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "a".repeat(32);
const versionId = "b".repeat(32);
const jobId = "c".repeat(32);
const sourceBytes = new TextEncoder().encode("verified docx source");
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const fileId = deterministicUuid(
  `editable-artifact-export:file:${workspaceId}:${artifactId}:${versionId}:${jobId}`,
);
const safeFilename = `artifact-${artifactId}-${jobId}.docx`;
const destination = {
  folderId: "folder-1",
  folderName: "Product",
  driveId: null,
  location: "my_drive" as const,
  selectedAt: "2026-08-10T00:00:00.000Z",
};
const target: GoogleDrivePublicationTarget = {
  ownerSubjectId: "subject-a",
  connectionId,
  originWorkspaceId: workspaceId,
  destination,
  credentialScope: GOOGLE_DRIVE_FILE_SCOPE,
};
const request: GoogleDrivePublicationToolInput = {
  title: "Final report",
  modality: "document",
  idempotencyKey: "final-report-v1",
  file: {
    fileId,
    filename: "final.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: sourceBytes.byteLength,
    sha256: sourceSha256,
    artifactId,
    versionId,
    materializationJobId: jobId,
    sourceHeadSequence: 12,
    sourceStateHash: `sha256:${"d".repeat(64)}`,
  },
};
const sourceFile: FileAsset = {
  id: fileId,
  workspaceId,
  status: "ready",
  filename: request.file.filename,
  safeFilename,
  contentType: request.file.contentType,
  sizeBytes: sourceBytes.byteLength,
  sha256: sourceSha256,
  bucket: "files",
  objectKey: `workspaces/${workspaceId}/files/${fileId}/artifact-exports/${safeFilename}`,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};
const identity = {
  accountId,
  workspaceId,
  sessionId,
  turnId,
  attemptId,
  executionGeneration: 1,
  initiator: { kind: "human" as const, subjectId: "subject-a" },
};
const publicationDelegation = {
  serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
  connectionId,
  ownerSubjectId: "subject-a",
  providerDomain: "googleapis.com",
  kind: "oauth2" as const,
};

function materialization(overrides: Record<string, unknown> = {}) {
  return {
    scope: { accountId, workspaceId },
    artifactId,
    id: jobId,
    versionId,
    inputSnapshotId: "e".repeat(32),
    targetHeadSequence: request.file.sourceHeadSequence,
    stateHash: request.file.sourceStateHash,
    format: "docx",
    state: "succeeded",
    attemptCount: 1,
    errorCode: null,
    createdAt: "2026-08-10T00:00:00.000Z",
    startedAt: "2026-08-10T00:00:01.000Z",
    completedAt: "2026-08-10T00:00:02.000Z",
    result: {
      id: "f".repeat(32),
      byteSize: sourceBytes.byteLength,
      contentHash: `sha256:${sourceSha256}`,
      mimeType: request.file.contentType,
      verifiedAt: "2026-08-10T00:00:02.000Z",
      createdAt: "2026-08-10T00:00:02.000Z",
    },
    ...overrides,
  };
}

function connection(
  overrides: {
    grantedScopes?: string[];
    accessMode?: "file_only" | "readonly";
    version?: number;
    workspaceId?: string;
  } = {},
) {
  return {
    id: connectionId,
    accountId,
    workspaceId: overrides.workspaceId ?? workspaceId,
    subjectId: "subject-a",
    providerDomain: "googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: overrides.grantedScopes ?? [GOOGLE_DRIVE_FILE_SCOPE],
    version: overrides.version ?? 3,
    metadata: {
      credentialRole: "google_drive_metadata",
      credentialLabel: "Google Drive read-only source sync",
      googlePermissionId: "permission-a",
      googleEmail: "drive@example.com",
      googleDisplayName: "Drive Tester",
      verifiedAt: "2026-08-10T00:00:00.000Z",
      accessMode: overrides.accessMode ?? "file_only",
      lifecycle: {
        state: "active",
        recoverable: true,
        observedAt: "2026-08-10T00:00:00.000Z",
      },
      outputDestination: destination,
    },
  };
}

function executionPorts(
  fetch: GoogleDrivePublicationPorts["fetch"],
): Pick<
  GoogleDrivePublicationPorts,
  "getConnection" | "readMaterialization" | "requireFile" | "fetch"
> {
  return {
    getConnection: async () => connection() as never,
    readMaterialization: async (_db, input) => {
      expect(input).toMatchObject({
        scope: { accountId, workspaceId },
        artifactId,
        jobId,
        actor: {
          kind: "agent",
          subjectId: "worker:first-party-mcp",
          sessionId,
          turnId,
          attemptId,
          generation: 1,
        },
      });
      return materialization() as never;
    },
    requireFile: async () => sourceFile,
    fetch,
  };
}

function objectStorage(): ObjectStorage {
  return {
    async getFileBytes() {
      return sourceBytes.slice();
    },
  } as ObjectStorage;
}

describe("Google Drive editable artifact publication", () => {
  test("discovers only an active subject-owned write connection with an explicit destination", async () => {
    const resolved = await resolveGoogleDrivePublicationTarget(
      {} as Database,
      workspaceId,
      [publicationDelegation],
      {
        getMembership: async () => ({}) as never,
        getConnection: async () => connection() as never,
      },
    );
    expect(resolved).toEqual(target);
    expect(
      await resolveGoogleDrivePublicationTarget(
        {} as Database,
        workspaceId,
        [publicationDelegation],
        {
          getMembership: async () => ({}) as never,
          getConnection: async () =>
            connection({
              grantedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
            }) as never,
        },
      ),
    ).toBeNull();
    expect(
      await resolveGoogleDrivePublicationTarget(
        {} as Database,
        workspaceId,
        [publicationDelegation],
        {
          getMembership: async () => null,
          getConnection: async () => {
            throw new Error("must not read a connection after membership revocation");
          },
        },
      ),
    ).toBeNull();
    expect(
      await resolveGoogleDrivePublicationTarget(
        {} as Database,
        workspaceId,
        [publicationDelegation, publicationDelegation],
        {
          getMembership: async () => ({}) as never,
          getConnection: async () => connection() as never,
        },
      ),
    ).toBeNull();
  });

  test("routes an activated same-organization publication through its frozen physical origin", async () => {
    const originWorkspaceId = "77777777-7777-4777-8777-777777777777";
    let membershipReads = 0;
    const resolved = await resolveGoogleDrivePublicationTarget(
      {} as Database,
      workspaceId,
      [
        {
          ...publicationDelegation,
          originWorkspaceId,
          userDelegation: {
            organizationId: accountId,
            authorityId: "88888888-8888-4888-8888-888888888888",
            authorityGeneration: 1,
            workspaceId,
            sessionId: null,
            action: "connection.use",
            mode: "always",
            context: "workspace_shared",
            authorityEpoch: null,
            grantId: "99999999-9999-4999-8999-999999999999",
            grantGeneration: 1,
          },
        },
      ],
      {
        getMembership: async () => {
          membershipReads += 1;
          return null;
        },
        getConnection: async (_db, requestedWorkspaceId) => {
          expect(requestedWorkspaceId).toBe(originWorkspaceId);
          return connection({ workspaceId: originWorkspaceId }) as never;
        },
      },
    );
    expect(resolved).toEqual({ ...target, originWorkspaceId });
    expect(membershipReads).toBe(0);
  });

  test("binds approval to the private connector target and hashes the idempotency key", () => {
    const call = googleDrivePublicationConnectorCall(target, request, "call-1");
    expect(call).toMatchObject({
      approvalId: "call-1",
      connectionId,
      serverId: GOOGLE_DRIVE_PUBLICATION_SERVER_ID,
      toolName: GOOGLE_DRIVE_PUBLICATION_TOOL_NAME,
      arguments: {
        action: "create",
        destination,
        artifact: { id: artifactId, versionId, title: "Final report", modality: "document" },
        canonicalReceipt: request.file,
      },
    });
    expect(JSON.stringify(call.arguments)).not.toContain(request.idempotencyKey);
  });

  test("Codemode Ask interrupts before execution and Block fails closed", async () => {
    await expect(
      authorizeGoogleDrivePublicationAttempt({
        db: {} as Database,
        identity,
        target,
        approvalId: "operation-ask",
        arguments: request,
        ports: { prepare: async () => ({ managed: true, decision: "ask" }) },
      }),
    ).rejects.toBeInstanceOf(AttemptToolApprovalRequiredError);
    await expect(
      authorizeGoogleDrivePublicationAttempt({
        db: {} as Database,
        identity,
        target,
        approvalId: "operation-block",
        arguments: request,
        ports: { prepare: async () => ({ managed: true, decision: "block" }) },
      }),
    ).rejects.toThrow("blocked by connector action policy");
  });

  test("rejects a noncanonical workspace file before credential or provider access", async () => {
    let credentialCalls = 0;
    let providerCalls = 0;
    await expect(
      executeGoogleDrivePublication(
        {
          db: {} as Database,
          objectStorage: objectStorage(),
          identity,
          subjectId: "subject-a",
          target,
          request: { ...request, file: { ...request.file, fileId: crypto.randomUUID() } },
          resolveCredential: async () => {
            credentialCalls += 1;
            return {} as never;
          },
        },
        executionPorts(async () => {
          providerCalls += 1;
          return new Response();
        }),
      ),
    ).rejects.toThrow("canonical editable-artifact export file");
    expect(credentialCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("rejects altered materialization provenance before credential or provider access", async () => {
    let credentialCalls = 0;
    let providerCalls = 0;
    await expect(
      executeGoogleDrivePublication(
        {
          db: {} as Database,
          objectStorage: objectStorage(),
          identity,
          subjectId: "subject-a",
          target,
          request: {
            ...request,
            file: { ...request.file, sourceHeadSequence: request.file.sourceHeadSequence + 1 },
          },
          resolveCredential: async () => {
            credentialCalls += 1;
            return {} as never;
          },
        },
        {
          ...executionPorts(async () => {
            providerCalls += 1;
            return new Response();
          }),
          readMaterialization: async () => materialization() as never,
        },
      ),
    ).rejects.toThrow("canonical materialization");
    expect(credentialCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("creates once and a retry converges through the provider idempotency marker", async () => {
    let providerFile: Record<string, unknown> | null = null;
    let createCalls = 0;
    let providerAuthorizations = 0;
    const credentialScopes: Array<string[] | undefined> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/drive/v3/files/folder-1") {
        return Response.json({
          id: "folder-1",
          name: "Product",
          mimeType: "application/vnd.google-apps.folder",
          driveId: null,
          trashed: false,
          capabilities: { canAddChildren: true },
        });
      }
      if (url.pathname === "/drive/v3/files") {
        return Response.json({ files: providerFile ? [providerFile] : [] });
      }
      if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
        createCalls += 1;
        const body = new TextDecoder().decode(init.body as Uint8Array);
        const operationKey = body.match(/"opengeniPublicationKey":"([0-9a-f]{64})"/u)?.[1];
        expect(operationKey).toBeTruthy();
        providerFile = {
          id: "drive-file-1",
          name: request.title,
          mimeType: "application/vnd.google-apps.document",
          parents: [destination.folderId],
          driveId: null,
          webViewLink: "https://docs.google.com/document/d/drive-file-1/edit",
          appProperties: {
            opengeniPublicationKey: operationKey,
            opengeniArtifactId: artifactId,
            opengeniArtifactVersionId: versionId,
            opengeniSourceSha256: sourceSha256,
          },
          trashed: false,
        };
        return Response.json(providerFile);
      }
      return new Response("not found", { status: 404 });
    };
    const execute = async (publicationTarget = target) =>
      await executeGoogleDrivePublication(
        {
          db: {} as Database,
          objectStorage: objectStorage(),
          identity,
          subjectId: "subject-a",
          target: publicationTarget,
          request,
          resolveCredential: async (input) => {
            credentialScopes.push(input.connectionRef.scopes);
            return {
              status: "ok",
              headers: { authorization: "Bearer token" },
              connectionId,
              connectionVersion: 3,
              expiresAt: null,
              authorizeProviderRequest: async () => {
                providerAuthorizations += 1;
                return true;
              },
            } as never;
          },
        },
        {
          ...executionPorts(fetch),
          getConnection: async () =>
            connection({
              grantedScopes:
                publicationTarget.credentialScope === GOOGLE_DRIVE_FULL_SCOPE
                  ? [GOOGLE_DRIVE_FULL_SCOPE]
                  : [GOOGLE_DRIVE_FILE_SCOPE],
            }) as never,
        },
      );
    const created = await execute();
    const replayed = await execute();
    const fullDriveReplay = await execute({ ...target, credentialScope: GOOGLE_DRIVE_FULL_SCOPE });
    expect(created).toMatchObject({ providerFileId: "drive-file-1", replayed: false });
    expect(replayed).toMatchObject({ providerFileId: "drive-file-1", replayed: true });
    expect(fullDriveReplay).toMatchObject({ providerFileId: "drive-file-1", replayed: true });
    expect(createCalls).toBe(1);
    expect(providerAuthorizations).toBe(credentialScopes.length);
    expect(credentialScopes).toEqual([
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FULL_SCOPE],
      [GOOGLE_DRIVE_FULL_SCOPE],
    ]);
  });

  test("accepts host-brokered credentials without a version across a token refresh", async () => {
    let connectionReads = 0;
    let providerFile: Record<string, unknown> | null = null;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/drive/v3/files/folder-1") {
        return Response.json({
          id: destination.folderId,
          name: destination.folderName,
          mimeType: "application/vnd.google-apps.folder",
          driveId: null,
          trashed: false,
          capabilities: { canAddChildren: true },
        });
      }
      if (url.pathname === "/drive/v3/files") {
        return Response.json({ files: providerFile ? [providerFile] : [] });
      }
      if (url.pathname === "/upload/drive/v3/files" && init?.method === "POST") {
        const body = new TextDecoder().decode(init.body as Uint8Array);
        const operationKey = body.match(/"opengeniPublicationKey":"([0-9a-f]{64})"/u)?.[1];
        providerFile = {
          id: "drive-file-refreshed",
          name: request.title,
          mimeType: "application/vnd.google-apps.document",
          parents: [destination.folderId],
          driveId: null,
          webViewLink: "https://docs.google.com/document/d/drive-file-refreshed/edit",
          appProperties: {
            opengeniPublicationKey: operationKey,
            opengeniArtifactId: artifactId,
            opengeniArtifactVersionId: versionId,
            opengeniSourceSha256: sourceSha256,
          },
          trashed: false,
        };
        return Response.json(providerFile);
      }
      return new Response("not found", { status: 404 });
    };
    const receipt = await executeGoogleDrivePublication(
      {
        db: {} as Database,
        objectStorage: objectStorage(),
        identity,
        subjectId: "subject-a",
        target,
        request,
        resolveCredential: async () => ({
          status: "ok",
          headers: { authorization: "Bearer host-owned" },
          connectionId,
        }),
      },
      {
        ...executionPorts(fetch),
        getConnection: async () => {
          connectionReads += 1;
          return connection({ version: connectionReads === 1 ? 3 : 4 }) as never;
        },
      },
    );
    expect(receipt).toMatchObject({ providerFileId: "drive-file-refreshed", replayed: false });
    expect(connectionReads).toBe(4);
  });

  test("reauthorizes before every physical request and stops after mid-publication revocation", async () => {
    let credentialCalls = 0;
    let providerCalls = 0;
    const originWorkspaceId = "77777777-7777-4777-8777-777777777777";
    await expect(
      executeGoogleDrivePublication(
        {
          db: {} as Database,
          objectStorage: objectStorage(),
          identity,
          subjectId: "subject-a",
          target: { ...target, originWorkspaceId },
          request,
          resolveCredential: async () => {
            credentialCalls += 1;
            if (credentialCalls === 2) {
              return {
                status: "auth_needed",
                reason: "personal_authority_unavailable",
                providerDomain: "googleapis.com",
              };
            }
            return {
              status: "ok",
              headers: { authorization: "Bearer exact-use" },
              connectionId,
              connectionVersion: 3,
              expiresAt: null,
            } as never;
          },
        },
        {
          ...executionPorts(async (url) => {
            providerCalls += 1;
            expect(new URL(url.toString()).pathname).toBe("/drive/v3/files/folder-1");
            return Response.json({
              id: destination.folderId,
              name: destination.folderName,
              mimeType: "application/vnd.google-apps.folder",
              driveId: null,
              trashed: false,
              capabilities: { canAddChildren: true },
            });
          }),
          getConnection: async (_db, requestedWorkspaceId) => {
            expect(requestedWorkspaceId).toBe(originWorkspaceId);
            return connection({ workspaceId: originWorkspaceId }) as never;
          },
        },
      ),
    ).rejects.toThrow("credential is unavailable");
    expect(credentialCalls).toBe(2);
    expect(providerCalls).toBe(1);
  });

  test("rejects a local authority change after credential resolution before provider access", async () => {
    let connectionReads = 0;
    let providerCalls = 0;
    await expect(
      executeGoogleDrivePublication(
        {
          db: {} as Database,
          objectStorage: objectStorage(),
          identity,
          subjectId: "subject-a",
          target,
          request,
          resolveCredential: async () => ({
            status: "ok",
            headers: { authorization: "Bearer refreshed" },
            connectionId,
          }),
        },
        {
          ...executionPorts(async () => {
            providerCalls += 1;
            return new Response();
          }),
          getConnection: async () => {
            connectionReads += 1;
            return {
              ...connection({ version: connectionReads }),
              status: connectionReads === 1 ? "active" : "revoked",
            } as never;
          },
        },
      ),
    ).rejects.toThrow("authority changed");
    expect(connectionReads).toBe(2);
    expect(providerCalls).toBe(0);
  });

  test("attempt tool executes Codemode only after durable begin and completes the request", async () => {
    const completions: string[] = [];
    const tool = createGoogleDrivePublicationAttemptTool({
      db: {} as Database,
      objectStorage: objectStorage(),
      identity,
      subjectId: "subject-a",
      target,
      resolveCredential: async () =>
        ({
          status: "ok",
          headers: { authorization: "Bearer token" },
          connectionId,
          connectionVersion: 3,
          expiresAt: null,
        }) as never,
      ports: {
        getConnection: async () => connection() as never,
        getMembership: async () => ({}) as never,
        readMaterialization: async () => materialization() as never,
        requireFile: async () => sourceFile,
        prepare: async () => ({ managed: true, decision: "allow" }),
        begin: async () => ({ allowed: false, managed: true, requestId: "r", reason: "blocked" }),
        complete: async (_db, completion) => {
          completions.push(completion.outcome);
        },
        fetch: async () => new Response("must not call provider", { status: 500 }),
      },
    });
    await expect(
      tool.execute(request, {
        operationId: "99999999-9999-4999-8999-999999999999",
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toThrow("was not executed: blocked");
    expect(completions).toEqual([]);
  });

  test("a frozen delegation destination overrides live metadata and fail-closes on drift", async () => {
    const frozenDelegation = { ...publicationDelegation, outputDestination: destination };
    // Frozen matches live: resolves to the frozen destination.
    expect(
      await resolveGoogleDrivePublicationTarget({} as Database, workspaceId, [frozenDelegation], {
        getMembership: async () => ({}) as never,
        getConnection: async () => connection() as never,
      }),
    ).toEqual(target);
    // The owner re-pointed the connection at a different folder after
    // acceptance: the already-accepted turn must not publish anywhere.
    const moved = connection();
    (moved.metadata as { outputDestination: typeof destination }).outputDestination = {
      ...destination,
      folderId: "folder-moved",
      folderName: "Elsewhere",
      selectedAt: "2026-08-16T00:00:00.000Z",
    };
    expect(
      await resolveGoogleDrivePublicationTarget({} as Database, workspaceId, [frozenDelegation], {
        getMembership: async () => ({}) as never,
        getConnection: async () => moved as never,
      }),
    ).toBeNull();
    // A pre-freeze delegation keeps the bounded legacy live resolution.
    expect(
      await resolveGoogleDrivePublicationTarget(
        {} as Database,
        workspaceId,
        [publicationDelegation],
        {
          getMembership: async () => ({}) as never,
          getConnection: async () => moved as never,
        },
      ),
    ).toEqual({
      ...target,
      destination: (moved.metadata as { outputDestination: typeof destination }).outputDestination,
    });
  });

  test("model callers never double-register the fence the wrapper already owns", async () => {
    let begins = 0;
    const completions: string[] = [];
    const tool = createGoogleDrivePublicationAttemptTool({
      db: {} as Database,
      objectStorage: objectStorage(),
      identity,
      subjectId: "subject-a",
      target,
      resolveCredential: async () => ({ status: "auth_needed" }) as never,
      ports: {
        getConnection: async () => connection() as never,
        getMembership: async () => ({}) as never,
        readMaterialization: async () => materialization() as never,
        requireFile: async () => sourceFile,
        prepare: async () => ({ managed: true, decision: "allow" }),
        begin: async () => {
          begins += 1;
          return { allowed: true, managed: true, requestId: "must-not-exist" };
        },
        complete: async (_db, completion) => {
          completions.push(completion.outcome);
        },
        fetch: async () => new Response("must not call provider", { status: 500 }),
      },
    });
    // The attempt connector-action wrapper already registered this model call
    // under its durable SDK call id; a second inner begin would mint a second
    // ledger row and deadlock the default ask policy.
    await expect(
      tool.execute(request, {
        operationId: "99999999-9999-4999-8999-999999999999",
        caller: { kind: "model", subjectId: "agent:test" },
      }),
    ).rejects.toThrow("was not executed: no request reached Google Drive");
    expect(begins).toBe(0);
    expect(completions).toEqual([]);
  });

  test("a failure before any provider request completes not_executed with a retry-safe message", async () => {
    const completions: string[] = [];
    const tool = createGoogleDrivePublicationAttemptTool({
      db: {} as Database,
      objectStorage: objectStorage(),
      identity,
      subjectId: "subject-a",
      target,
      resolveCredential: async () => ({ status: "auth_needed" }) as never,
      ports: {
        getConnection: async () => connection() as never,
        getMembership: async () => ({}) as never,
        readMaterialization: async () => materialization() as never,
        requireFile: async () => sourceFile,
        prepare: async () => ({ managed: true, decision: "allow" }),
        begin: async () => ({ allowed: true, managed: true, requestId: "req-1" }),
        complete: async (_db, completion) => {
          completions.push(completion.outcome);
        },
        fetch: async () => new Response("must not call provider", { status: 500 }),
      },
    });
    await expect(
      tool.execute(request, {
        operationId: "99999999-9999-4999-8999-999999999999",
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toThrow("was not executed: no request reached Google Drive");
    expect(completions).toEqual(["not_executed"]);
  });

  test("a failure after the provider request started completes uncertain with an unknown-outcome message", async () => {
    const completions: string[] = [];
    const tool = createGoogleDrivePublicationAttemptTool({
      db: {} as Database,
      objectStorage: objectStorage(),
      identity,
      subjectId: "subject-a",
      target,
      resolveCredential: async () =>
        ({
          status: "ok",
          headers: { authorization: "Bearer token" },
          connectionId,
          connectionVersion: 3,
          expiresAt: null,
        }) as never,
      ports: {
        getConnection: async () => connection() as never,
        getMembership: async () => ({}) as never,
        readMaterialization: async () => materialization() as never,
        requireFile: async () => sourceFile,
        prepare: async () => ({ managed: true, decision: "allow" }),
        begin: async () => ({ allowed: true, managed: true, requestId: "req-2" }),
        complete: async (_db, completion) => {
          completions.push(completion.outcome);
        },
        // Read-only verify and idempotency-lookup GETs succeed; the first
        // mutating request (the multipart create POST) dies mid-upload.
        fetch: async (url, init) => {
          const method = (init?.method ?? "GET").toUpperCase();
          if (method === "GET") {
            const href = url instanceof Request ? url.url : url.toString();
            return href.includes("/files/")
              ? Response.json({
                  id: destination.folderId,
                  name: destination.folderName,
                  mimeType: "application/vnd.google-apps.folder",
                  trashed: false,
                  capabilities: { canAddChildren: true },
                })
              : Response.json({ files: [] });
          }
          throw new Error("socket reset mid-upload");
        },
      },
    });
    await expect(
      tool.execute(request, {
        operationId: "99999999-9999-4999-8999-999999999999",
        caller: { kind: "codemode", subjectId: "agent:test" },
      }),
    ).rejects.toThrow("outcome is unknown");
    expect(completions).toEqual(["uncertain"]);
  });
});
