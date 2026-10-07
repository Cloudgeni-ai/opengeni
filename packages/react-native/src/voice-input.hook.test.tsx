import { describe, expect, test } from "bun:test";
import { act } from "react";
import { registerDom, renderHook } from "../../react/test/render-hook";
import {
  dictationSegmentSeconds,
  isRetryableTranscriptionError,
  NativeTranscriptionError,
  useNativeVoiceInput,
  type NativeVoiceRecorder,
  type NativeVoiceRecording,
} from "./voice-input";

registerDom();

/** A recorder whose clock the test advances; every stop yields a new file. */
function fakeRecorder() {
  let seconds = 0;
  let files = 0;
  const discarded: string[] = [];
  const recorder: NativeVoiceRecorder = {
    requestPermission: async () => true,
    start: async () => {
      seconds = 0;
    },
    stop: async () => ({
      uri: `file:///seg-${++files}.m4a`,
      mimeType: "audio/mp4",
      durationSeconds: seconds,
    }),
    cancel: async () => undefined,
    discard: (recording) => void discarded.push(recording.uri),
    durationSeconds: () => seconds,
    level: () => null,
  };
  return {
    recorder,
    discarded,
    advance: (by: number) => {
      seconds += by;
    },
  };
}

const tick = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function startRecording(options: {
  transcribe: (recording: NativeVoiceRecording) => Promise<string>;
  maxDurationSeconds?: number | null;
  initialDraft?: string;
}) {
  const fake = fakeRecorder();
  let draft = options.initialDraft ?? "";
  const hook = await renderHook(
    () =>
      useNativeVoiceInput({
        recorder: fake.recorder,
        available: true,
        maxDurationSeconds: options.maxDurationSeconds ?? null,
        transcribe: options.transcribe,
        getValue: () => draft,
        setValue: (next) => {
          draft = next;
        },
        retryDelaysMs: [5, 5],
      }),
    undefined,
  );
  await act(async () => hook.result.current.start());
  await tick(5);
  expect(hook.result.current.status).toBe("recording");
  return { hook, fake, draft: () => draft };
}

describe("dictation robustness", () => {
  test("segments roll over a little under the per-request limit", () => {
    expect(dictationSegmentSeconds(60)).toBe(57);
    expect(dictationSegmentSeconds(10)).toBe(9);
    expect(dictationSegmentSeconds(null)).toBeNull();
  });

  test("only transient failures are retried automatically", () => {
    expect(isRetryableTranscriptionError(new NativeTranscriptionError("offline", null))).toBe(true);
    expect(isRetryableTranscriptionError(new NativeTranscriptionError("busy", 503))).toBe(true);
    expect(isRetryableTranscriptionError(new NativeTranscriptionError("slow down", 429))).toBe(
      true,
    );
    expect(isRetryableTranscriptionError(new NativeTranscriptionError("bad audio", 400))).toBe(
      false,
    );
    expect(isRetryableTranscriptionError(new NativeTranscriptionError("too big", 413))).toBe(false);
  });

  test("a transient failure is retried and the text lands in the draft", async () => {
    let calls = 0;
    const { hook, fake, draft } = await startRecording({
      initialDraft: "Fix",
      transcribe: async () => {
        calls += 1;
        if (calls < 3) throw new NativeTranscriptionError("offline", null);
        return "the build";
      },
    });
    fake.advance(4);
    await act(async () => hook.result.current.stop());
    await tick(60);
    expect(calls).toBe(3);
    expect(draft()).toBe("Fix the build");
    expect(hook.result.current.status).toBe("idle");
    expect(fake.discarded).toEqual(["file:///seg-1.m4a"]);
  });

  test("a failed transcription keeps the recording until Retry succeeds", async () => {
    let fail = true;
    const { hook, fake, draft } = await startRecording({
      transcribe: async () => {
        if (fail) throw new NativeTranscriptionError("Audio could not be transcribed.", 400);
        return "hello";
      },
    });
    fake.advance(3);
    await act(async () => hook.result.current.stop());
    await tick(30);
    expect(hook.result.current.status).toBe("error");
    expect(hook.result.current.hasSavedRecording).toBe(true);
    expect(fake.discarded).toEqual([]);
    // Dismissing the message does not drop the recording.
    await act(async () => hook.result.current.clearError());
    expect(hook.result.current.hasSavedRecording).toBe(true);
    fail = false;
    await act(async () => hook.result.current.retry());
    await tick(30);
    expect(draft()).toBe("hello");
    expect(hook.result.current.hasSavedRecording).toBe(false);
    expect(fake.discarded).toEqual(["file:///seg-1.m4a"]);
  });

  test("a long dictation rolls over and joins the segments in order", async () => {
    const sent: number[] = [];
    const { hook, fake, draft } = await startRecording({
      maxDurationSeconds: 10,
      transcribe: async (recording) => {
        sent.push(recording.durationSeconds);
        return recording.uri.includes("seg-1") ? "first part" : "second part";
      },
    });
    fake.advance(9.5);
    await tick(250);
    expect(hook.result.current.status).toBe("recording");
    fake.advance(4);
    await act(async () => hook.result.current.stop());
    await tick(60);
    expect(draft()).toBe("first part second part");
    expect(sent.every((seconds) => seconds <= 10)).toBe(true);
    expect(fake.discarded).toEqual(["file:///seg-1.m4a", "file:///seg-2.m4a"]);
  });

  test("the reported length never exceeds the server limit", async () => {
    const sent: number[] = [];
    const { hook, fake } = await startRecording({
      maxDurationSeconds: 60,
      transcribe: async (recording) => {
        sent.push(recording.durationSeconds);
        return "ok";
      },
    });
    // Stopped manually just past the limit, before the rollover tick ran.
    fake.advance(60.4);
    await act(async () => hook.result.current.stop());
    await tick(30);
    expect(sent).toEqual([60]);
  });
});
