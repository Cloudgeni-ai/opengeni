import { describe, expect, test } from "bun:test";
import { SessionEvent, type SessionEvent as SessionEventType } from "@opengeni/contracts";
import {
  capEventPage,
  capEventPayload,
  capPayloadValue,
  capSessionDetail,
  DEFAULT_EVENT_CAP,
  DEFAULT_SESSION_DETAIL_CHARS,
  estimateTokensFromChars,
} from "../src/mcp/session-view";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const SESSION = "00000000-0000-4000-8000-000000000002";

function makeEvent(sequence: number, type: SessionEventType["type"], payload: unknown): SessionEventType {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    sequence,
    type,
    payload,
    occurredAt: "2026-06-14T00:00:00.000Z",
    clientEventId: null,
    turnId: null,
  };
}

function jsonChars(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("capPayloadValue", () => {
  test("passes through small scalars and small objects untouched", () => {
    expect(capPayloadValue("ok", 2_000)).toBe("ok");
    expect(capPayloadValue(42, 2_000)).toBe(42);
    expect(capPayloadValue(null, 2_000)).toBe(null);
    const small = { text: "hello", n: 1 };
    expect(capPayloadValue(small, 2_000)).toBe(small);
  });

  test("clamps an over-long string with a head+tail truncation marker", () => {
    const long = "A".repeat(5_000) + "TAILMARK";
    const capped = capPayloadValue(long, 2_000) as string;
    expect(capped.length).toBeLessThan(long.length);
    expect(capped).toContain("chars truncated");
    expect(capped).toContain("page with after/limit");
    expect(capped).toContain("read the session notebook");
    // head retained
    expect(capped.startsWith("A")).toBe(true);
    // tail retained (the most diagnostic part of an output/error survives)
    expect(capped).toContain("TAILMARK");
  });

  test("recurses to clamp the fat leaf inside a nested payload", () => {
    const payload = {
      id: "call_1",
      output: "B".repeat(10_000),
      meta: { ok: true },
    };
    const capped = capPayloadValue(payload, 2_000) as typeof payload;
    expect(capped.id).toBe("call_1");
    expect(capped.meta).toEqual({ ok: true });
    expect(typeof capped.output).toBe("string");
    expect(capped.output).toContain("chars truncated");
    expect(jsonChars(capped)).toBeLessThan(jsonChars(payload));
  });

  test("collapses an object made of thousands of tiny fields to a clamped serialization", () => {
    const fat: Record<string, string> = {};
    for (let i = 0; i < 5_000; i++) {
      fat[`k${i}`] = "v";
    }
    const capped = capPayloadValue(fat, 2_000);
    // Collapsed to a single clamped string near the per-field budget; the raw
    // string length is the budget unit (JSON quote-escaping inflates the
    // serialized form, but that is bounded too).
    expect(typeof capped).toBe("string");
    expect((capped as string).length).toBeLessThanOrEqual(2_000 + 200);
    expect(capped).toContain("chars truncated");
  });

  test("is resilient to cyclic structures via the depth guard", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(() => capPayloadValue(a, 2_000)).not.toThrow();
  });
});

describe("capEventPayload", () => {
  test("returns the same reference when nothing needs trimming", () => {
    const event = makeEvent(1, "turn.started", { turnId: "t1" });
    expect(capEventPayload(event, 2_000)).toBe(event);
  });

  test("clamps a worker's verbatim tool output", () => {
    const event = makeEvent(7, "agent.toolCall.output", {
      id: "call_42",
      output: "X".repeat(60_000),
    });
    const capped = capEventPayload(event, DEFAULT_EVENT_CAP.perFieldChars);
    expect(capped).not.toBe(event);
    expect(jsonChars(capped.payload)).toBeLessThan(jsonChars(event.payload));
    expect((capped.payload as { id: string }).id).toBe("call_42");
  });
});

