import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import type { ObjectStorage } from "@opengeni/storage";
import {
  prepareRecordingForSettlement,
  withRecordingPreparationTimeout,
  type ActiveRecording,
  type PreparedRecordingSettlement,
} from "../src/activities/recording";

const active: ActiveRecording = {
  recordingId: "00000000-0000-4000-8000-000000000001",
  turnId: "00000000-0000-4000-8000-000000000002",
  mode: "on-turn",
  dimensions: [1280, 800],
  framerate: 15,
  proc: {
    recordingId: "00000000-0000-4000-8000-000000000001",
    codec: "h264-mp4",
    boxPath: "/tmp/recording.mp4",
    pidFile: "/tmp/recording.pid",
    dimensions: [1280, 800],
    framerate: 15,
    startedAt: Date.now() - 3_000,
    display: ":0",
  },
};

const settings = testSettings({
  recordingDefaultCodec: "h264-mp4",
  recordingMaxBytes: 10_000,
});

describe("attempt-closing recording preparation", () => {
  test("uploads directly with the bounded settlement timeout and returns no database side effect", async () => {
    const commands: string[] = [];
    const session = {
      execCommand: async ({ cmd }: { cmd: string }) => {
        commands.push(cmd);
        if (cmd.includes("stat -c %s")) return "Output:\n1234";
        if (cmd.includes("curl ")) return "Output:\nOPENGENI_RECORDING_UPLOAD_OK";
        return "Output:\n";
      },
    };
    const storage = {
      createPutUrl: async () => ({
        url: "https://storage.invalid/scoped",
        requiredHeaders: { "x-ms-blob-type": "BlockBlob" },
      }),
    } as unknown as ObjectStorage;

    await expect(
      prepareRecordingForSettlement({
        settings,
        objectStorage: storage,
        workspaceId: "workspace",
        sessionId: "session",
        active,
        session,
        didComputerUse: true,
      }),
    ).resolves.toMatchObject({
      mutation: {
        action: "available",
        recordingId: active.recordingId,
        sizeBytes: 1234,
      },
      deleteArtifactsAfterCommit: true,
    });
    expect(commands.some((command) => command.includes("--max-time 45"))).toBe(true);
  });

  test("plain desktop readiness becomes an atomic discard without a storage PUT", async () => {
    let putUrls = 0;
    const result = await prepareRecordingForSettlement({
      settings,
      objectStorage: {
        createPutUrl: async () => {
          putUrls += 1;
          throw new Error("must not mint a URL");
        },
      } as unknown as ObjectStorage,
      workspaceId: "workspace",
      sessionId: "session",
      active,
      session: { execCommand: async () => "Output:\n" },
      didComputerUse: false,
    });
    expect(result).toEqual({
      mutation: { action: "discard", recordingId: active.recordingId },
      deleteArtifactsAfterCommit: true,
    });
    expect(putUrls).toBe(0);
  });

  test("upload setup failure degrades to recording.failed instead of blocking turn settlement", async () => {
    const result = await prepareRecordingForSettlement({
      settings,
      objectStorage: null,
      workspaceId: "workspace",
      sessionId: "session",
      active,
      session: { execCommand: async () => "Output:\n" },
      didComputerUse: true,
    });
    expect(result).toMatchObject({
      mutation: {
        action: "failed",
        recordingId: active.recordingId,
        reason: "upload-failed",
      },
      deleteArtifactsAfterCommit: false,
    });
  });

  test("a hung preparation resolves to the bounded failure outcome", async () => {
    const timeoutResult: PreparedRecordingSettlement = {
      mutation: {
        action: "failed",
        recordingId: active.recordingId,
        reason: "upload-failed",
        detail: "timed out",
      },
      deleteArtifactsAfterCommit: false,
    };
    const pending = new Promise<PreparedRecordingSettlement>(() => undefined);
    await expect(withRecordingPreparationTimeout(pending, timeoutResult, 5)).resolves.toEqual(
      timeoutResult,
    );
  });
});
