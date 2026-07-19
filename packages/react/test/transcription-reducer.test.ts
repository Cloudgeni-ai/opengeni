import { describe, expect, test } from "bun:test";

import { initialTranscriptionState, transcriptionReducer } from "../src/transcription/reducer";
import type {
  TranscriptionEvent,
  TranscriptionReducerAction,
  TranscriptionState,
} from "../src/transcription/types";

const SESSION_ID = "dictation-1";

type EventWithoutSession = TranscriptionEvent extends infer Event
  ? Event extends TranscriptionEvent
    ? Omit<Event, "sessionId" | "providerId">
    : never
  : never;

function reduce(
  actions: TranscriptionReducerAction[],
  state: TranscriptionState = initialTranscriptionState,
): TranscriptionState {
  return actions.reduce(transcriptionReducer, state);
}

function start(): TranscriptionReducerAction {
  return { type: "start.requested", sessionId: SESSION_ID };
}

function event(value: EventWithoutSession): TranscriptionReducerAction {
  return {
    type: "provider.event",
    event: {
      sessionId: SESSION_ID,
      providerId: "openai",
      ...value,
    } as TranscriptionEvent,
  };
}

describe("transcriptionReducer", () => {
  test("replaces one ephemeral partial and ignores stale provider sequences", () => {
    const state = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "transcript.partial",
        sequence: 4,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "hello wor",
      }),
      event({
        type: "transcript.partial",
        sequence: 3,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "stale",
      }),
      event({
        type: "transcript.partial",
        sequence: 5,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "hello world",
      }),
    ]);

    expect(state.phase).toBe("listening");
    expect(state.partial?.text).toBe("hello world");
    expect(state.partial?.sequence).toBe(5);
    expect(state.latestCommit).toBeNull();
  });

  test("accepts one final per logical segment across replay and fallback attempts", () => {
    const state = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "transcript.partial",
        sequence: 2,
        attempt: 0,
        segmentId: "provider-item-a",
        logicalSegmentId: "logical-1",
        text: "the accepted",
      }),
      event({
        type: "transcript.final",
        sequence: 3,
        attempt: 0,
        segmentId: "provider-item-a",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "accept-a",
        providerEventId: "event-a",
        text: "the accepted final",
      }),
      event({
        type: "transcript.final",
        sequence: 4,
        attempt: 0,
        segmentId: "provider-item-a",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "accept-a",
        providerEventId: "event-a-replay",
        text: "the accepted final",
      }),
      event({
        type: "transcript.final",
        sequence: 5,
        attempt: 1,
        segmentId: "provider-item-b",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "accept-b",
        providerEventId: "event-b",
        text: "a duplicate fallback final",
      }),
    ]);

    expect(state.partial).toBeNull();
    expect(state.acceptedFinalByLogicalSegment).toEqual({
      "logical-1": "accept-a",
    });
    expect(state.acceptedCommits.map((commit) => commit.text)).toEqual(["the accepted final"]);
    expect(state.latestCommit?.text).toBe("the accepted final");
    expect(state.latestCommit?.providerAcceptanceId).toBe("accept-a");
  });

  test("does not commit a stale final older than the latest partial for its provider segment", () => {
    const state = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "transcript.partial",
        sequence: 5,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "newer partial",
      }),
      event({
        type: "transcript.final",
        sequence: 4,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "stale-acceptance",
        text: "stale final",
      }),
    ]);

    expect(state.partial?.text).toBe("newer partial");
    expect(state.acceptedCommits).toEqual([]);
    expect(state.latestCommit).toBeNull();
  });

  test("clears a matching partial when a newer final is empty without creating a commit", () => {
    const state = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "transcript.partial",
        sequence: 2,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        text: "unfinished",
      }),
      event({
        type: "transcript.final",
        sequence: 3,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "accepted-empty",
        text: "   ",
      }),
    ]);

    expect(state.partial).toBeNull();
    expect(state.acceptedFinalByLogicalSegment).toEqual({});
    expect(state.acceptedCommits).toEqual([]);
    expect(state.latestCommit).toBeNull();
  });

  test("clears unsafe partials on reconnect while retaining accepted finals", () => {
    const state = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "transcript.final",
        sequence: 2,
        attempt: 0,
        segmentId: "item-1",
        logicalSegmentId: "logical-1",
        providerAcceptanceId: "accepted-1",
        text: "keep me",
      }),
      event({
        type: "transcript.partial",
        sequence: 3,
        attempt: 0,
        segmentId: "item-2",
        logicalSegmentId: "logical-2",
        text: "do not keep me",
      }),
      event({ type: "reconnecting", sequence: 4, attempt: 1, retryInMs: 250 }),
    ]);

    expect(state.phase).toBe("reconnecting");
    expect(state.partial).toBeNull();
    expect(state.acceptedFinalByLogicalSegment).toEqual({
      "logical-1": "accepted-1",
    });
    expect(state.latestCommit?.text).toBe("keep me");
  });

  test("cancel and provider errors clear partials without manufacturing a commit", () => {
    const partial = event({
      type: "transcript.partial",
      sequence: 2,
      attempt: 0,
      segmentId: "item-1",
      logicalSegmentId: "logical-1",
      text: "unfinished",
    });
    const cancelled = reduce([start(), partial, { type: "cancel.requested" }]);
    const failed = reduce([
      start(),
      partial,
      event({
        type: "error",
        sequence: 3,
        code: "permission_denied",
        message: "Microphone permission was denied.",
        retryable: true,
        permissionDenied: true,
      }),
    ]);

    expect(cancelled.phase).toBe("cancelling");
    expect(cancelled.partial).toBeNull();
    expect(cancelled.latestCommit).toBeNull();
    expect(failed.phase).toBe("error");
    expect(failed.partial).toBeNull();
    expect(failed.latestCommit).toBeNull();
    expect(failed.error?.permissionDenied).toBe(true);
  });

  test("deduplicates usage events while preserving the provider's actual unit", () => {
    const usage = event({
      type: "usage",
      sequence: 3,
      providerEventId: "usage-1",
      usage: { unit: "duration_seconds", seconds: 12.5 },
    });
    const state = reduce([start(), usage, usage]);

    expect(state.acceptedUsage).toEqual([{ unit: "duration_seconds", seconds: 12.5 }]);
    expect(state.acceptedUsageEventIds).toEqual({ "openai:usage-1": true });
  });

  test("ignores events for an inactive transcription session", () => {
    const state = transcriptionReducer(reduce([start()]), {
      type: "provider.event",
      event: {
        type: "session.ready",
        sessionId: "old-session",
        providerId: "openai",
        sequence: 99,
      },
    });

    expect(state.phase).toBe("requesting-permission");
  });

  test("treats provider errors and closure as terminal until a new start", () => {
    const failed = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({
        type: "error",
        sequence: 2,
        code: "provider_failed",
        message: "The provider failed.",
        retryable: true,
      }),
    ]);
    const afterFailed = reduce(
      [
        event({ type: "session.ready", sequence: 3 }),
        event({
          type: "transcript.final",
          sequence: 4,
          attempt: 0,
          segmentId: "late-item",
          logicalSegmentId: "late-logical",
          providerAcceptanceId: "late-acceptance",
          text: "must not be accepted",
        }),
        event({
          type: "usage",
          sequence: 5,
          usage: { unit: "audio_seconds", seconds: 1 },
        }),
        event({ type: "closed", sequence: 6, reason: "error" }),
      ],
      failed,
    );

    const closed = reduce([
      start(),
      event({ type: "session.ready", sequence: 1 }),
      event({ type: "closed", sequence: 2, reason: "provider_closed" }),
    ]);
    const afterClosed = reduce(
      [
        event({ type: "session.ready", sequence: 3 }),
        event({
          type: "error",
          sequence: 4,
          code: "late_error",
          message: "Must not replace closure.",
          retryable: true,
        }),
      ],
      closed,
    );

    expect(afterFailed).toBe(failed);
    expect(afterFailed.phase).toBe("error");
    expect(afterFailed.acceptedCommits).toEqual([]);
    expect(afterFailed.acceptedUsage).toEqual([]);
    expect(afterClosed).toBe(closed);
    expect(afterClosed.phase).toBe("closed");
    expect(afterClosed.closedReason).toBe("provider_closed");
    expect(afterClosed.error).toBeNull();
  });
});
