import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/contracts";
import { completeChildReadSequences } from "../src/mcp/child-read-evidence";
import { summarizeSessionWaitEvent, boundSessionWaitResult } from "../src/mcp/session-wait";

describe("complete child content evidence", () => {
  test("only complete returned conversational/result items count, not page cursors", () => {
    expect(
      completeChildReadSequences({
        view: "results",
        sourceExact: true,
        events: [{ sequence: 2141, text: "complete result" }],
      }),
    ).toEqual([2141]);
    expect(
      completeChildReadSequences({
        view: "conversation",
        sourceExact: true,
        events: [
          { sequence: 2, fragment: { offset: 0, complete: true } },
          { sequence: 3, fragment: { offset: 0, complete: false } },
          { sequence: 4, fragment: { offset: 100, complete: true } },
          { sequence: 5, sourceOmitted: true },
        ],
      }),
    ).toEqual([2]);
  });
  test("tools, omitted source and malformed fragments prove nothing", () => {
    for (const view of ["tools", "debug"]) {
      expect(
        completeChildReadSequences({ view, sourceExact: true, events: [{ sequence: 1 }] }),
      ).toEqual([]);
    }
    expect(
      completeChildReadSequences({
        view: "results",
        sourceExact: false,
        events: [{ sequence: 1 }],
      }),
    ).toEqual([]);
    expect(
      completeChildReadSequences({
        view: "results",
        sourceExact: true,
        events: [{ sequence: 1, fragment: null }],
      }),
    ).toEqual([]);
  });
  const event = (type: SessionEvent["type"], payload: unknown): SessionEvent => ({
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    sequence: 2141,
    type,
    payload,
    occurredAt: "2026-09-20T18:23:59Z",
  });
  test("waits prove small whole answers, never truncated text or omitted action details", () => {
    expect(
      summarizeSessionWaitEvent(event("turn.completed", { output: "Answer" })).contentComplete,
    ).toBe(true);
    expect(
      summarizeSessionWaitEvent(event("turn.completed", { output: "x".repeat(100_000) }))
        .contentComplete,
    ).toBe(false);
    expect(
      summarizeSessionWaitEvent(
        event("turn.completed", { output: "one", result: "two", text: "three" }),
      ).contentComplete,
    ).toBe(false);
    expect(
      summarizeSessionWaitEvent(event("session.humanInput.requested", { questions: ["Choose"] }))
        .contentComplete,
    ).toBe(false);
    expect(
      summarizeSessionWaitEvent(
        event("turn.failed", { error: "failed", details: "unprojected recovery" }),
      ).contentComplete,
    ).toBe(false);
  });
  test("envelope tightening cannot turn partial summaries into proof", () => {
    const result = boundSessionWaitResult(
      {
        changed: [
          {
            sessionId: crypto.randomUUID(),
            afterSequence: 0,
            latestSequence: 2141,
            hasMore: false,
            events: Array.from({ length: 20 }, () =>
              summarizeSessionWaitEvent(event("turn.completed", { output: "x".repeat(2000) })),
            ),
          },
        ],
        ownPendingUpdates: 0,
        ownPendingUpdateKinds: [],
        ownPendingImmediateUpdates: 0,
        ownPendingDeferredUpdateKinds: [],
        waitedMs: 0,
        timedOut: false,
        aborted: false,
        liveFanout: true,
      },
      8192,
    );
    expect(result.truncated).toBe(true);
    expect(
      result.changed
        .flatMap((target) => target.events)
        .every((summary) => !summary.contentComplete),
    ).toBe(true);
  });
});
