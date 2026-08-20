import { afterAll, describe, expect, mock, test } from "bun:test";
import type { FileAsset } from "@opengeni/contracts";
import {
  TOOL_RESULT_SPILL_MEDIA_TYPE,
  toolResultSpillFilename,
  toolResultSpillSandboxPath,
} from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import type { Database } from "@opengeni/db";

const fakeDb = {};
const filesById = new Map<string, FileAsset>();
const putObjectCalls: Array<{ key: string; body: Uint8Array }> = [];
let mutationCalls = 0;

const realDb = await import("@opengeni/db");
const realDbFns = {
  prepareGeneratedWorkspaceFile: realDb.prepareGeneratedWorkspaceFile,
  completeFileUpload: realDb.completeFileUpload,
  getFile: realDb.getFile,
};
mock.module("@opengeni/db", () => ({
  ...realDb,
  prepareGeneratedWorkspaceFile: mock(
    async (db: unknown, input: Parameters<typeof realDb.prepareGeneratedWorkspaceFile>[1]) => {
      if (db !== fakeDb) {
        return await realDbFns.prepareGeneratedWorkspaceFile(db as Database, input);
      }
      const existing = filesById.get(input.fileId);
      if (existing) {
        return { created: false, uploadId: input.uploadId, file: existing };
      }
      const pending: FileAsset = {
        id: input.fileId,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        status: "pending_upload",
        filename: input.filename,
        safeFilename: input.safeFilename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256 ?? null,
        bucket: input.bucket,
        objectKey: input.objectKey,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
      };
      filesById.set(input.fileId, pending);
      return { created: true, uploadId: input.uploadId, file: pending };
    },
  ),
  completeFileUpload: mock(async (db: unknown, workspaceId: string, uploadId: string) => {
    if (db !== fakeDb) {
      return await realDbFns.completeFileUpload(db as Database, workspaceId, uploadId);
    }
    const pending = [...filesById.values()].find((file) => file.status === "pending_upload");
    if (!pending) throw new Error("missing pending file");
    const ready = { ...pending, status: "ready" as const };
    filesById.set(ready.id, ready);
    return ready;
  }),
  getFile: mock(async (db: unknown, workspaceId: string, fileId: string) => {
    if (db !== fakeDb) return await realDbFns.getFile(db as Database, workspaceId, fileId);
    return filesById.get(fileId) ?? null;
  }),
}));

const { ToolResultSpill, toolResultSpillIdentity } =
  await import("../src/activities/agent-turn/tool-result-spill");

afterAll(() => {
  mock.restore();
});

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function objectStorage(): ObjectStorage {
  return {
    bucket: "test-bucket",
    fileExists: async () => false,
    putObject: async (args) => {
      putObjectCalls.push({ key: args.key, body: args.body });
    },
    createGetUrl: async () => ({
      url: "https://example.test/tool-result",
      expiresAt: new Date("2026-08-19T01:00:00.000Z"),
    }),
  } as ObjectStorage;
}

function spill(
  backend: Settings["sandboxBackend"],
  storage: ObjectStorage | null = objectStorage(),
) {
  return new ToolResultSpill({
    db: fakeDb as Database,
    objectStorage: storage,
    observability: { warn: () => undefined } as never,
    accountId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WORKSPACE_ID,
    attemptId: ATTEMPT_ID,
    getModelRunSettings: () => ({ sandboxBackend: backend }) as Settings,
    getSandboxFileDownloadBackend: () => backend,
    getPublish: () => null,
    toolCancellationFenceRef: { current: null },
    getResolvedSandbox: () => null,
    getSetupBoxSession: () => null,
    getSdkOwnedSandboxSession: () => null,
    getSandboxGroupId: () => null,
    runWorkspaceMutation: async (_sandbox, _operation, mutation) => {
      mutationCalls += 1;
      return await mutation();
    },
  });
}

describe("tool result spill identity", () => {
  test("is deterministic for the same attempt operation", () => {
    const first = toolResultSpillIdentity({
      workspaceId: WORKSPACE_ID,
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
    });
    const second = toolResultSpillIdentity({
      workspaceId: WORKSPACE_ID,
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
    });
    expect(first).toEqual(second);
    expect(first.fileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.uploadId).not.toBe(first.fileId);
    expect(
      toolResultSpillIdentity({
        workspaceId: WORKSPACE_ID,
        attemptId: ATTEMPT_ID,
        operationId: OPERATION_ID.toUpperCase(),
      }),
    ).toEqual(first);
  });

  test("changes when operationId changes", () => {
    const first = toolResultSpillIdentity({
      workspaceId: WORKSPACE_ID,
      attemptId: ATTEMPT_ID,
      operationId: OPERATION_ID,
    });
    const second = toolResultSpillIdentity({
      workspaceId: WORKSPACE_ID,
      attemptId: ATTEMPT_ID,
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    expect(second.fileId).not.toBe(first.fileId);
    expect(second.uploadId).not.toBe(first.uploadId);
  });
});

describe("tool result spill port", () => {
  test("persists one File without rematerializing when there is no sandbox", async () => {
    filesById.clear();
    putObjectCalls.length = 0;
    mutationCalls = 0;
    const result = {
      content: [{ type: "text" as const, text: "huge" }],
      structuredContent: { tree: "x".repeat(64) },
    };
    const port = spill("none");
    const projected = await port.spill({ operationId: OPERATION_ID, result });
    expect(projected.isError).toBe(false);
    expect(projected.structuredContent).toMatchObject({
      type: "tool_result_spilled",
      sandboxPath: null,
      mediaType: TOOL_RESULT_SPILL_MEDIA_TYPE,
    });
    expect(putObjectCalls).toHaveLength(1);
    expect(Buffer.from(putObjectCalls[0]!.body).toString()).toBe(JSON.stringify(result));
    expect(mutationCalls).toBe(0);
    expect(port.receiptsCreatedThisTurn.size).toBe(1);
    const stored = [...port.receiptsCreatedThisTurn.values()][0]!;
    expect(stored.sandboxPath).toBe(
      toolResultSpillSandboxPath(toolResultSpillFilename(OPERATION_ID)),
    );

    const again = await port.spill({ operationId: OPERATION_ID, result });
    expect(again.structuredContent).toMatchObject({
      type: "tool_result_spilled",
      fileId: (projected.structuredContent as { fileId: string }).fileId,
    });
    expect(putObjectCalls).toHaveLength(1);
  });

  test("fails closed without putting the payload in the result when storage is missing", async () => {
    const port = spill("none", null);
    await expect(
      port.spill({
        operationId: OPERATION_ID,
        result: { content: [{ type: "text", text: "huge" }] },
      }),
    ).rejects.toThrow(/object storage/);
  });
});
