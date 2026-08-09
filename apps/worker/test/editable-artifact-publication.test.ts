import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { verifyDelegatedAccessToken, type FileAsset } from "@opengeni/contracts";
import type { Database, PrepareEditableArtifactSourceFileInput } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash } from "node:crypto";

import { executeEditableArtifactPublication } from "../src/activities/editable-artifact-publication";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const turnId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const artifactId = "a".repeat(32);
const sourceBytes = new TextEncoder().encode("final-office-source");
const snapshotBytes = new TextEncoder().encode("native-canonical-snapshot");
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function preparedPublication() {
  return {
    schemaVersion: 1 as const,
    modality: "document" as const,
    source: {
      byteSize: sourceBytes.byteLength,
      contentHash: digest(sourceBytes),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const,
    },
    snapshot: {
      modality: "document" as const,
      byteSize: snapshotBytes.byteLength,
      contentHash: digest(snapshotBytes),
      mimeType: "application/vnd.opengeni.editable-artifact-snapshot" as const,
      coveredHeadSequence: 0 as const,
      stateHash: `sha256:${"c".repeat(64)}`,
      modelSchemaVersion: 1 as const,
      kernelVersion: "kernel-test",
      nativeRevision: 3,
    },
  };
}

type Stored = {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  version: string;
};

function storageFixture() {
  const objects = new Map<string, Stored>();
  const signedUploads = new Map<string, { key: string; contentType: string; sha256: string }>();
  let signedCounter = 0;
  let versionCounter = 0;
  const store = (key: string, bytes: Uint8Array, contentType: string, sha256: string) => {
    versionCounter += 1;
    objects.set(key, {
      bytes: bytes.slice(),
      contentType,
      sha256,
      version: `version-${versionCounter}`,
    });
  };
  const storage = {
    bucket: "test-bucket",
    backend: "s3-compatible",
    maxSinglePutSizeBytes: 5_000_000_000,
    async createPutUrl(input: { key: string; contentType: string; sha256?: string | null }) {
      signedCounter += 1;
      const url = `https://upload.test/${signedCounter}`;
      signedUploads.set(url, {
        key: input.key,
        contentType: input.contentType,
        sha256: input.sha256 ?? "",
      });
      return { url, requiredHeaders: { "content-type": input.contentType }, expiresAt: new Date() };
    },
    async createGetUrl() {
      throw new Error("not used");
    },
    async headFile(file: FileAsset) {
      const object = objects.get(file.objectKey);
      if (!object) return {};
      return {
        ContentLength: object.bytes.byteLength,
        ContentType: object.contentType,
        Metadata: { sha256: object.sha256 },
        VersionToken: object.version,
      };
    },
    async fileExists(file: FileAsset) {
      return objects.has(file.objectKey);
    },
    async getFileBytes(file: FileAsset) {
      return objects.get(file.objectKey)?.bytes.slice() ?? new Uint8Array();
    },
    async getFileRange() {
      throw new Error("not used");
    },
    async getObjectBytes(key: string) {
      const object = objects.get(key);
      return object ? { bytes: object.bytes.slice(), contentType: object.contentType } : null;
    },
    async headObject(key: string) {
      const object = objects.get(key);
      return object
        ? {
            ContentLength: object.bytes.byteLength,
            ContentType: object.contentType,
            Metadata: { sha256: object.sha256 },
            VersionToken: object.version,
          }
        : null;
    },
    async getObjectRange(input: {
      key: string;
      start: number;
      endInclusive: number;
      expectedVersionToken: string;
    }) {
      const object = objects.get(input.key);
      if (!object || object.version !== input.expectedVersionToken) return null;
      return {
        bytes: object.bytes.slice(input.start, input.endInclusive + 1),
        versionToken: object.version,
      };
    },
    async putObject(input: {
      key: string;
      contentType: string;
      body: Uint8Array;
      sha256?: string | null;
    }) {
      store(input.key, input.body, input.contentType, input.sha256 ?? "");
    },
    async putObjectIfAbsent(input: {
      key: string;
      contentType: string;
      body: Uint8Array;
      sha256: string;
    }) {
      if (objects.has(input.key)) return false;
      store(input.key, input.body, input.contentType, input.sha256);
      return true;
    },
    async putObjectStreamIfAbsent(input: {
      key: string;
      contentType: string;
      chunks: AsyncIterable<Uint8Array>;
      sha256: string;
    }) {
      if (objects.has(input.key)) return false;
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.chunks) chunks.push(chunk.slice());
      store(input.key, Buffer.concat(chunks), input.contentType, input.sha256);
      return true;
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
  } as ObjectStorage;
  return {
    storage,
    objects,
    signedUploads,
    upload(url: string, bytes: Uint8Array) {
      const intent = signedUploads.get(url);
      if (!intent) throw new Error(`unknown signed upload: ${url}`);
      store(intent.key, bytes, intent.contentType, intent.sha256);
    },
    get signedCount() {
      return signedCounter;
    },
  };
}

