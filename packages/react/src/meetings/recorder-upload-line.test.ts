import { expect, test } from "bun:test";
import type { MeetingRecorder } from "./recorder-context";
import { uploadLine } from "./recorder-panel";

const recorder = (patch: Partial<MeetingRecorder>) =>
  ({
    state: "recording",
    upload: null,
    systemAudioKind: "display",
    tracks: [],
    ...patch,
  }) as unknown as MeetingRecorder;

test("a lost microphone says nothing is recorded and that it continues by itself", () => {
  expect(uploadLine(recorder({ state: "paused", pauseReason: "interruption" }), true)).toBe(
    "Nothing is being recorded. Recording continues by itself when a microphone is back.",
  );
  expect(uploadLine(recorder({ state: "paused", pauseReason: "person" }), true)).toBe(
    "Nothing is recorded while paused.",
  );
});
