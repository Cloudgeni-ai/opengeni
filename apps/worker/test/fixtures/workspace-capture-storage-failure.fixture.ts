import { expect, mock, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import type { ChannelASession } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";

const realDb = await import("@opengeni/db");
const realSandbox = await import("@opengeni/runtime/sandbox");

const uploadedKeys: string[] = [];
const deletedKeys: string[] = [];
let failedInput: Record<string, unknown> | null = null;
let availableInsertCalled = false;
let failureMode: "manifest" | "tree" = "manifest";

mock.module("@opengeni/db", () => ({
  ...realDb,
  latestWorkspaceCapture: async () => ({
    revision: 7,
    stats: { fingerprint: "older" },
  }),
  insertFailedWorkspaceCapture: async (_db: Database, input: Record<string, unknown>) => {
    failedInput = input;
    return {
      revision: input.revision as number,
      events: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence: 42,
          type: "workspace.revision.degraded",
          payload: {
            revision: input.revision,
            turnId: input.turnId,
            capturedAt: "2026-07-19T00:00:00.000Z",
            leaseEpoch: input.expectedEpoch,
            reason: (input.stats as { degradedReason: string }).degradedReason,
          },
          occurredAt: "2026-07-19T00:00:00.000Z",
          clientEventId: `opengeni:workspace-capture:${String(input.revision)}`,
          turnId: input.turnId,
          turnGeneration: null,
          turnAttemptId: input.attemptId,
          turnAssociation: null,
          duplicateOfEventId: null,
          duplicateReason: null,
        } as SessionEvent,
      ],
    };
  },
  insertWorkspaceCapture: async () => {
    availableInsertCalled = true;
    throw new Error("a storage-failed capture must not commit as available");
  },
  planWorkspaceCaptureGc: async () => {
    throw new Error("a degraded capture must return before available-capture GC");
  },
}));

class StableWorkspaceService {
  async detectReposDetailed() {
    return { repos: [""], complete: true, degradedReason: null };
  }

  async gitStatus() {
    return {
      isRepo: true,
      head: "main",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [
        {
          path: "stable.txt",
          oldPath: null,
          index: null,
          worktree: "untracked",
          isConflicted: false,
        },
      ],
      revision: 1,
    };
  }

  async gitDiff() {
    return {
      files: [
        {
          path: "stable.txt",
          oldPath: null,
          status: "untracked",
          additions: 1,
          deletions: 0,
          isBinary: false,
          truncated: false,
          hunks: [],
        },
      ],
      revision: 1,
    };
  }

  async fsRead(input: { path: string }) {
    const content = Buffer.from("stable-content");
    return {
      path: input.path,
      encoding: "base64" as const,
      content: content.toString("base64"),
      sizeBytes: content.byteLength,
      truncated: false,
      isBinary: false,
      revision: 1,
    };
  }

  async fsListPruned() {
    if (failureMode === "tree") {
      throw new Error("injected tree listing failure");
    }
    return {
      root: {
        name: "",
        path: "",
        type: "dir" as const,
        children: [{ name: "stable.txt", path: "stable.txt", type: "file" as const }],
      },
      truncated: false,
      revision: 1,
    };
  }
}

mock.module("@opengeni/runtime/sandbox", () => ({
  ...realSandbox,
  SandboxChannelAService: StableWorkspaceService,
}));

const { captureWorkspaceRevision } = await import("../../src/activities/workspace-capture");

