import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Permission } from "@opengeni/contracts";
import type {
  BrowserRecordingSaveResponse,
  BrowserRecordingSummary,
  InteractionTransport,
} from "@opengeni/sdk";
import { createInteractionAttemptToolDefinitions } from "../src/interaction-tools";

const workspaceId = randomUUID();
const sessionId = randomUUID();
const browserSessionId = randomUUID();
const recordingId = randomUUID();
const operationId = randomUUID();
const context = { operationId, caller: { kind: "model" as const, subjectId: "model:test" } };
const summary: BrowserRecordingSummary = {
  recordingId,
  state: "recording",
  startedAt: "2026-10-20T12:00:00.000Z",
  stoppedAt: null,
  stopReason: null,
  durationMs: 0,
  frameCount: 0,
  frameBytes: 0,
  actionCount: 0,
  bundle: null,
  streamError: null,
};
const saved: BrowserRecordingSaveResponse = {
  recording: {
    ...summary,
    state: "stopped",
    stoppedAt: "2026-10-20T12:00:10.000Z",
    stopReason: "requested",
    durationMs: 10_000,
    frameCount: 12,
    frameBytes: 120_000,
    bundle: { sizeBytes: 120_400, sha256: "b".repeat(64) },
  },
  video: {
    path: "proof/flow.mp4",
    artifactId: randomUUID(),
    sizeBytes: 40_000,
    durationMs: 10_000,
    width: 1280,
    height: 800,
    frameCount: 12,
  },
  actionLogPath: "proof/flow.actions.json",
};

function recordTool(
  transport: Record<string, unknown>,
  permissions: Permission[] = ["sessions:read", "sessions:control", "files:upload"],
) {
  return createInteractionAttemptToolDefinitions({
    transport: transport as unknown as InteractionTransport,
    workspaceId,
    sessionId,
    selectedTools: ["browser_record"],
    permissions,
  });
}

describe("browser_record", () => {
  test("needs control and file upload permission", () => {
    expect(recordTool({}, ["sessions:control"])).toHaveLength(0);
    expect(recordTool({}, ["files:upload"])).toHaveLength(0);
    expect(recordTool({}).map((tool) => tool.identity.toolName)).toEqual(["browser_record"]);
  });

  test("starts on the named tab and saves with the journaled operation id", async () => {
    const calls: unknown[] = [];
    const [tool] = recordTool({
      startBrowserRecording: async (...args: unknown[]) => {
        calls.push(["start", ...args]);
        return summary;
      },
      saveBrowserRecording: async (...args: unknown[]) => {
        calls.push(["save", ...args]);
        return saved;
      },
    });
    expect(
      (await tool!.execute({ operation: "start", browserSessionId, targetId: "tab-1" }, context))
        .structuredContent,
    ).toEqual(summary);
    expect(
      (
        await tool!.execute(
          {
            operation: "stop",
            browserSessionId,
            recordingId,
            destinationPath: "proof/flow.mp4",
          },
          context,
        )
      ).structuredContent,
    ).toEqual(saved);
    expect(calls).toEqual([
      ["start", workspaceId, browserSessionId, "tab-1"],
      [
        "save",
        workspaceId,
        browserSessionId,
        recordingId,
        { operationId, destinationPath: "proof/flow.mp4" },
      ],
    ]);
  });

  test("rejects mismatched operation fields before dispatch", async () => {
    let calls = 0;
    const unexpected = async () => {
      calls++;
      throw new Error("Unexpected dispatch");
    };
    const [tool] = recordTool({
      startBrowserRecording: unexpected,
      saveBrowserRecording: unexpected,
    });
    for (const args of [
      { operation: "stop", browserSessionId },
      { operation: "start", browserSessionId, targetId: "tab-1", recordingId },
      { operation: "start", browserSessionId, targetId: "tab-1", destinationPath: "a.mp4" },
      { operation: "stop", browserSessionId, recordingId, destinationPath: "../a.mp4" },
    ]) {
      expect(await tool!.execute(args, context)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "invalid_arguments" } },
      });
    }
    expect(calls).toBe(0);
  });
});
