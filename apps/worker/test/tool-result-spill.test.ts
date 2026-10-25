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
type SpillPort = InstanceType<typeof ToolResultSpill>;

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
  live: {
    resolved?: () => unknown;
    setupSession?: () => unknown;
    sdkOwnedSession?: () => unknown;
    provisioner?: { get(): Promise<unknown> };
  } = {},
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
    getResolvedSandbox: () => (live.resolved?.() ?? null) as never,
    getSetupBoxSession: () => live.setupSession?.() ?? null,
    getSdkOwnedSandboxSession: () => live.sdkOwnedSession?.() ?? null,
    getSandboxGroupId: () => null,
    getTurnSandboxProvisioner: () => live.provisioner ?? null,
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

type ExecCall = { cmd: string; workdir?: string };

function shellSession(root: string, exitCode = 0) {
  const calls: ExecCall[] = [];
  return {
    calls,
    session: {
      state: { manifest: { root } },
      exec: async (input: ExecCall) => {
        calls.push(input);
        return { output: "", stdout: "", stderr: "", wallTimeSeconds: 0, exitCode };
      },
    },
  };
}

function resolvedSandbox(session: unknown) {
  return {
    established: { instanceId: "instance-1", session },
    leaseEpoch: 1,
  };
}

describe("tool result spill receipt path", () => {
  const shellPath = `tool-results/${OPERATION_ID}.json`;
  const result = {
    content: [{ type: "text" as const, text: "huge" }],
    structuredContent: { tree: "x".repeat(64) },
  };

  /** A lazy turn sandbox whose start runs the spill's deferred copy, as the real hook does. */
  function lazySandbox(port: () => SpillPort, exitCode = 0, startError?: Error) {
    const state: { live: ReturnType<typeof shellSession> | null; starts: number } = {
      live: null,
      starts: 0,
    };
    return {
      state,
      routes: {
        resolved: () => (state.live ? resolvedSandbox(state.live.session) : null),
        setupSession: () => state.live?.session ?? null,
        provisioner: {
          get: async () => {
            state.starts += 1;
            if (startError) throw startError;
            state.live ??= shellSession("/workspace", exitCode);
            await port().materializeDeferred();
            return resolvedSandbox(state.live.session);
          },
        },
      },
    };
  }

  test("a spill before the lazy sandbox starts joins it and is copied before the receipt returns", async () => {
    filesById.clear();
    mutationCalls = 0;
    let port: SpillPort;
    const sandbox = lazySandbox(() => port);
    port = spill("modal", objectStorage(), sandbox.routes);
    const receipt = await port.spill({ operationId: OPERATION_ID, result });
    expect(receipt.structuredContent).toMatchObject({
      type: "tool_result_spilled",
      sandboxPath: shellPath,
    });
    expect(JSON.parse((receipt.content[0] as { text: string }).text).sandboxPath).toBe(shellPath);
    // The file is already in the shell's working directory, copied once by the
    // sandbox start, so the path holds in this and any later shell command.
    expect(sandbox.state.starts).toBe(1);
    expect(mutationCalls).toBe(1);
    expect(sandbox.state.live!.calls).toHaveLength(1);
    expect(sandbox.state.live!.calls[0]!.workdir).toBe("/workspace");
    expect(sandbox.state.live!.calls[0]!.cmd).toContain(shellPath);
  });

  test("a lazy sandbox that cannot start or copy gives no path", async () => {
    filesById.clear();
    let failingStart: SpillPort;
    const unstartable = lazySandbox(() => failingStart, 0, new Error("provision failed"));
    failingStart = spill("modal", objectStorage(), unstartable.routes);
    const notStarted = await failingStart.spill({ operationId: OPERATION_ID, result });
    expect((notStarted.structuredContent as { sandboxPath: string | null }).sandboxPath).toBeNull();

    filesById.clear();
    let failingCopy: SpillPort;
    const broken = lazySandbox(() => failingCopy, 1);
    failingCopy = spill("modal", objectStorage(), broken.routes);
    const notCopied = await failingCopy.spill({ operationId: OPERATION_ID, result });
    expect((notCopied.structuredContent as { sandboxPath: string | null }).sandboxPath).toBeNull();
    // The start's copy failed, and the spill retried it once before saying null.
    expect(broken.state.live!.calls).toHaveLength(2);
  });

  test("without a lazy sandbox boundary a not-yet-ready SDK-owned sandbox gives no path", async () => {
    filesById.clear();
    let owned: ReturnType<typeof shellSession> | null = null;
    const port = spill("docker", objectStorage(), { sdkOwnedSession: () => owned?.session });
    const receipt = await port.spill({ operationId: OPERATION_ID, result });
    expect((receipt.structuredContent as { sandboxPath: string | null }).sandboxPath).toBeNull();
    // A ready SDK-owned sandbox gets the copy and the path.
    owned = shellSession("/workspace");
    filesById.clear();
    const ready = await port.spill({ operationId: OPERATION_ID, result });
    expect((ready.structuredContent as { sandboxPath: string }).sandboxPath).toBe(shellPath);
    expect(owned.calls.at(-1)!.cmd).toContain(shellPath);
  });

  test("no sandbox backend means no shell will ever have the file", async () => {
    filesById.clear();
    const port = spill("none");
    const receipt = await port.spill({ operationId: OPERATION_ID, result });
    expect((receipt.structuredContent as { sandboxPath: string | null }).sandboxPath).toBeNull();
  });

  test("a Connected Machine copies into its working directory and reports the cwd-relative path", async () => {
    filesById.clear();
    mutationCalls = 0;
    const machine = shellSession("/Users/someone/projects/app");
    const port = spill("selfhosted", objectStorage(), {
      resolved: () => resolvedSandbox(machine.session),
      setupSession: () => machine.session,
    });
    const receipt = await port.spill({ operationId: OPERATION_ID, result });
    expect((receipt.structuredContent as { sandboxPath: string }).sandboxPath).toBe(shellPath);
    expect(mutationCalls).toBe(1);
    expect(machine.calls).toHaveLength(1);
    expect(machine.calls[0]!.workdir).toBe("/Users/someone/projects/app");
    expect(machine.calls[0]!.cmd).toContain(shellPath);
    expect(machine.calls[0]!.cmd).not.toContain("/workspace/");
  });

  test("a failed copy into a live sandbox reports no path", async () => {
    filesById.clear();
    const machine = shellSession("/Users/someone/projects/app", 1);
    const port = spill("selfhosted", objectStorage(), {
      resolved: () => resolvedSandbox(machine.session),
      setupSession: () => machine.session,
    });
    const receipt = await port.spill({ operationId: OPERATION_ID, result });
    expect((receipt.structuredContent as { sandboxPath: string | null }).sandboxPath).toBeNull();
  });
});
