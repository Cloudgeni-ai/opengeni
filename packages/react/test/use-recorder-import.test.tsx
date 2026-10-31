import { describe, expect, test } from "bun:test";
import type { CreateRecordingRequest } from "@opengeni/contracts";
import {
  createMemoryRecordingChunkStore,
  type RecorderPlatform,
} from "@opengeni/sdk/recordings";

import { useRecorder } from "../src/hooks/use-recordings";
import { WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

describe("useRecorder importAudio", () => {
  test("makes a meeting from a file, saved here first, beside the recorder", async () => {
    const created: CreateRecordingRequest[] = [];
    const never = () => new Promise<never>(() => {});
    const recordings = {
      createRecording: async (
        _workspaceId: string,
        request: CreateRecordingRequest,
      ) => {
        created.push(request);
        return { id: request.recordingId } as never;
      },
      // The upload never gets anywhere: the import is done once the audio is saved here.
      createRecordingUploads: never,
      completeRecordingChunks: never,
      finalizeRecording: never,
      deleteRecording: never,
    };
    const store = createMemoryRecordingChunkStore();
    const platform: RecorderPlatform = {
      supported: true,
      systemAudioSupported: false,
      createRecorder: () => {
        throw new Error("not recording here");
      },
      createStore: () => store,
    };
    const hook = await renderHook(
      () =>
        useRecorder({
          recordings,
          workspaceId: WORKSPACE_ID,
          platform,
          resumePending: false,
          externalRef: "project-1",
          visibility: "private",
        }),
      undefined,
    );
    const recordingId = await actRun(() =>
      hook.result.current.importAudio({
        audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
        title: "Call with Ola",
        titleSource: "app",
        startedAt: new Date("2026-10-31T09:00:00.000Z"),
        durationMilliseconds: 60_000,
        externalRef: "customer-7",
      }),
    );
    const stored = await store.getRecording(recordingId);
    expect(stored?.create).toMatchObject({
      purpose: "meeting",
      title: "Call with Ola",
      titleSource: "app",
      startedAt: "2026-10-31T09:00:00.000Z",
      visibility: "private",
      externalRef: "customer-7",
      tracks: [{ trackNumber: 0, source: "upload", mimeType: "audio/mp4" }],
    });
    await flush();
    expect(created.map((request) => request.recordingId)).toEqual([
      recordingId,
    ]);
    // The live recorder is untouched.
    expect(hook.result.current.state).toBe("idle");
    await hook.unmount();
  });
});
