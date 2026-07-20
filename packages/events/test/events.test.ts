import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_HTTP_PAGE_MAX_BYTES,
  SESSION_EVENT_NATS_MESSAGE_MAX_BYTES,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  WORKSPACE_CONTROL_HTTP_PAGE_MAX_BYTES,
  WORKSPACE_CONTROL_NATS_MESSAGE_MAX_BYTES,
  boundSessionEventHttpPage,
  boundWorkspaceControlHttpPage,
  formatSessionEventSse,
  formatSse,
  formatWorkspaceControlEventSse,
  sessionEventBatchesByBytes,
  workspaceControlEventNatsPayload,
} from "../src/index";
import {
  boundSessionEvent,
  sessionEventJsonBytes,
  sessionEventPayloadTruncation,
  type SessionEvent,
  type WorkspaceControlEvent,
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
    JSON.stringify({
      workspaceId: WORKSPACE_ID,
      sessionId: SESSION_ID,
      events,
    }),
  ).byteLength;
}

function controlEvent(sequence: number, reason = "operator pause"): WorkspaceControlEvent {
  return {
    id: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sequence,
    revision: sequence,
    type: "workspace.control.changed",
    scope: "workspace",
    rootSessionId: null,
    action: sequence % 2 === 0 ? "resume" : "pause",
    automatic: false,
    reason,
    actor: `actor-${"界".repeat(100_000)}`,
    occurredAt: new Date(1_770_000_000_000 + sequence).toISOString(),
  };
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
    expect(boundary?.fullEvidence).toEqual({
      available: false,
      reason: "not_retained",
    });
    expect(data).not.toContain("data:image/png;base64");
    expect(data).toContain("HEAD-");
    expect(data).toContain("-TAIL");
  });

  test("bounds and explicitly identifies malformed multibyte event envelope fields", () => {
    const legacy = {
      ...event(9, { id: "legacy-envelope", output: "small" }),
      type: `bad\r\ntype-${"界".repeat(100_000)}`,
      clientEventId: "🙂".repeat(100_000),
      duplicateReason: "界".repeat(100_000),
    } as SessionEvent;

    const frame = formatSessionEventSse(legacy);
    const decoded = JSON.parse(
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice("data: ".length),
    ) as SessionEvent;
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(decoded.type).toBe("session.event.envelope_omitted");
    expect(decoded.payload).toMatchObject({
      envelopeProjection: {
        truncated: true,
        surface: "sse_legacy_guard",
        fields: expect.arrayContaining([
          expect.objectContaining({ field: "type" }),
          expect.objectContaining({ field: "clientEventId" }),
          expect.objectContaining({ field: "duplicateReason" }),
        ]),
      },
      fullEvidence: { available: false, reason: "not_retained" },
    });
  });
});