test("manifest storage failure supersedes an older successful capture", async () => {
  const published: SessionEvent[][] = [];
  const warnings: string[] = [];
  const counters: Array<Record<string, unknown>> = [];
  const objectStorage = {
    putObject: async ({ key }: { key: string }) => {
      uploadedKeys.push(key);
      if (key.includes("/manifests/")) {
        throw new Error("injected manifest provider outage");
      }
    },
    deleteObject: async (key: string) => {
      deletedKeys.push(key);
    },
  } as unknown as ObjectStorage;

  await captureWorkspaceRevision({
    db: {} as Database,
    settings: testSettings({ workspaceCaptureEnabled: true }),
    publish: async (events) => {
      published.push(events);
    },
    session: {} as ChannelASession,
    leaseEpoch: 7,
    sandboxGroupId: "00000000-0000-4000-8000-0000000000a1",
    accountId: "00000000-0000-4000-8000-0000000000a2",
    workspaceId: "00000000-0000-4000-8000-0000000000b1",
    sessionId: "00000000-0000-4000-8000-0000000000c1",
    turnId: "00000000-0000-4000-8000-0000000000d1",
    attemptId: "00000000-0000-4000-8000-0000000000e1",
    objectStorage,
    observability: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
      incrementCounter: (input: Record<string, unknown>) => counters.push(input),
      incrementGauge: () => undefined,
      observeHistogram: () => undefined,
    } as never,
  });

  const contentKeys = uploadedKeys.filter((key) => key.includes("/blobs/"));
  const treeKeys = uploadedKeys.filter((key) => key.includes("/trees/"));
  const manifestKeys = uploadedKeys.filter((key) => key.includes("/manifests/"));
  expect(contentKeys).toHaveLength(1);
  expect(treeKeys).toHaveLength(1);
  expect(manifestKeys).toHaveLength(1);
  expect(availableInsertCalled).toBe(false);
  expect(failedInput).toMatchObject({
    expectedEpoch: 7,
    revision: 8,
    attemptId: "00000000-0000-4000-8000-0000000000e1",
    stats: {
      degradedReason: "workspace_capture_storage_unavailable",
      failureStage: "manifest",
    },
  });
  expect(published).toHaveLength(1);
  expect(deletedKeys.sort()).toEqual([...manifestKeys, ...treeKeys].sort());
  expect(deletedKeys).not.toContain(contentKeys[0]);
  expect(warnings).toContain("workspace capture degraded — object storage unavailable");
  expect(counters).toContainEqual(
    expect.objectContaining({
      labels: { result: "degraded_storage_unavailable" },
    }),
  );
});

test("tree listing failure supersedes an older successful capture", async () => {
  failureMode = "tree";
  uploadedKeys.length = 0;
  deletedKeys.length = 0;
  failedInput = null;
  availableInsertCalled = false;
  const published: SessionEvent[][] = [];
  const warnings: string[] = [];
  const counters: Array<Record<string, unknown>> = [];
  const objectStorage = {
    putObject: async ({ key }: { key: string }) => {
      uploadedKeys.push(key);
    },
    deleteObject: async (key: string) => {
      deletedKeys.push(key);
    },
  } as unknown as ObjectStorage;

  await captureWorkspaceRevision({
    db: {} as Database,
    settings: testSettings({ workspaceCaptureEnabled: true }),
    publish: async (events) => {
      published.push(events);
    },
    session: {} as ChannelASession,
    leaseEpoch: 7,
    sandboxGroupId: "00000000-0000-4000-8000-0000000000a1",
    accountId: "00000000-0000-4000-8000-0000000000a2",
    workspaceId: "00000000-0000-4000-8000-0000000000b1",
    sessionId: "00000000-0000-4000-8000-0000000000c1",
    turnId: "00000000-0000-4000-8000-0000000000d2",
    attemptId: "00000000-0000-4000-8000-0000000000e2",
    objectStorage,
    observability: {
      warn: (message: string) => warnings.push(message),
      info: () => undefined,
      incrementCounter: (input: Record<string, unknown>) => counters.push(input),
      incrementGauge: () => undefined,
      observeHistogram: () => undefined,
    } as never,
  });

  expect(uploadedKeys.filter((key) => key.includes("/blobs/"))).toHaveLength(1);
  expect(uploadedKeys.some((key) => key.includes("/trees/") || key.includes("/manifests/"))).toBe(
    false,
  );
  expect(availableInsertCalled).toBe(false);
  expect(failedInput).toMatchObject({
    expectedEpoch: 7,
    revision: 8,
    attemptId: "00000000-0000-4000-8000-0000000000e2",
    stats: {
      degradedReason: "workspace_tree_unreadable",
      failureStage: "tree_index",
    },
  });
  expect(published).toHaveLength(1);
  expect(deletedKeys).toEqual([]);
  expect(warnings).toContain("workspace capture degraded — tree unavailable");
  expect(counters).toContainEqual(
    expect.objectContaining({
      labels: { result: "degraded_tree_unreadable" },
    }),
  );
});