import { expect, mock, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { testSettings } from "@opengeni/testing";
import type { ChannelASession } from "@opengeni/runtime/sandbox";

const realDb = await import("@opengeni/db");
const realSandbox = await import("@opengeni/runtime/sandbox");

const reads = ["one", "two", "three", "four"];
const uploadedKeys: string[] = [];
let failedInput: Record<string, unknown> | null = null;

const degradedEvent = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "00000000-0000-4000-8000-0000000000b1",
  sessionId: "00000000-0000-4000-8000-0000000000c1",
  sequence: 42,
  type: "workspace.revision.degraded",
  payload: {
    revision: 8,
    turnId: "00000000-0000-4000-8000-0000000000d1",
    capturedAt: "2026-07-19T00:00:00.000Z",
    leaseEpoch: 7,
    reason: "workspace_changed_during_capture",
  },
  occurredAt: "2026-07-19T00:00:00.000Z",
  clientEventId: "opengeni:workspace-capture:8",
  turnId: "00000000-0000-4000-8000-0000000000d1",
  turnGeneration: null,
  turnAttemptId: null,
  turnAssociation: null,
  duplicateOfEventId: null,
  duplicateReason: null,
} as SessionEvent;

mock.module("@opengeni/db", () => ({
  ...realDb,
  latestWorkspaceCapture: async () => ({
    revision: 7,
    stats: { fingerprint: "older" },
  }),
  insertFailedWorkspaceCapture: async (_db: Database, input: Record<string, unknown>) => {
    failedInput = input;
    return { revision: input.revision as number, events: [degradedEvent] };
  },
  insertWorkspaceCapture: async () => {
    throw new Error("an unstable capture must not commit as available");
  },
  planWorkspaceCaptureGc: async () => {
    throw new Error("a degraded capture must return before available-capture GC");
  },
}));

class UnstableWorkspaceService {
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
      files: [{ path: "churn.txt", index: null, worktree: "untracked" }],
      revision: 1,
    };
  }

  async gitDiff() {
    return { files: [], revision: 1 };
  }

  async fsRead(input: { path: string }) {
    const content = reads.shift();
    if (content === undefined) throw new Error("unexpected extra read");
    return {
      path: input.path,
      encoding: "base64" as const,
      content: Buffer.from(content).toString("base64"),
      sizeBytes: content.length,
      truncated: false,
      isBinary: false,
      revision: 1,
    };
  }
}

mock.module("@opengeni/runtime/sandbox", () => ({
  ...realSandbox,
  SandboxChannelAService: UnstableWorkspaceService,
}));

const { captureWorkspaceRevision } = await import("../../src/activities/workspace-capture");

test("persistent workspace churn commits a newer degraded revision", async () => {
  const published: SessionEvent[][] = [];
  const warnings: string[] = [];
  const counters: Array<Record<string, unknown>> = [];
  const objectStorage = {
    putObject: async ({ key }: { key: string }) => {
      uploadedKeys.push(key);
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

  expect(reads).toEqual([]);
  expect(uploadedKeys).toEqual([]);
  expect(failedInput).toMatchObject({
    expectedEpoch: 7,
    revision: 8,
    attemptId: "00000000-0000-4000-8000-0000000000e1",
    stats: {
      degradedReason: "workspace_changed_during_capture",
      stabilizationAttempts: 2,
    },
  });
  expect(published).toEqual([[degradedEvent]]);
  expect(warnings).toContain("workspace capture degraded — workspace remained unstable");
  expect(counters).toContainEqual(
    expect.objectContaining({
      labels: { result: "degraded_workspace_unstable" },
    }),
  );
});
