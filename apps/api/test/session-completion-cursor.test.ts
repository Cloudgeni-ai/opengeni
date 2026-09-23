import { expect, test } from "bun:test";
import type { Session, SessionEvent } from "@opengeni/contracts";
import { boundSessionCompactDetailMcp } from "../src/mcp/session-view";
import {
  SESSION_WAIT_COMPLETION_EVENT_TYPES,
  sessionWaitCompletionEventMatches,
  waitForSessionChanges,
} from "../src/mcp/session-wait";

test("a completion preceding a session_get snapshot is joined from the consumed event cursor", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const occurredAt = "2026-09-05T00:00:00.000Z";
  const completed: SessionEvent = {
    id,
    workspaceId: id,
    sessionId: id,
    sequence: 42,
    type: "turn.completed",
    payload: { output: "Already-finished child result" },
    occurredAt,
    clientEventId: null,
    turnId: null,
  };
  const snapshot = boundSessionCompactDetailMcp(
    {
      id,
      title: "Child",
      status: "idle",
      lastSequence: completed.sequence,
      updatedAt: occurredAt,
      effectiveControl: { state: "active", primaryBlocker: null, additionalBlockerCount: 0 },
    } as Session,
    { goal: null, progress: null, wait: null },
    null,
  );
  const wait = (afterSequence: number) =>
    waitForSessionChanges({
      targets: [{ sessionId: id, afterSequence }],
      ownSessionId: null,
      maxWaitMs: 0,
      targetEventTypes: SESSION_WAIT_COMPLETION_EVENT_TYPES,
      targetEventMatches: sessionWaitCompletionEventMatches,
      source: {
        readTargetEvents: async (target) => ({
          events: completed.sequence > target.afterSequence ? [completed] : [],
          hasMore: false,
        }),
        readOwnPendingUpdateKinds: null,
        subscribe: async () => () => {},
      },
    });
  for (const consumedCursor of [0, 41]) {
    const joined = await wait(consumedCursor);
    expect(joined.timedOut).toBeFalse();
    expect(joined.changed[0]!.events[0]).toMatchObject({
      sequence: 42,
      text: "Already-finished child result",
    });
  }
  // Exclusive cursor semantics remain intact. A snapshot is not consumption.
  const skipped = await wait(snapshot.lastSequence);
  expect(skipped.changed).toEqual([]);
  expect(skipped.timedOut).toBeTrue();
});
