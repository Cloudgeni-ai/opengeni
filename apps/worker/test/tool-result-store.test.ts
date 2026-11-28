import { afterAll, describe, expect, mock, test } from "bun:test";
import type { AttemptToolExecutionContext } from "@opengeni/codemode";
import type { AttemptToolResult, FileAsset } from "@opengeni/contracts";
import { TOOL_RESULT_STORED_META_KEY, type ToolResultStoredReceipt } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import type { ObjectStorage } from "@opengeni/storage";
import type { Database } from "@opengeni/db";
import {
  projectAttemptToolResultForCaller,
  storeOversizedFunctionToolOutput,
  wrapAttemptToolDefinitions,
} from "@opengeni/runtime";

const fakeDb = {};
const filesById = new Map<string, FileAsset>();
const objects = new Map<string, Uint8Array>();
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
        workspaceId: WORKSPACE_ID,
        status: "pending_upload",
        filename: input.filename,
        safeFilename: input.safeFilename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256 ?? null,
        bucket: input.bucket,
        objectKey: input.objectKey,
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
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

const { ToolResultStore, toolResultStoreIdentity } =
  await import("../src/activities/agent-turn/tool-result-store");
const { createToolResultReadAttemptToolDefinition, readStoredToolResultSlice } =
  await import("../src/activities/agent-turn/tool-result-read-tool");

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
      objects.set(args.key, Uint8Array.from(args.body as Uint8Array));
    },
    getObjectBytes: async (key) => {
      const bytes = objects.get(key);
      return bytes ? { bytes, contentType: "text/plain" } : null;
    },
    createGetUrl: async () => ({
      url: "https://example.test/tool-result",
      expiresAt: new Date("2026-11-19T01:00:00.000Z"),
    }),
  } as ObjectStorage;
}

function toolResultStore(
  backend: Settings["sandboxBackend"],
  live: { resolved?: () => unknown; setupSession?: () => unknown; sdkOwned?: () => unknown } = {},
) {
  const store = new ToolResultStore({
    db: fakeDb as Database,
    objectStorage: objectStorage(),
    observability: { warn: () => undefined } as never,
    accountId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WORKSPACE_ID,
    attemptId: ATTEMPT_ID,
    getModelRunSettings: () =>
      ({ sandboxBackend: backend, modelToolOutputTruncationTokens: 25_000 }) as Settings,
    getSandboxFileDownloadBackend: () => backend,
    getPublish: () => null,
    toolCancellationFenceRef: { current: null },
    getResolvedSandbox: () => (live.resolved?.() ?? null) as never,
    getSetupBoxSession: () => live.setupSession?.() ?? null,
    getSdkOwnedSandboxSession: () => live.sdkOwned?.() ?? null,
    getSandboxGroupId: () => null,
    runWorkspaceMutation: async (_sandbox, _operation, mutation) => {
      mutationCalls += 1;
      return await mutation();
    },
  });
  store.setReaders({ reader: "searchable", shell: backend !== "none" });
  return store;
}

function lines(bytes: number, prefix = "row"): string {
  const parts: string[] = [];
  let size = 0;
  for (let index = 0; size < bytes; index += 1) {
    const line = `${prefix} ${index.toString().padStart(7, "0")} ✓ ${"payload ".repeat(4)}\n`;
    parts.push(line);
    size += Buffer.byteLength(line);
  }
  return parts.join("");
}

const modelCall: AttemptToolExecutionContext = {
  operationId: OPERATION_ID,
  caller: { kind: "model", subjectId: "worker:mcp-model" },
};

