import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline } from "@opengeni/react";
import { timelineShowsFailure } from "./timeline-failure-owner";

const recorded =
  "compaction summarization failed: 400 Missing required parameter: 'input[116].status'.";
const rejection = {
  httpStatus: 400,
  type: "invalid_request_error",
  code: "missing_required_parameter",
  param: "input[116].status",
  requestId: "req_1",
};

function event(sequence: number, type: string, payload: unknown, turnId: string): SessionEvent {
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(1718000000000 + sequence * 1000).toISOString(),
  };
}

const skipped = (sequence: number, turnId: string, providerRejection: unknown = rejection) =>
  event(
    sequence,
    "session.context.compaction.skipped",
    { trigger: "auto", reason: "summarization_failed", providerRejection },
    turnId,
  );
const failed = (sequence: number, turnId: string, error = recorded) =>
  event(sequence, "turn.failed", { error, code: "context_compaction_failed" }, turnId);

test("the failed turn's own compaction landmark owns the failure", () => {
  const items = buildTimeline([
    event(1, "user.message", { text: "Continue" }, "turn-1"),
    skipped(2, "turn-1"),
    failed(3, "turn-1"),
  ]);
  expect(timelineShowsFailure(items, { failureEventId: "evt-3", turnId: "turn-1" })).toBe(true);
  // Without a provider rejection, the landmark carries the recorded text instead.
  const plain = buildTimeline([skipped(1, "turn-1", null), failed(2, "turn-1")]);
  expect(timelineShowsFailure(plain, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(true);
});

test("the failure event's own notice owns it when there is no landmark", () => {
  const items = buildTimeline([failed(1, "turn-1")]);
  expect(items.some((item) => item.kind === "notice")).toBe(true);
  expect(timelineShowsFailure(items, { failureEventId: "evt-1", turnId: "turn-1" })).toBe(true);
});

test("an older, unrelated or hidden failure never suppresses the banner", () => {
  // A newer failure in another turn is not represented by an older landmark.
  const older = buildTimeline([skipped(1, "turn-1"), failed(2, "turn-1")]);
  expect(timelineShowsFailure(older, { failureEventId: "evt-9", turnId: "turn-2" })).toBe(false);
  // Unknown identity proves nothing.
  expect(timelineShowsFailure(older, { failureEventId: null, turnId: null })).toBe(false);
  // A landmark without diagnostics has no Details to stand in for the banner's.
  const bare = buildTimeline([skipped(1, "turn-1", null)]);
  expect(timelineShowsFailure(bare, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(false);
  // A cleared or paged-out view shows nothing.
  expect(timelineShowsFailure([], { failureEventId: "evt-2", turnId: "turn-1" })).toBe(false);
});

test("after Retry reopens the turn, only the new attempt's landmark owns its failure", () => {
  const recovery = (sequence: number) =>
    event(sequence, "turn.recovery.requested", { reason: "human_retry" }, "turn-1");
  // The retried attempt failed without settling a new landmark: the old one
  // belongs to the earlier failure. The newer failure still has its own notice
  // only when the turn had no activity, so drop it to prove the landmark alone.
  const stale = buildTimeline([
    skipped(1, "turn-1"),
    failed(2, "turn-1"),
    recovery(3),
    failed(4, "turn-1", "compaction summarization failed: 500 upstream"),
  ]).filter((item) => item.kind !== "notice");
  expect(timelineShowsFailure(stale, { failureEventId: "evt-4", turnId: "turn-1" })).toBe(false);
  // The earlier failure is still owned by its own landmark.
  expect(timelineShowsFailure(stale, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(true);
  // A landmark settled by the retried attempt owns the newer failure.
  const fresh = buildTimeline([
    skipped(1, "turn-1"),
    failed(2, "turn-1"),
    recovery(3),
    event(4, "session.context.compaction.started", { trigger: "auto" }, "turn-1"),
    skipped(5, "turn-1"),
    failed(6, "turn-1"),
  ]);
  expect(timelineShowsFailure(fresh, { failureEventId: "evt-6", turnId: "turn-1" })).toBe(true);
});