describe("capEventPage", () => {
  test("empty page yields null nextAfter and no truncation", () => {
    const result = capEventPage([]);
    expect(result.events).toEqual([]);
    expect(result.nextAfter).toBeNull();
    expect(result.truncated).toBe(false);
  });

  test("small page passes through with the real nextAfter", () => {
    const events = [
      makeEvent(10, "user.message", { text: "go" }),
      makeEvent(11, "turn.started", {}),
      makeEvent(12, "agent.message.completed", { text: "done" }),
    ];
    const result = capEventPage(events);
    expect(result.truncated).toBe(false);
    expect(result.events).toHaveLength(3);
    expect(result.nextAfter).toBe(12);
  });

  test("per-event trim keeps every event but shrinks the bytes (no head/tail drop when count is small)", () => {
    // 5 events each with a fat tool output: heavy bytes, but only 5 events so
    // head+tail drop should NOT engage (keepCount default 16).
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent(100 + i, "agent.toolCall.output", { id: `c${i}`, output: "Y".repeat(40_000) }),
    );
    const rawChars = jsonChars(events);
    const result = capEventPage(events);
    expect(result.events).toHaveLength(5);
    expect(result.truncated).toBe(false);
    expect(jsonChars(result.events)).toBeLessThan(rawChars);
    // Each event was clamped near the per-field budget.
    for (const event of result.events) {
      expect(jsonChars(event.payload)).toBeLessThan(DEFAULT_EVENT_CAP.perFieldChars * 2);
    }
  });

  test("over-budget page is reduced to head + marker + tail and stays under budget", () => {
    // 100 fat events. Even after per-event trim (~2k chars each) the page is
    // ~200k chars / ~50k tokens, well over the 10k-token budget -> head/tail.
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent(1_000 + i, "agent.toolCall.output", { id: `call_${i}`, output: "Z".repeat(40_000) }),
    );
    const result = capEventPage(events);
    expect(result.truncated).toBe(true);
    // head (8) + 1 marker + tail (8)
    expect(result.events).toHaveLength(DEFAULT_EVENT_CAP.headEvents + 1 + DEFAULT_EVENT_CAP.tailEvents);

    const marker = result.events[DEFAULT_EVENT_CAP.headEvents]!;
    expect((marker.payload as { _truncated?: boolean })._truncated).toBe(true);
    expect((marker.payload as { droppedCount: number }).droppedCount).toBe(
      100 - DEFAULT_EVENT_CAP.headEvents - DEFAULT_EVENT_CAP.tailEvents,
    );

    // nextAfter still points at the real last event so paging does not skip.
    expect(result.nextAfter).toBe(1_099);

    // The whole capped page is comfortably within the token budget (allow the
    // marker's small fixed overhead).
    expect(estimateTokensFromChars(jsonChars(result.events))).toBeLessThanOrEqual(
      DEFAULT_EVENT_CAP.pageTokenBudget + 200,
    );
  });

  test("the capped page (including the synthetic marker) validates against the SessionEvent contract", () => {
    const events = Array.from({ length: 80 }, (_, i) =>
      makeEvent(5_000 + i, "agent.toolCall.output", { id: `c${i}`, output: "M".repeat(40_000) }),
    );
    const result = capEventPage(events);
    expect(result.truncated).toBe(true);
    for (const event of result.events) {
      // Every returned event — real or synthetic marker — must still parse as a
      // SessionEvent so downstream consumers and the wire contract hold.
      expect(() => SessionEvent.parse(event)).not.toThrow();
    }
  });

  test("kept head is oldest and kept tail is newest (entry context + recent progress)", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent(2_000 + i, "agent.message.completed", { text: "W".repeat(40_000) }),
    );
    const result = capEventPage(events);
    expect(result.events[0]!.sequence).toBe(2_000);
    expect(result.events[result.events.length - 1]!.sequence).toBe(2_099);
  });

  test("sequences in the returned page are monotonic non-decreasing including the marker", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      makeEvent(3_000 + i, "agent.reasoning.delta", { text: "R".repeat(40_000) }),
    );
    const result = capEventPage(events);
    const seqs = result.events.map((event) => event.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
    }
  });

  test("marker carries a pageable omitted-sequence range", () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      makeEvent(4_000 + i, "agent.toolCall.output", { id: `c${i}`, output: "Q".repeat(40_000) }),
    );
    const result = capEventPage(events);
    const marker = result.events[DEFAULT_EVENT_CAP.headEvents]!;
    const range = (marker.payload as { omittedSequenceRange: [number, number] }).omittedSequenceRange;
    // first dropped is head index (8) -> sequence 4008; last dropped is
    // length-tail-1 = 50-8-1 = 41 -> sequence 4041.
    expect(range[0]).toBe(4_008);
    expect(range[1]).toBe(4_041);
  });

  test("does not mutate the input events array or its event objects", () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      makeEvent(6_000 + i, "agent.toolCall.output", { id: `c${i}`, output: "K".repeat(40_000) }),
    );
    const originalLength = events.length;
    const firstPayloadRef = events[0]!.payload;
    capEventPage(events);
    expect(events).toHaveLength(originalLength);
    // The original (uncapped) event object is untouched — caps return copies.
    expect(events[0]!.payload).toBe(firstPayloadRef);
    expect((events[0]!.payload as { output: string }).output).toHaveLength(40_000);
  });
});

describe("capSessionDetail", () => {
  test("returns the same reference when metadata and message are small", () => {
    const session = { metadata: { k: "v" }, initialMessage: "hi", status: "running" };
    expect(capSessionDetail(session)).toBe(session);
  });

  test("clamps unbounded agent-set metadata", () => {
    const session = {
      metadata: { note: "M".repeat(50_000) },
      initialMessage: "small",
    };
    const capped = capSessionDetail(session);
    expect(capped).not.toBe(session);
    expect(jsonChars(capped.metadata)).toBeLessThan(jsonChars(session.metadata));
    expect((capped.metadata as { note: string }).note).toContain("chars truncated");
    // unrelated fields preserved
    expect(capped.initialMessage).toBe("small");
  });

  test("clamps an over-long initial message", () => {
    const session = { metadata: {}, initialMessage: "I".repeat(DEFAULT_SESSION_DETAIL_CHARS + 5_000) };
    const capped = capSessionDetail(session);
    expect((capped.initialMessage as string).length).toBeLessThan(session.initialMessage.length);
    expect(capped.initialMessage).toContain("chars truncated");
  });
});
