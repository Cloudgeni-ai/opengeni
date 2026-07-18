import { describe, expect, test } from "bun:test";
import { proveFirstTurnEventOrdering } from "./canary-session-event-ordering";

describe("OPE-63 first-turn production canary proof", () => {
  test("accepts one title, one usage, and one terminal event on a contiguous timeline", () => {
    const events = [
      { id: crypto.randomUUID(), sequence: 1, type: "session.created" },
      { id: crypto.randomUUID(), sequence: 2, type: "turn.queued", turnId: crypto.randomUUID() },
      {
        id: crypto.randomUUID(),
        sequence: 3,
        type: "turn.started",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      { id: crypto.randomUUID(), sequence: 4, type: "session.title_set" },
      {
        id: crypto.randomUUID(),
        sequence: 5,
        type: "agent.model.usage",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      {
        id: crypto.randomUUID(),
        sequence: 6,
        type: "turn.completed",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ];
    expect(proveFirstTurnEventOrdering(events, 6)).toMatchObject({
      eventCount: 6,
      firstSequence: 1,
      lastSequence: 6,
      titleSequence: 4,
      usageSequence: 5,
      terminalSequence: 6,
    });
  });

  test("rejects duplicate usage, sequence gaps, and failure terminals", () => {
    const base = [
      { id: crypto.randomUUID(), sequence: 1, type: "session.title_set" },
      {
        id: crypto.randomUUID(),
        sequence: 2,
        type: "turn.started",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
      {
        id: crypto.randomUUID(),
        sequence: 3,
        type: "agent.model.usage",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      {
        id: crypto.randomUUID(),
        sequence: 4,
        type: "turn.completed",
        turnId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        turnAttemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    ];
    expect(() =>
      proveFirstTurnEventOrdering(
        [...base, { ...base[2]!, id: crypto.randomUUID(), sequence: 5 }],
        5,
      ),
    ).toThrow("Expected exactly one agent.model.usage");
    expect(() =>
      proveFirstTurnEventOrdering(
        base.map((event, index) => ({ ...event, sequence: index === 3 ? 5 : event.sequence })),
        5,
      ),
    ).toThrow("not unique and contiguous");
    expect(() =>
      proveFirstTurnEventOrdering(
        [...base, { id: crypto.randomUUID(), sequence: 5, type: "turn.failed" }],
        5,
      ),
    ).toThrow("forbidden terminal event turn.failed");
  });
});
