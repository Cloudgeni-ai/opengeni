import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { testSettings } from "@opengeni/testing";
import type { FileAsset } from "@opengeni/contracts";
import type { PublishEditableArtifactReceipt } from "@opengeni/contracts/editable-artifact-publication";
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_FULL_SCOPE } from "@opengeni/contracts/google-drive";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import {
  executeGoogleDriveEditableArtifactPublication,
  googleDrivePublicationConnectorCall,
  type GoogleDrivePublicationPorts,
} from "../src/activities/google-drive-publication";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const connectionId = "66666666-6666-4666-8666-666666666666";
const fileId = "77777777-7777-4777-8777-777777777777";
const sourceBytes = new TextEncoder().encode("verified docx source");
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

const request = {
  path: "/workspace/final.docx",
  title: "Final report",
  modality: "document" as const,
  googleDrive: {
    connectionId,
    destination: {
      folderId: "folder-1",
      folderName: "Product",
      driveId: null,
      location: "my_drive" as const,
    },
    idempotencyKey: "final-report-v1",
  },
};

const artifact: PublishEditableArtifactReceipt = {
  type: "editable_artifact",
  schemaVersion: 1,
  artifact: { id: "a".repeat(32), modality: "document", title: request.title },
  sourceFile: {
    id: fileId,
    filename: "final.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: sourceBytes.byteLength,
    sha256: sourceSha256,
  },
  editorPath: `/workspaces/${workspaceId}/artifacts/editable/${"a".repeat(32)}`,
};

const sourceFile: FileAsset = {
  id: fileId,
  workspaceId,
  status: "ready",
  filename: "final.docx",
  safeFilename: "final.docx",
  contentType: artifact.sourceFile.contentType,
  sizeBytes: sourceBytes.byteLength,
  sha256: sourceSha256,
  bucket: "files",
  objectKey: "files/final.docx",
  createdAt: new Date("2026-08-10T00:00:00.000Z"),
  updatedAt: new Date("2026-08-10T00:00:00.000Z"),
};

function baseInput() {
  return {
    db: {} as Database,
    objectStorage: {
      async getFileBytes() {
        return sourceBytes.slice();
      },
    } as ObjectStorage,
    settings: testSettings(),
    identity: {
      accountId,
      workspaceId,
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 1,
      initiator: { kind: "human" as const, subjectId: "subject-a" },
    },
    subjectId: "subject-a",
    toolCallId: "call-drive-publication",
    request,
    artifact,
  };
}

function connection(
  overrides: {
    grantedScopes?: string[];
    accessMode?: "file_only" | "readonly";
  } = {},
) {
  return {
    id: connectionId,
    accountId,
    workspaceId,
    subjectId: "subject-a",
    providerDomain: "googleapis.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: overrides.grantedScopes ?? [GOOGLE_DRIVE_FILE_SCOPE],
    version: 3,
    metadata: {
      credentialRole: "google_drive_metadata",
      credentialLabel: "Google Drive metadata browser",
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
      outputDestination: {
        ...request.googleDrive.destination,
        selectedAt: "2026-08-10T00:00:00.000Z",
      },
    },
  };
}

describe("Google Drive editable artifact publication", () => {
  test("binds approval to the exact connector, destination, and hashed idempotency key", () => {
    const call = googleDrivePublicationConnectorCall(request, "call-1");
    expect(call).toMatchObject({
      approvalId: "call-1",
      connectionId,
      serverId: "google-drive-publishing",
      toolName: "publish_editable_artifact",
      arguments: {
        action: "create",
        destination: request.googleDrive.destination,
        artifact: { title: "Final report", modality: "document" },
      },
    });
    expect(JSON.stringify(call.arguments)).not.toContain(request.googleDrive.idempotencyKey);
  });

  test("blocks before credential or provider access", async () => {
    let credentialCalls = 0;
    let providerCalls = 0;
    await expect(
      executeGoogleDriveEditableArtifactPublication(baseInput(), {
        getConnection: async () => connection() as never,
        requireFile: async () => sourceFile,
        begin: async () => ({
          allowed: false,
          managed: true,
          reason: "blocked",
          requestId: "request-blocked",
          actionFingerprint: "f".repeat(64),
        }),
        complete: async () => {},
        resolveCredential: async () => {
          credentialCalls += 1;
          return {} as never;
        },
        fetch: async () => {
          providerCalls += 1;
          return new Response();
        },
      }),
    ).rejects.toThrow("was not executed: blocked");
    expect(credentialCalls).toBe(0);
    expect(providerCalls).toBe(0);
  });

  test("creates once and a retry converges through the provider idempotency marker", async () => {
    let providerFile: Record<string, unknown> | null = null;
    let createCalls = 0;
    const completions: string[] = [];
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
          name: "Final report",
          mimeType: "application/vnd.google-apps.document",
          parents: ["folder-1"],
          driveId: null,
          webViewLink: "https://docs.google.com/document/d/drive-file-1/edit",
          appProperties: {
            opengeniPublicationKey: operationKey,
            opengeniArtifactId: artifact.artifact.id,
            opengeniSourceSha256: artifact.sourceFile.sha256,
          },
          trashed: false,
        };
        return Response.json(providerFile);
      }
      return new Response("not found", { status: 404 });
    };
    const ports: GoogleDrivePublicationPorts = {
      getConnection: async () => connection() as never,
      requireFile: async () => sourceFile,
      begin: async () => ({
        allowed: true,
        managed: true,
        requestId: `request-${completions.length + 1}`,
        actionFingerprint: "f".repeat(64),
      }),
      complete: async (_db: Database, input: { outcome: string }) => {
        completions.push(input.outcome);
      },
      resolveCredential: async (_db, _settings, input) => {
        credentialScopes.push(input.connectionRef.scopes);
        return {
          status: "ok",
          headers: { authorization: "Bearer token" },
          connectionId,
          connectionVersion: 3,
          expiresAt: null,
        } as never;
      },
      fetch,
    };
    const created = await executeGoogleDriveEditableArtifactPublication(baseInput(), ports);
    const replayed = await executeGoogleDriveEditableArtifactPublication(baseInput(), ports);
    const fullDriveReplay = await executeGoogleDriveEditableArtifactPublication(baseInput(), {
      ...ports,
      getConnection: async () =>
        connection({ grantedScopes: [GOOGLE_DRIVE_FULL_SCOPE], accessMode: "readonly" }) as never,
    });
    expect(created).toMatchObject({ providerFileId: "drive-file-1", replayed: false });
    expect(replayed).toMatchObject({ providerFileId: "drive-file-1", replayed: true });
    expect(fullDriveReplay).toMatchObject({ providerFileId: "drive-file-1", replayed: true });
    expect(createCalls).toBe(1);
    expect(completions).toEqual(["completed", "completed", "completed"]);
    expect(credentialScopes).toEqual([
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FILE_SCOPE],
      [GOOGLE_DRIVE_FULL_SCOPE],
    ]);
  });
});