describe("session event transport envelopes", () => {
  test("never invokes serializers or accessors while bounding adversarial complete events", () => {
    let serializerCalls = 0;
    let accessorCalls = 0;
    const custom = {
      visible: "kept",
      toJSON() {
        serializerCalls += 1;
        return "must-not-run";
      },
    };
    Object.defineProperty(custom, "dangerous", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-run";
      },
    });
    const customDate = new Date("2026-07-19T03:00:00.000Z");
    Object.defineProperty(customDate, "toJSON", {
      enumerable: true,
      value() {
        serializerCalls += 1;
        return "must-not-run";
      },
    });
    const arrayWithAccessor = ["placeholder"];
    Object.defineProperty(arrayWithAccessor, "0", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-run";
      },
    });
    const payload: Record<string, unknown> = {
      id: "poison-output",
      custom,
      customDate,
      arrayWithAccessor,
      visible: `HEAD-${"x".repeat(200_000)}-TAIL`,
    };
    for (let index = 0; index < 10_000; index += 1) {
      payload[`omitted-${index}`] = index % 3 === 0 ? undefined : () => Symbol("omitted");
    }
    const poison = event(81, payload);

    const direct = boundSessionEvent(poison);
    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [poison]);
    const frame = formatSessionEventSse(poison);
    const page = boundSessionEventHttpPage([poison], { direction: "after" });

    expect(serializerCalls).toBe(0);
    expect(accessorCalls).toBe(0);
    expect(sessionEventPayloadTruncation(direct.payload)).toMatchObject({
      truncated: true,
      reason: "payload_measurement_bounded",
      originalBytes: null,
      omittedBytes: null,
      fullEvidence: { available: false, reason: "not_retained" },
    });
    expect(JSON.stringify(direct)).not.toContain("must-not-run");
    expect(encodedBatchBytes(batches.flat())).toBeLessThanOrEqual(
      SESSION_EVENT_NATS_MESSAGE_MAX_BYTES,
    );
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(page.bytes).toBeLessThanOrEqual(SESSION_EVENT_HTTP_PAGE_MAX_BYTES);
    expect(page.events).toHaveLength(1);
  });

  test("makes event-level custom serialization loss explicit without invoking it", () => {
    let serializerCalls = 0;
    const poison = event(82, { output: "small" }) as SessionEvent & {
      toJSON?: () => unknown;
    };
    poison.toJSON = () => {
      serializerCalls += 1;
      return { output: "must-not-run" };
    };

    const direct = boundSessionEvent(poison);
    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [poison]);
    const frame = formatSessionEventSse(poison);
    const page = boundSessionEventHttpPage([poison], { direction: "after" });

    expect(serializerCalls).toBe(0);
    for (const projected of [direct, batches[0]![0]!, page.events[0]!]) {
      expect(projected.payload).toMatchObject({
        originalEventBytes: null,
        envelopeProjection: {
          truncated: true,
          fields: expect.arrayContaining([
            expect.objectContaining({ field: "toJSON", originalBytes: null }),
          ]),
        },
        fullEvidence: { available: false, reason: "not_retained" },
      });
    }
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(frame).not.toContain("must-not-run");
  });

  test("makes inherited event serialization loss explicit without invoking it", () => {
    let serializerCalls = 0;
    const prototype = {
      toJSON() {
        serializerCalls += 1;
        return { output: "must-not-run" };
      },
    };
    const poison = Object.assign(
      Object.create(prototype) as SessionEvent,
      event(821, { output: "small" }),
    );

    const direct = boundSessionEvent(poison);
    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [poison]);
    const frame = formatSessionEventSse(poison);
    const page = boundSessionEventHttpPage([poison], { direction: "after" });

    expect(serializerCalls).toBe(0);
    for (const projected of [direct, batches[0]![0]!, page.events[0]!]) {
      expect(projected.payload).toMatchObject({
        originalEventBytes: null,
        envelopeProjection: {
          truncated: true,
          fields: expect.arrayContaining([
            expect.objectContaining({ field: "toJSON", originalBytes: null }),
          ]),
        },
        fullEvidence: { available: false, reason: "not_retained" },
      });
    }
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(frame).not.toContain("must-not-run");
  });

  test("makes omitted additive top-level event fields explicit without reading them", () => {
    let accessorCalls = 0;
    const poison = event(822, { output: "small" }) as SessionEvent & {
      futureEnvelope?: unknown;
    };
    Object.defineProperty(poison, "futureEnvelope", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-run";
      },
    });

    const direct = boundSessionEvent(poison);
    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [poison]);
    const frame = formatSessionEventSse(poison);
    const page = boundSessionEventHttpPage([poison], { direction: "after" });

    expect(accessorCalls).toBe(0);
    for (const projected of [direct, batches[0]![0]!, page.events[0]!]) {
      expect(projected.payload).toMatchObject({
        envelopeProjection: {
          truncated: true,
          fields: expect.arrayContaining([
            expect.objectContaining({
              field: "additionalTopLevelFields",
              originalBytes: null,
              deliveredBytes: 0,
            }),
          ]),
        },
        fullEvidence: { available: false, reason: "not_retained" },
      });
    }
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(frame).not.toContain("must-not-run");
  });

  test("normalizes a top-level payload accessor with unknown source bytes on every surface", () => {
    let accessorCalls = 0;
    const poison = event(83, { output: "placeholder" });
    Object.defineProperty(poison, "payload", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return { output: "must-not-run" };
      },
    });

    const direct = boundSessionEvent(poison);
    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [poison]);
    const frame = formatSessionEventSse(poison);
    const page = boundSessionEventHttpPage([poison], { direction: "after" });

    expect(accessorCalls).toBe(0);
    for (const projected of [direct, batches[0]![0]!, page.events[0]!]) {
      expect(projected.payload).toMatchObject({
        originalEventBytes: null,
        envelopeProjection: {
          truncated: true,
          fields: expect.arrayContaining([
            expect.objectContaining({ field: "payload", originalBytes: null }),
          ]),
        },
        fullEvidence: { available: false, reason: "not_retained" },
      });
    }
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(frame).not.toContain("must-not-run");
  });

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
    const page = boundSessionEventHttpPage(events, {
      direction: "after",
      maxBytes: 220_000,
    });

    expect(page.truncated).toBeTrue();
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.map((item) => item.sequence)).toEqual(
      Array.from({ length: page.events.length }, (_, index) => index + 1),
    );
    expect(page.nextSequence).toBe(page.events.at(-1)?.sequence ?? null);
    expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
    expect(page.bytes).toBeLessThanOrEqual(220_000);
  });

  test("advances a compact forward cursor through the coalesced raw range", () => {
    const events = [
      event(10, { text: "one", coalescedUntil: 49 }),
      event(50, { text: "two", coalescedUntil: 73 }),
    ];
    const page = boundSessionEventHttpPage(events, {
      direction: "after",
      maxBytes: sessionEventJsonBytes([events[0]]),
    });

    expect(page.events.map((item) => item.sequence)).toEqual([10]);
    expect(page.truncated).toBeTrue();
    expect(page.nextSequence).toBe(49);
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

describe("workspace-control transport envelopes", () => {
  test("bounds one multi-megabyte legacy invalidation for NATS and SSE", () => {
    const legacy = controlEvent(1, `HEAD-${"🙂".repeat(600_000)}-TAIL`);
    const encoded = workspaceControlEventNatsPayload(legacy);
    const natsEvent = JSON.parse(new TextDecoder().decode(encoded)) as WorkspaceControlEvent;
    const frame = formatWorkspaceControlEventSse(legacy);
    const sseEvent = JSON.parse(
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice("data: ".length),
    ) as WorkspaceControlEvent;

    expect(encoded.byteLength).toBeLessThanOrEqual(WORKSPACE_CONTROL_NATS_MESSAGE_MAX_BYTES);
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(natsEvent.truncation).toMatchObject({
      surface: "nats_legacy_guard",
      fullEvidence: { available: false, reason: "not_retained" },
    });
    expect(sseEvent.truncation).toMatchObject({
      surface: "sse_legacy_guard",
      fullEvidence: { available: false, reason: "not_retained" },
    });
    expect(natsEvent.sequence).toBe(1);
    expect(sseEvent.sequence).toBe(1);
  });

  test("returns a count-plus-byte-bounded prefix with a truthful next cursor", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      controlEvent(index + 1, `reason-${index}-${"x".repeat(20_000)}`),
    );
    const page = boundWorkspaceControlHttpPage(events, 40_000);

    expect(page.truncated).toBeTrue();
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.map((item) => item.sequence)).toEqual(
      Array.from({ length: page.events.length }, (_, index) => index + 1),
    );
    expect(page.nextSequence).toBe(page.events.at(-1)?.sequence ?? null);
    expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
    expect(page.bytes).toBeLessThanOrEqual(40_000);
    expect(page.bytes).toBeLessThanOrEqual(WORKSPACE_CONTROL_HTTP_PAGE_MAX_BYTES);
  });
});