describe("editable artifact publication operation", () => {
  test("streams one exact snapshot, retains its Office source, and converges on replay", async () => {
    const fixture = storageFixture();
    let file: FileAsset | null = null;
    let uploadId: string | null = null;
    let prepareCalls = 0;
    let completeCalls = 0;
    const apiRequests: Array<Record<string, unknown>> = [];
    const commands: string[] = [];
    const input = {
      db: {} as Database,
      objectStorage: fixture.storage,
      sandboxObjectStorage: fixture.storage,
      settings: testSettings({
        delegationSecret: "publication-test-secret",
        opengeniMcpUrl: "http://api.test/v1/workspaces/{workspaceId}/mcp",
      }),
      accountId,
      workspaceId,
      sessionId,
      turnId,
      attemptId,
      executionGeneration: 7,
      toolCallId: "call-publication-1",
      request: {
        path: "/workspace/final.docx",
        title: "Final report",
        modality: "document" as const,
      },
      runtimeEntrypoint: "/opt/opengeni/artifact-runtime/skill-facade-entry.mjs",
      async runCommand(command: { cmd: string; workdir: string; maxOutputTokens: number }) {
        commands.push(command.cmd);
        if (command.cmd.includes(" prepare-publication ")) {
          return { stdout: `${JSON.stringify(preparedPublication())}\n`, stderr: "", exitCode: 0 };
        }
        for (const [url] of fixture.signedUploads) {
          if (!command.cmd.includes(url)) continue;
          fixture.upload(url, command.cmd.includes(".snapshot") ? snapshotBytes : sourceBytes);
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        throw new Error("unexpected sandbox command");
      },
    };
    const ports = {
      async prepareSourceFile(_db: Database, prepared: PrepareEditableArtifactSourceFileInput) {
        prepareCalls += 1;
        if (!file) {
          uploadId = prepared.uploadId;
          file = {
            id: prepared.fileId,
            workspaceId,
            status: "pending_upload",
            filename: prepared.filename,
            safeFilename: prepared.safeFilename,
            contentType: prepared.contentType,
            sizeBytes: prepared.sizeBytes,
            sha256: prepared.sha256,
            bucket: prepared.bucket,
            objectKey: prepared.objectKey,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
          };
          return { file, uploadId: prepared.uploadId, created: true };
        }
        return { file, uploadId: uploadId!, created: false };
      },
      async completeSourceFile(
        _db: Database,
        receivedWorkspaceId: string,
        receivedUploadId: string,
      ) {
        expect(receivedWorkspaceId).toBe(workspaceId);
        expect(receivedUploadId).toBe(uploadId);
        completeCalls += 1;
        file = { ...file!, status: "ready" };
        return file;
      },
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          `http://api.test/v1/workspaces/${workspaceId}/editable-artifacts/imports`,
        );
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toStartWith("Bearer ogd_");
        const claims = await verifyDelegatedAccessToken(
          "publication-test-secret",
          authorization!.slice("Bearer ".length),
        );
        expect(claims).toMatchObject({
          accountId,
          workspaceId,
          principalKind: "agent_attempt",
          sessionId,
          turnId,
          attemptId,
          executionGeneration: 7,
          permissions: ["artifacts:publish", "files:read"],
        });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        apiRequests.push(body);
        return new Response(
          JSON.stringify({
            id: artifactId,
            modality: "document",
            title: "Final report",
            lifecycle: "active",
            headSequence: 0,
            stateHash: preparedPublication().snapshot.stateHash,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      },
    };

    const first = await executeEditableArtifactPublication(input, ports);
    const signedAfterFirst = fixture.signedCount;
    const second = await executeEditableArtifactPublication(input, ports);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      type: "editable_artifact",
      schemaVersion: 1,
      artifact: { id: artifactId, modality: "document", title: "Final report" },
      sourceFile: { sizeBytes: sourceBytes.byteLength },
      editorPath: `/workspaces/${workspaceId}/artifacts/editable/${artifactId}`,
    });
    expect(prepareCalls).toBe(2);
    expect(completeCalls).toBe(1);
    expect(fixture.signedCount).toBe(signedAfterFirst);
    expect(apiRequests).toHaveLength(2);
    expect(apiRequests[0]).toEqual(apiRequests[1]);
    expect(apiRequests[0]).toMatchObject({
      modality: "document",
      sourceFileId: first.sourceFile.id,
      snapshot: {
        blobReference: `editable-artifacts/snapshots/sha256/${digest(snapshotBytes).slice(7)}`,
        contentHash: digest(snapshotBytes),
      },
    });
    expect(commands.filter((command) => command.includes(" prepare-publication "))).toHaveLength(2);
    expect(
      [...fixture.objects.keys()].filter((key) => key.includes("publication-staging")),
    ).toEqual([]);

    await expect(
      executeEditableArtifactPublication(input, {
        ...ports,
        fetch: async () =>
          new Response(
            JSON.stringify({
              id: artifactId,
              modality: "document",
              title: "Different report",
              lifecycle: "active",
              headSequence: 0,
              stateHash: preparedPublication().snapshot.stateHash,
              createdAt: "2026-08-09T00:00:00.000Z",
              updatedAt: "2026-08-09T00:00:00.000Z",
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      }),
    ).rejects.toThrow("mismatched metadata");
    expect(fixture.signedCount).toBe(signedAfterFirst);
  });

  test("rejects a source/snapshot modality mismatch before retaining bytes", async () => {
    const fixture = storageFixture();
    await expect(
      executeEditableArtifactPublication(
        {
          db: {} as Database,
          objectStorage: fixture.storage,
          sandboxObjectStorage: fixture.storage,
          settings: testSettings({ delegationSecret: "publication-test-secret" }),
          accountId,
          workspaceId,
          sessionId,
          turnId,
          attemptId,
          executionGeneration: 1,
          toolCallId: "call-mismatch",
          request: {
            path: "/workspace/final.pptx",
            title: "Deck",
            modality: "presentation",
          },
          runtimeEntrypoint: "/opt/opengeni/artifact-runtime/skill-facade-entry.mjs",
          async runCommand() {
            return {
              stdout: `${JSON.stringify(preparedPublication())}\n`,
              stderr: "",
              exitCode: 0,
            };
          },
        },
        {
          async prepareSourceFile() {
            throw new Error("must not prepare");
          },
          async completeSourceFile() {
            throw new Error("must not complete");
          },
          async fetch() {
            throw new Error("must not fetch");
          },
        },
      ),
    ).rejects.toThrow("modality changed");
    expect(fixture.objects.size).toBe(0);
  });
});
