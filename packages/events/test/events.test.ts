import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_HTTP_PAGE_MAX_BYTES,
  SESSION_EVENT_NATS_MESSAGE_MAX_BYTES,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  boundSessionEventHttpPage,
  formatSessionEventSse,
  formatSse,
  sessionEventBatchesByBytes,
} from "../src/index";
import {
  sessionEventJsonBytes,
  sessionEventPayloadTruncation,
  type SessionEvent,
} from "@opengeni/contracts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function event(sequence: number, payload: unknown): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type: "agent.toolCall.output",
    payload,
    occurredAt: new Date(1_770_000_000_000 + sequence).toISOString(),
    clientEventId: null,
    turnId: null,
  };
}

function encodedBatchBytes(events: SessionEvent[]): number {
  return new TextEncoder().encode(
    JSON.stringify({ workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, events }),
  ).byteLength;
}

describe("SSE formatting", () => {
  test("formats session events as named SSE messages", () => {
    const text = formatSse({
      id: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      sequence: 7,
      type: "agent.message.delta",
      payload: { text: "hello" },
      occurredAt: "2026-05-06T00:00:00.000Z",
      clientEventId: null,
      turnId: null,
    });

    expect(text).toContain("id: 7\n");
    expect(text).toContain("event: agent.message.delta\n");
    expect(text).toContain('"text":"hello"');
    expect(text.endsWith("\n\n")).toBe(true);
  });

  test("bounds legacy multi-megabyte text, image, and error payloads in one explicit frame", () => {
    const legacy = event(8, {
      id: "parallel-call",
      name: "computer_screenshot",
      isError: true,
      output: [
        `HEAD-${"x".repeat(2 * 1024 * 1024)}-TAIL`,
        `data:image/png;base64,${"A".repeat(2 * 1024 * 1024)}`,
        { code: "EOUTPUT", message: "boom".repeat(500_000) },
      ],
    });

    const frame = formatSessionEventSse(legacy);
    const bytes = new TextEncoder().encode(frame).byteLength;
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))!
      .slice("data: ".length);
    const decoded = JSON.parse(data) as SessionEvent;
    const boundary = sessionEventPayloadTruncation(decoded.payload);

    expect(bytes).toBeLessThanOrEqual(SESSION_EVENT_SSE_FRAME_MAX_BYTES);
    expect(decoded.sequence).toBe(8);
    expect(boundary?.surface).toBe("sse_legacy_guard");
    expect(boundary?.fullEvidence).toEqual({ available: false, reason: "not_retained" });
    expect(data).not.toContain("data:image/png;base64");
    expect(data).toContain("HEAD-");
    expect(data).toContain("-TAIL");
  });
});

describe("session event transport envelopes", () => {
  test("chunks parallel NATS batches by exact encoded bytes without reordering", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      event(index + 1, {
        id: `call-${index + 1}`,
        output: `head-${index}-${"x".repeat(80_000)}-tail-${index}`,
      }),
    );

    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, events);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().map((item) => item.sequence)).toEqual(
      events.map((item) => item.sequence),
    );
    for (const batch of batches) {
      expect(encodedBatchBytes(batch)).toBeLessThanOrEqual(SESSION_EVENT_NATS_MESSAGE_MAX_BYTES);
    }
    for (const item of batches.flat()) {
      expect(sessionEventPayloadTruncation(item.payload)?.surface).toBe("nats_legacy_guard");
    }
  });

  test("rejects an impossible custom NATS envelope instead of emitting an oversized message", () => {
    expect(() => sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [event(1, {})], 32)).toThrow(
      "cannot fit",
    );
  });

  test("returns a byte-bounded forward prefix with a truthful resume cursor", () => {
    const events = Array.from({ length: 40 }, (_, index) =>
      event(index + 1, { output: `value-${index}-${"x".repeat(50_000)}` }),
    );
    const page = boundSessionEventHttpPage(events, { direction: "after", maxBytes: 220_000 });

    expect(page.truncated).toBeTrue();
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.map((item) => item.sequence)).toEqual(
      Array.from({ length: page.events.length }, (_, index) => index + 1),
    );
    expect(page.nextSequence).toBe(page.events.at(-1)?.sequence ?? null);
    expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
    expect(page.bytes).toBeLessThanOrEqual(220_000);
  });

  test("returns a byte-bounded backward suffix and defensively normalizes a legacy first row", () => {
    const events = [
      event(1, { output: "a" }),
      event(2, { output: "b" }),
      event(3, { output: `HEAD-${"z".repeat(3 * 1024 * 1024)}-TAIL` }),
    ];
    const page = boundSessionEventHttpPage(events, {
      direction: "before",
      maxBytes: SESSION_EVENT_HTTP_PAGE_MAX_BYTES,
    });

    expect(page.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(page.nextSequence).toBe(1);
    expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
    expect(page.bytes).toBeLessThanOrEqual(SESSION_EVENT_HTTP_PAGE_MAX_BYTES);
    expect(sessionEventPayloadTruncation(page.events.at(-1)?.payload)?.surface).toBe(
      "http_projection",
    );
  });
});
