import { t } from "./console-text";
import { expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../../timeline";
import { bannerFailureEventIds, timelineShowsFailure } from "./timeline-failure-owner";

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
  const items = buildTimeline(t, [
    event(1, "user.message", { text: "Continue" }, "turn-1"),
    skipped(2, "turn-1"),
    failed(3, "turn-1"),
  ]);
  expect(timelineShowsFailure(items, { failureEventId: "evt-3", turnId: "turn-1" })).toBe(true);
  // Without a provider rejection, the landmark carries the recorded text instead.
  const plain = buildTimeline(t, [skipped(1, "turn-1", null), failed(2, "turn-1")]);
  expect(timelineShowsFailure(plain, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(true);
});

test("without a landmark the banner owns a compaction failure, and the timeline leaves it out", () => {
  const items = buildTimeline(t, [failed(1, "turn-1")]);
  expect(items.some((item) => item.kind === "notice")).toBe(true);
  // The notice is no proof: while the banner presents this failure the
  // timeline drops it, so the banner keeps its headline and Details.
  expect(timelineShowsFailure(items, { failureEventId: "evt-1", turnId: "turn-1" })).toBe(false);
  const shown = JSON.stringify(
    groupTimeline(t, items, { readableTurns: true, presentedFailureEventIds: ["evt-1"] }),
  );
  expect(shown).not.toContain("compaction summarization failed");
});

test("a usage-limit failure is shown by its own row, so the banner keeps only its actions", () => {
  const items = buildTimeline(t, [
    event(1, "user.message", { text: "Continue" }, "turn-1"),
    event(
      2,
      "turn.failed",
      {
        error: "Usage allowance exhausted",
        code: "allowance_exhausted",
        message: "Usage allowance exhausted",
        scope: "workspace",
        resetsAt: "2026-11-11T00:00:00.000Z",
      },
      "turn-1",
    ),
  ]);
  const allowance = items.find((item) => item.kind === "notice" && item.allowance);
  expect(allowance?.id).toBe("evt-2-allowance");
  expect(timelineShowsFailure(items, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(true);
  // The presented ids never remove the usage-limit row.
  const groups = groupTimeline(t, items, { presentedFailureEventIds: ["evt-2"] });
  expect(JSON.stringify(groups)).toContain("evt-2-allowance");
});

test("a credit stop presents only its own turn end, never an older failure", () => {
  const events = [
    event(1, "turn.failed", { error: "OLD FAILURE TEXT" }, "turn-1"),
    event(2, "turn.completed", { reason: "budget_exhausted" }, "turn-2"),
  ];
  expect(bannerFailureEventIds(events, { failureEventId: "evt-1" }, true)).toEqual(["evt-2"]);
  expect(bannerFailureEventIds(events, { failureEventId: "evt-1" }, false)).toEqual(["evt-1"]);
});

test("an older, unrelated or hidden failure never suppresses the banner", () => {
  // A newer failure in another turn is not represented by an older landmark.
  const older = buildTimeline(t, [skipped(1, "turn-1"), failed(2, "turn-1")]);
  expect(timelineShowsFailure(older, { failureEventId: "evt-9", turnId: "turn-2" })).toBe(false);
  // Unknown identity proves nothing.
  expect(timelineShowsFailure(older, { failureEventId: null, turnId: null })).toBe(false);
  // A landmark without diagnostics has no Details to stand in for the banner's.
  const bare = buildTimeline(t, [skipped(1, "turn-1", null)]);
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
  const stale = buildTimeline(t, [
    skipped(1, "turn-1"),
    failed(2, "turn-1"),
    recovery(3),
    failed(4, "turn-1", "compaction summarization failed: 500 upstream"),
  ]).filter((item) => item.kind !== "notice");
  expect(timelineShowsFailure(stale, { failureEventId: "evt-4", turnId: "turn-1" })).toBe(false);
  // The earlier failure is still owned by its own landmark.
  expect(timelineShowsFailure(stale, { failureEventId: "evt-2", turnId: "turn-1" })).toBe(true);
  // A landmark settled by the retried attempt owns the newer failure.
  const fresh = buildTimeline(t, [
    skipped(1, "turn-1"),
    failed(2, "turn-1"),
    recovery(3),
    event(4, "session.context.compaction.started", { trigger: "auto" }, "turn-1"),
    skipped(5, "turn-1"),
    failed(6, "turn-1"),
  ]);
  expect(timelineShowsFailure(fresh, { failureEventId: "evt-6", turnId: "turn-1" })).toBe(true);
});