function textOf(result: AttemptToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Reads a stored result the way a model would: call after call until the end. */
async function readAll(
  reader: ReturnType<typeof createToolResultReadAttemptToolDefinition>,
  resultId: string,
  offset: number,
): Promise<{ text: string; calls: number }> {
  let text = "";
  let calls = 0;
  let next: number | null = offset;
  while (next !== null) {
    calls += 1;
    const read = await reader.execute({ resultId, offset: next }, modelCall);
    expect(read.isError).toBeUndefined();
    const body = textOf(read);
    const header = body.match(/^\[Opengeni: bytes (\d+) to (\d+) of (\d+)\]\n/);
    expect(header).not.toBeNull();
    const footer = body.lastIndexOf("\n[Opengeni: ");
    text += body.slice(header![0].length, footer);
    const continuation = body.slice(footer).match(/"offset":(\d+)\}\]$/);
    next = continuation ? Number(continuation[1]) : null;
    if (next !== null) expect(next).toBe(Number(header![2]));
  }
  return { text, calls };
}

describe("tool result store", () => {
  test("identity is deterministic per attempt and result key", () => {
    const first = toolResultStoreIdentity({
      workspaceId: WORKSPACE_ID,
      attemptId: ATTEMPT_ID,
      key: { kind: "operation", operationId: OPERATION_ID },
    });
    expect(
      toolResultStoreIdentity({
        workspaceId: WORKSPACE_ID,
        attemptId: ATTEMPT_ID,
        key: { kind: "operation", operationId: OPERATION_ID.toUpperCase() },
      }),
    ).toEqual(first);
    expect(
      toolResultStoreIdentity({
        workspaceId: WORKSPACE_ID,
        attemptId: ATTEMPT_ID,
        key: { kind: "call", callId: OPERATION_ID },
      }).fileId,
    ).not.toBe(first.fileId);
  });

  test("a 300 KB result is stored whole and fully readable with tool_result_read, without a sandbox", async () => {
    filesById.clear();
    objects.clear();
    const store = toolResultStore("none");
    const full = lines(300_000);
    const view = await projectAttemptToolResultForCaller(
      { content: [{ type: "text", text: full }] },
      modelCall,
      store,
    );
    const receipt = (view._meta as Record<string, ToolResultStoredReceipt>)[
      TOOL_RESULT_STORED_META_KEY
    ]!;
    expect(receipt.sandboxPath).toBeNull();
    const stored = filesById.get(receipt.resultId)!;
    expect(stored).toMatchObject({ status: "ready", contentType: "text/plain" });
    expect(stored.objectKey).toBe(
      `workspaces/${WORKSPACE_ID}/files/${receipt.resultId}/tool-results/${receipt.resultId}.txt`,
    );
    // The model's next call, exactly as the note names it, reads the rest.
    const shown = textOf(view);
    const call = shown.match(/tool_result_read (\{.*?\});/);
    expect(call).not.toBeNull();
    const args = JSON.parse(call![1]!) as { resultId: string; offset: number };
    expect(args).toEqual({ resultId: receipt.resultId, offset: receipt.notShownFrom });
    // The reader is itself wrapped like every attempt tool: its reads fit inline.
    const [reader] = wrapAttemptToolDefinitions(
      [
        createToolResultReadAttemptToolDefinition({
          read: store.readBytes,
          inlineMaxBytes: store.inlineMaxBytes,
        }),
      ],
      store,
    );
    const rest = await readAll(reader as never, args.resultId, args.offset);
    expect(rest.calls).toBe(3);
    const head = Buffer.from(full).subarray(0, receipt.notShownFrom).toString("utf8");
    expect(head + rest.text).toBe(full);
    expect(filesById.size).toBe(1);
  });

  test("shell output keeps its head and tail and its middle is readable", async () => {
    filesById.clear();
    objects.clear();
    const store = toolResultStore("none");
    const full = lines(250_000, "build");
    const view = (await storeOversizedFunctionToolOutput({
      toolName: "exec_command",
      callId: "call_exec_1",
      output: full,
      store,
    })) as string;
    // The first line says the output is partial; head, note and tail follow.
    expect(view.startsWith("[Opengeni: partial output. This output is ")).toBe(true);
    const body = view.slice(view.indexOf("\n") + 1);
    const note = body.match(
      /\n\[Opengeni: bytes (\d+) to (\d+) of this \d+-byte output are not shown; the whole output is stored\. Read on with tool_result_read \{"resultId":"([0-9a-f-]+)","offset":\d+\}; load tool_result_read by that exact name with tool search first\.\]\n/,
    )!;
    const [head, tail] = body.split(note[0]);
    const reader = createToolResultReadAttemptToolDefinition({
      read: store.readBytes,
      inlineMaxBytes: store.inlineMaxBytes,
    });
    const from = Number(note[1]);
    const to = Number(note[2]);
    const rest = await readAll(reader, note[3]!, from);
    expect(rest.calls).toBe(3);
    const middle = Buffer.from(rest.text)
      .subarray(0, to - from)
      .toString("utf8");
    expect(head! + middle + tail!).toBe(full);
  });

  test("reads stay within one result, cut on characters, and refuse unknown ids", async () => {
    const bytes = Buffer.from("ab✓cd", "utf8");
    expect(readStoredToolResultSlice(bytes, 3, 2)).toEqual({ start: 5, end: 7, text: "cd" });
    expect(readStoredToolResultSlice(bytes, 0, 3)).toEqual({ start: 0, end: 2, text: "ab" });
    expect(readStoredToolResultSlice(bytes, 2, 1)).toEqual({ start: 2, end: 5, text: "✓" });
    filesById.clear();
    objects.clear();
    const store = toolResultStore("none");
    const reader = createToolResultReadAttemptToolDefinition({
      read: store.readBytes,
      inlineMaxBytes: store.inlineMaxBytes,
    });
    const unknown = await reader.execute(
      { resultId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      modelCall,
    );
    expect(unknown.isError).toBe(true);
    // A workspace file that is not a stored tool result is not readable here.
    filesById.set("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
      ...filesById.get("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      workspaceId: WORKSPACE_ID,
      status: "ready",
      filename: "notes.txt",
      safeFilename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      sha256: null,
      bucket: "test-bucket",
      objectKey: `workspaces/${WORKSPACE_ID}/files/dddddddd-dddd-4ddd-8ddd-dddddddddddd/notes.txt`,
      createdAt: "2026-11-19T00:00:00.000Z",
      updatedAt: "2026-11-19T00:00:00.000Z",
    } as FileAsset);
    objects.set(
      `workspaces/${WORKSPACE_ID}/files/dddddddd-dddd-4ddd-8ddd-dddddddddddd/notes.txt`,
      Buffer.from("note"),
    );
    expect(
      (await reader.execute({ resultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, modelCall))
        .isError,
    ).toBe(true);
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
  return { established: { instanceId: "instance-1", session }, leaseEpoch: 1 };
}

describe("tool result store sandbox copy", () => {
  const key = { kind: "operation" as const, operationId: OPERATION_ID };

  test("a running sandbox gets a copy at its absolute path", async () => {
    filesById.clear();
    mutationCalls = 0;
    const machine = shellSession("/Users/user/projects/app");
    const store = toolResultStore("selfhosted", {
      resolved: () => resolvedSandbox(machine.session),
      setupSession: () => machine.session,
    });
    const stored = await store.store({ key, text: lines(200_000) });
    expect(stored.sandboxPath).toBe(`/Users/user/projects/app/tool-results/${stored.resultId}.txt`);
    expect(mutationCalls).toBe(1);
    expect(machine.calls[0]!.cmd).toContain(`tool-results/${stored.resultId}.txt`);
  });

  test("no running sandbox, a failed copy or no backend gives no path and starts nothing", async () => {
    filesById.clear();
    expect((await toolResultStore("modal").store({ key, text: "x" })).sandboxPath).toBeNull();
    filesById.clear();
    const broken = shellSession("/workspace", 1);
    expect(
      (
        await toolResultStore("docker", { sdkOwned: () => broken.session }).store({
          key,
          text: "x",
        })
      ).sandboxPath,
    ).toBeNull();
    filesById.clear();
    expect((await toolResultStore("none").store({ key, text: "x" })).sandboxPath).toBeNull();
  });
});
