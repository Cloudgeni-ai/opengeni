import { describe, expect, test } from "bun:test";
import type { TranscriptionEvent } from "@opengeni/sdk";
import {
  INITIAL_TRANSCRIPTION_CONTROL_STATE,
  appendFinalTranscript,
  transitionTranscriptionControl,
} from "../src/hooks/use-transcription";

/** @deprecated Host-adapter reducer coverage retained for one compatibility release. */
describe("legacy transcription lifecycle reducer", () => {
  test("fences stale sequences/generations and accepts each final exactly once", () => {
    const started = transitionTranscriptionControl(INITIAL_TRANSCRIPTION_CONTROL_STATE, {
      type: "start",
      generation: 1,
      localSessionId: "local-1",
    }).state;
    const opened = transitionTranscriptionControl(started, {
      type: "event",
      generation: 1,
      event: event("local-1", 1, {
        type: "session.opened",
        providerSessionId: "provider-1",
      }),
    }).state;
    const final = transitionTranscriptionControl(opened, {
      type: "event",
      generation: 1,
      event: event("local-1", 2, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "accepted once",
        providerAcceptanceId: "acceptance-1",
      }),
    });
    expect(final.commit).toBe("accepted once");
    const duplicate = transitionTranscriptionControl(final.state, {
      type: "event",
      generation: 1,
      event: event("local-1", 3, {
        type: "transcript.final",
        segmentId: "segment-1",
        text: "accepted once again",
        providerAcceptanceId: "acceptance-1",
      }),
    });
    expect(duplicate.commit).toBeNull();
    const stale = transitionTranscriptionControl(final.state, {
      type: "event",
      generation: 0,
      event: event("local-1", 4, {
        type: "transcript.final",
        segmentId: "segment-2",
        text: "stale",
        providerAcceptanceId: "acceptance-2",
      }),
    });
    expect(stale.commit).toBeNull();
  });

  test("appendFinalTranscript preserves editable draft spacing", () => {
    expect(appendFinalTranscript("", "hello")).toBe("hello");
    expect(appendFinalTranscript("hi", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi ", "there")).toBe("hi there");
    expect(appendFinalTranscript("hi", "   ")).toBe("hi");
  });
});

function event(
  localSessionId: string,
  sequence: number,
  payload: Record<string, unknown> & { type: TranscriptionEvent["type"] },
): TranscriptionEvent {
  return {
    ...payload,
    localSessionId,
    sequence,
    occurredAt: "2026-07-21T12:00:00.000Z",
  } as TranscriptionEvent;
}
