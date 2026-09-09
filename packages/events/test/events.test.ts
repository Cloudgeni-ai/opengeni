import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_HTTP_PAGE_MAX_BYTES,
  SESSION_EVENT_NATS_MESSAGE_MAX_BYTES,
  SESSION_EVENT_SSE_FRAME_MAX_BYTES,
  WORKSPACE_CONTROL_HTTP_PAGE_MAX_BYTES,
  WORKSPACE_CONTROL_NATS_MESSAGE_MAX_BYTES,
  boundSessionEventHttpPage,
  boundWorkspaceControlHttpPage,
  createNatsEventBus,
  formatSessionEventSse,
  formatSse,
  formatWorkspaceControlEventSse,
  sessionEventBatchesByBytes,
  workspaceControlEventNatsPayload,
} from "../src/index";
import {
  boundSessionEvent,
  boundSessionEventPayload,
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

  test("carries trusted compact coverage in the SSE id and event body", () => {
    const compact = { ...event(10, { text: "compact" }), coveredThrough: 49 };
    const text = formatSessionEventSse(compact, 49);
    const data = text
      .split("\n")
      .find((line) => line.startsWith("data: "))!
      .slice("data: ".length);

    expect(text).toContain("id: 49\n");
    expect(JSON.parse(data)).toMatchObject({ sequence: 10, coveredThrough: 49 });
  });

  test("serializes canonical multi-megabyte text, image, and error payloads exactly", () => {
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
    expect(bytes).toBeGreaterThan(SESSION_EVENT_SSE_FRAME_MAX_BYTES);
    expect(decoded).toEqual(legacy);
    expect(data).toBe(JSON.stringify(legacy));
    expect(sessionEventPayloadTruncation(decoded.payload)).toBeNull();
  });

  test("explicit bounding identifies malformed multibyte event envelope fields", () => {
    const legacy = {
      ...event(9, { id: "legacy-envelope", output: "small" }),
      type: `bad\r\ntype-${"界".repeat(100_000)}`,
      clientEventId: "🙂".repeat(100_000),
      duplicateReason: "界".repeat(100_000),
    } as SessionEvent;

    const decoded = boundSessionEvent(legacy, { surface: "http_projection" });
    expect(sessionEventJsonBytes(decoded)).toBeLessThanOrEqual(SESSION_EVENT_SSE_FRAME_MAX_BYTES);
    expect(decoded.type).toBe("session.event.envelope_omitted");
    expect(decoded.payload).toMatchObject({
      envelopeProjection: {
        truncated: true,
        surface: "http_projection",
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
  test("delivers malformed legacy types through safe SSE framing without rewriting content", () => {
    const invalid = {
      ...event(1, { text: "full message" }),
      type: "bad\nevent: forged",
    } as SessionEvent;
    const frame = formatSessionEventSse(invalid);
    expect(frame.split("\n")[1]).toBe("event: session.event.envelope_omitted");
    expect(
      JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      ),
    ).toEqual(invalid);
    expect(formatSessionEventSse(event(2, { text: "next" }))).toStartWith("id: 2\n");
  });
  test("preserves a trusted retained receipt across bounded transports and content-free telemetry", async () => {
    const artifactId = "33333333-3333-4333-8333-333333333333";
    const receipt = {
      available: true as const,
      artifactId,
      kind: "tool_result" as const,
      contentType: "application/json",
      originalBytes: 4 * 1024 * 1024,
      sha256: "a".repeat(64),
      retainedAt: "2026-07-21T00:00:00.000Z",
      retention: { policy: "workspace_file" as const, expiresAt: null },
      retrieval: {
        method: "GET" as const,
        path: `/v1/workspaces/${WORKSPACE_ID}/artifacts/${artifactId}/content`,
        acceptRanges: "bytes" as const,
        maxRangeBytes: 1024 * 1024,
      },
    };
    const payload = boundSessionEventPayload(
      { id: "tool-call", output: `HEAD-${"x".repeat(200_000)}-TAIL` },
      { fullEvidence: receipt },
    );
    const retained = event(80, payload);

    const batches = sessionEventBatchesByBytes(WORKSPACE_ID, SESSION_ID, [retained]);
    const frame = formatSessionEventSse(retained);
    const page = boundSessionEventHttpPage([retained], { direction: "after" });
    for (const projected of [batches[0]![0]!, page.events[0]!]) {
      expect(sessionEventPayloadTruncation(projected.payload)?.fullEvidence).toEqual(receipt);
    }
    const sseEvent = JSON.parse(
      frame
        .split("\n")
        .find((line) => line.startsWith("data: "))!
        .slice("data: ".length),
    ) as SessionEvent;
    expect(sessionEventPayloadTruncation(sseEvent.payload)?.fullEvidence).toEqual(receipt);
    expect(encodedBatchBytes(batches[0]!)).toBeLessThanOrEqual(
      SESSION_EVENT_NATS_MESSAGE_MAX_BYTES,
    );
    expect(new TextEncoder().encode(frame).byteLength).toBeLessThanOrEqual(
      SESSION_EVENT_SSE_FRAME_MAX_BYTES,
    );
    expect(page.bytes).toBeLessThanOrEqual(SESSION_EVENT_HTTP_PAGE_MAX_BYTES);

    const telemetry: Array<Record<string, unknown>> = [];
    const emptyAsyncIterable = () => (async function* () {})();
    const bus = await createNatsEventBus("nats://retained-output.test:4222", undefined, {
      connect: async () =>
        ({
          status: emptyAsyncIterable,
          subscribe: () => Object.assign(emptyAsyncIterable(), { unsubscribe() {} }),
          publish() {},
          async flush() {},
          async drain() {},
          async request() {
            return { data: new Uint8Array() };
          },
          isClosed: () => false,
          isDraining: () => false,
        }) as never,
      logger: {
        debug(message, attributes) {
          if (message === "Session event payload is a bounded audit preview" && attributes) {
            telemetry.push(attributes);
          }
        },
      },
    });
    await bus.publish(WORKSPACE_ID, SESSION_ID, [retained]);
    await bus.close();
    expect(telemetry).toEqual([
      expect.objectContaining({
        fullEvidenceAvailable: true,
        retainedOutputKind: "tool_result",
        originalBytes: expect.any(Number),
        deliveredBytes: expect.any(Number),
        estimatedOriginalTokens: expect.any(Number),
        estimatedDeliveredTokens: expect.any(Number),
      }),
    ]);
    const logged = JSON.stringify(telemetry);
    expect(logged).not.toContain(artifactId);
    expect(logged).not.toContain(WORKSPACE_ID);
    expect(logged).not.toContain(SESSION_ID);
    expect(logged).not.toContain("HEAD-");
    expect(logged).not.toContain("TAIL");
  });

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
    const page = boundSessionEventHttpPage([poison], {
      direction: "after",
      eventProjection: "bounded",
    });

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
    const page = boundSessionEventHttpPage([poison], {
      direction: "after",
      eventProjection: "bounded",
    });

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
    expect(JSON.stringify([direct, batches, page.events])).not.toContain("must-not-run");
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
    const page = boundSessionEventHttpPage([poison], {
      direction: "after",
      eventProjection: "bounded",
    });

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
    expect(JSON.stringify([direct, batches, page.events])).not.toContain("must-not-run");
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
    const page = boundSessionEventHttpPage([poison], {
      direction: "after",
      eventProjection: "bounded",
    });

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
    expect(JSON.stringify([direct, batches, page.events])).not.toContain("must-not-run");
  });

  test("normalizes a top-level payload accessor with unknown source bytes on explicit bounded surfaces", () => {
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
    const page = boundSessionEventHttpPage([poison], {
      direction: "after",
      eventProjection: "bounded",
    });

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
    expect(JSON.stringify([direct, batches, page.events])).not.toContain("must-not-run");
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
      coveredThroughBySequence: new Map([
        [10, 49],
        [50, 73],
      ]),
    });

    expect(page.events.map((item) => item.sequence)).toEqual([10]);
    expect(page.truncated).toBeTrue();
    expect(page.nextSequence).toBe(49);
  });

  test("never trusts producer-controlled coalescedUntil as cursor provenance", () => {
    const retained = event(10, { text: "ordinary", coalescedUntil: 1000 });
    const page = boundSessionEventHttpPage([retained], { direction: "after" });

    expect(page.events[0]?.payload).toMatchObject({ coalescedUntil: 1000 });
    expect(page.nextSequence).toBe(10);
  });

  test("explicit bounded HTTP normalizes an oversized row in a backward page", () => {
    const events = [
      event(1, { output: "a" }),
      event(2, { output: "b" }),
      event(3, { output: `HEAD-${"z".repeat(3 * 1024 * 1024)}-TAIL` }),
    ];
    const page = boundSessionEventHttpPage(events, {
      direction: "before",
      maxBytes: SESSION_EVENT_HTTP_PAGE_MAX_BYTES,
      eventProjection: "bounded",
    });

    expect(page.events.map((item) => item.sequence)).toEqual([1, 2, 3]);
    expect(page.nextSequence).toBe(1);
    expect(page.bytes).toBe(sessionEventJsonBytes(page.events));
    expect(page.bytes).toBeLessThanOrEqual(SESSION_EVENT_HTTP_PAGE_MAX_BYTES);
    expect(sessionEventPayloadTruncation(page.events.at(-1)?.payload)?.surface).toBe(
      "http_projection",
    );
  });

  test("preserves canonical oversized payloads by default and bounds only explicit diagnostic HTTP pages", () => {
    const payload = {
      id: "forensic-call",
      output: {
        id: "forensic-call-oversized",
        output: "界".repeat(Math.ceil((128 * 1024) / 3)),
      },
    };
    const retained = event(90, payload);

    const exact = boundSessionEventHttpPage([retained], {
      direction: "after",
      eventProjection: "exact",
    });
    expect(exact.events).toEqual([retained]);
    expect(exact.events[0]?.payload).toEqual(payload);
    expect(sessionEventPayloadTruncation(exact.events[0]?.payload)).toBeNull();

    const defaultPage = boundSessionEventHttpPage([retained], { direction: "after" });
    expect(defaultPage).toEqual(exact);

    const bounded = boundSessionEventHttpPage([retained], {
      direction: "after",
      eventProjection: "bounded",
    });
    expect(bounded.events[0]?.payload).not.toEqual(payload);
    expect(sessionEventPayloadTruncation(bounded.events[0]?.payload)?.surface).toBe(
      "http_projection",
    );
  });

  for (const direction of ["after", "before"] as const) {
    test(`default exact HTTP admits an oversized first event alone and resumes ${direction} without gaps`, () => {
      const text = `start\n${'界🙂e\u0301"\\\n'.repeat(150_000)}\nend`;
      const oversized: SessionEvent = { ...event(2, { text }), type: "agent.message.completed" };
      const events = [event(1, { text: "before" }), oversized, event(3, { text: "after" })];
      const candidates = direction === "after" ? events.slice(1) : events.slice(0, 2);
      const page = boundSessionEventHttpPage(candidates, { direction });

      expect(page.events).toEqual([oversized]);
      expect(page.bytes).toBe(sessionEventJsonBytes([oversized]));
      expect(page.bytes).toBeGreaterThan(SESSION_EVENT_HTTP_PAGE_MAX_BYTES);
      expect(page.truncated).toBeTrue();
      expect(page.nextSequence).toBe(2);

      const remaining = candidates.filter((item) =>
        direction === "after"
          ? item.sequence > page.nextSequence!
          : item.sequence < page.nextSequence!,
      );
      const next = boundSessionEventHttpPage(remaining, { direction });
      expect(next.events).toEqual([direction === "after" ? events[2]! : events[0]!]);
      expect(next.nextSequence).toBe(direction === "after" ? 3 : 1);
      expect(next.truncated).toBeFalse();
      expect(
        direction === "after" ? [...page.events, ...next.events] : [...next.events, ...page.events],
      ).toEqual(candidates);

      const alone = boundSessionEventHttpPage([oversized], { direction });
      expect(alone.events).toEqual([oversized]);
      expect(alone.truncated).toBeFalse();
      expect(alone.nextSequence).toBe(2);
    });
  }
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
