import { describe, expect, test } from "bun:test";
import { createOpenGeniText } from "@opengeni/react/messages";
import {
  liveCostHint,
  meetingDateLabel,
  phoneLiveStatus,
  phoneRecorderErrorText,
  phoneUploadLine,
} from "../src/meetings/phone-text";
import type { MeetingRecorder } from "../src/meetings/recorder";

const msg = createOpenGeniText();

function recorder(overrides: Partial<MeetingRecorder>): MeetingRecorder {
  return {
    state: "idle",
    recordingId: null,
    elapsedMilliseconds: 0,
    tracks: [],
    upload: null,
    error: null,
    finished: [],
    recovered: [],
    ...overrides,
  } as MeetingRecorder;
}

function upload(overrides: Record<string, unknown>): MeetingRecorder["upload"] {
  return {
    created: true,
    pendingChunks: 0,
    finalized: false,
    retryingAfterError: false,
    failed: null,
    discarded: false,
    ...overrides,
  } as unknown as MeetingRecorder["upload"];
}

describe("phone recorder wording", () => {
  test("says where the audio is while recording, paused and after Stop, never Uploading", () => {
    expect(phoneUploadLine(msg, recorder({ state: "recording", upload: upload({}) }))).toBe(
      "Keeps recording when the screen is locked or you switch apps.",
    );
    expect(
      phoneUploadLine(msg, recorder({ state: "paused", pauseReason: "interruption" })),
    ).toStartWith("Paused while a call or another app uses the microphone.");
    expect(phoneUploadLine(msg, recorder({ state: "paused", pauseReason: "person" }))).toBe(
      "Nothing is recorded while paused.",
    );
    expect(
      phoneUploadLine(
        msg,
        recorder({ state: "recording", upload: upload({ retryingAfterError: true }) }),
      ),
    ).toStartWith("Offline. Recording continues");
    expect(
      phoneUploadLine(msg, recorder({ state: "idle", upload: upload({ pendingChunks: 3 }) })),
    ).toBe("Saving the rest of the audio.");
    expect(
      phoneUploadLine(msg, recorder({ state: "idle", upload: upload({ pendingChunks: 0 }) })),
    ).toBe("Saving the rest of the audio.");
    expect(
      phoneUploadLine(msg, recorder({ state: "idle", upload: upload({ discarded: true }) })),
    ).toBe("Nothing was recorded, so no meeting was saved.");
    expect(
      phoneUploadLine(msg, recorder({ state: "idle", upload: upload({ finalized: true }) })),
    ).toBe(null);
  });

  test("tells the person what to do about each error", () => {
    expect(phoneRecorderErrorText(msg, { code: "microphone_denied", message: "denied" })).toEqual({
      title: "Microphone access is off",
      body: "Turn on the microphone for this app in Settings, then start again.",
    });
    expect(phoneRecorderErrorText(msg, { code: "upload_failed", message: "x" }).title).toBe(
      "Upload stopped",
    );
    expect(
      phoneRecorderErrorText(msg, { code: "capture_failed", message: "boom" } as never),
    ).toEqual({ title: "Recording stopped", body: "boom" });
  });

  test("the live preview's status and cost", () => {
    expect(phoneLiveStatus(msg, [{ state: "streaming" }], true)).toBe("Paused");
    expect(phoneLiveStatus(msg, [{ state: "reconnecting" }], false)).toBe("Reconnecting…");
    expect(phoneLiveStatus(msg, [{ state: "connecting" }], false)).toBe("Connecting…");
    expect(phoneLiveStatus(msg, [{ state: "streaming" }], false)).toBe(null);
    expect(liveCostHint(msg, 0.36)).toBe("It adds about $0.36 per hour of audio.");
    expect(liveCostHint(msg, null)).toBe("");
  });

  test("dates read as today, yesterday or the date, in the host's words", () => {
    const now = new Date(2026, 9, 26, 15, 0);
    expect(meetingDateLabel(msg, new Date(2026, 9, 26, 9, 5).toISOString(), now)).toStartWith(
      "Today, ",
    );
    expect(meetingDateLabel(msg, new Date(2026, 9, 25, 9, 5).toISOString(), now)).toStartWith(
      "Yesterday, ",
    );
    const norwegian = createOpenGeniText({
      locale: "nb",
      messages: { "time.todayAt": "I dag, {time}" },
    });
    expect(meetingDateLabel(norwegian, new Date(2026, 9, 26, 9, 5).toISOString(), now)).toStartWith(
      "I dag, ",
    );
    expect(meetingDateLabel(msg, "not a date", now)).toBe("");
  });
});
