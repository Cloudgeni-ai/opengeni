import { describe, expect, test } from "bun:test";
import {
  EVENT_DATA_MAX_BYTES,
  SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES,
  SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES,
  type InboundEvent,
} from "@opengeni/contracts";
import {
  boundEvent,
  boundEventData,
  eventMatchesTrigger,
  eventTypeMatches,
  generateStandardWebhookSecret,
  jsonUtf8Bytes,
  scheduledOccurrenceEvents,
  signHexBodyHmac,
  signStandardWebhook,
  standardWebhookSecretKey,
  verifyStandardWebhook,
  webhookAdapter,
  WebhookBodyError,
  type MatchableEvent,
} from "../src/domain/event-triggers";

const encoder = new TextEncoder();

function headersOf(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("Standard Webhooks signatures", () => {
  const secret = generateStandardWebhookSecret();
  const body = encoder.encode(JSON.stringify({ type: "deploy.finished", data: { id: "d1" } }));
  const now = 1_800_000_000;

  test("generated secrets are whsec_ with 32 random bytes", () => {
    expect(secret.startsWith("whsec_")).toBe(true);
    expect(standardWebhookSecretKey(secret)?.byteLength).toBe(32);
    expect(standardWebhookSecretKey("whsec_short")).toBeNull();
    expect(standardWebhookSecretKey("not-a-secret")).toBeNull();
  });

  test("a signed delivery verifies over the exact body", () => {
    const headers = signStandardWebhook({
      secret,
      webhookId: "msg_1",
      body,
      timestampSeconds: now,
    });
    expect(
      verifyStandardWebhook({
        secret,
        headers: headersOf(headers),
        body,
        nowSeconds: now,
      }),
    ).toEqual({
      ok: true,
      webhookId: "msg_1",
      timestampSeconds: now,
    });
    const tampered = encoder.encode(new TextDecoder().decode(body).replace("d1", "d2"));
    expect(
      verifyStandardWebhook({
        secret,
        headers: headersOf(headers),
        body: tampered,
        nowSeconds: now,
      }).ok,
    ).toBe(false);
  });

  test("any of several v1 signatures may match, and v1a entries are ignored", () => {
    const headers = signStandardWebhook({
      secret,
      webhookId: "msg_2",
      body,
      timestampSeconds: now,
    });
    const rotated = {
      ...headers,
      "webhook-signature": `v1a,AAAA v1,${Buffer.alloc(32).toString("base64")} ${headers["webhook-signature"]}`,
    };
    expect(
      verifyStandardWebhook({
        secret,
        headers: headersOf(rotated),
        body,
        nowSeconds: now,
      }).ok,
    ).toBe(true);
  });

  test("deliveries signed outside the five minute window are refused", () => {
    const headers = signStandardWebhook({
      secret,
      webhookId: "msg_3",
      body,
      timestampSeconds: now,
    });
    const late = verifyStandardWebhook({
      secret,
      headers: headersOf(headers),
      body,
      nowSeconds: now + 301,
    });
    expect(late).toEqual({
      ok: false,
      reason: "The delivery was signed more than 5 minutes from now",
    });
  });

  test("missing headers and a wrong secret are refused", () => {
    expect(
      verifyStandardWebhook({
        secret,
        headers: headersOf({}),
        body,
        nowSeconds: now,
      }).ok,
    ).toBe(false);
    const headers = signStandardWebhook({
      secret,
      webhookId: "msg_4",
      body,
      timestampSeconds: now,
    });
    expect(
      verifyStandardWebhook({
        secret: generateStandardWebhookSecret(),
        headers: headersOf(headers),
        body,
        nowSeconds: now,
      }).ok,
    ).toBe(false);
  });
});

describe("webhook adapters", () => {
  const receivedAt = new Date("2026-10-24T10:00:00.000Z");

  test("standard adapter reads type, time, subject and data", () => {
    const adapter = webhookAdapter("standard");
    const secret = generateStandardWebhookSecret();
    const body = encoder.encode(
      JSON.stringify({
        type: "invoice.paid",
        timestamp: "2026-10-24T09:59:00.000Z",
        data: {
          id: "inv_1",
          title: "Invoice 1 paid",
          url: "https://billing.example/inv_1",
        },
      }),
    );
    const headers = headersOf(
      signStandardWebhook({
        secret,
        webhookId: "msg_9",
        body,
        timestampSeconds: receivedAt.getTime() / 1000,
      }),
    );
    expect(
      adapter.verify({
        secret,
        headers,
        body,
        nowSeconds: receivedAt.getTime() / 1000,
      }),
    ).toEqual({
      ok: true,
      deliveryKey: "webhook-id:msg_9",
    });
    const reading = adapter.read({ headers, body, receivedAt });
    expect(reading.kind).toBe("events");
    if (reading.kind !== "events") return;
    expect(reading.events[0]).toMatchObject({
      type: "invoice.paid",
      subject: "inv_1",
      summary: "Invoice 1 paid",
      url: "https://billing.example/inv_1",
      occurredAt: new Date("2026-10-24T09:59:00.000Z"),
      data: { id: "inv_1" },
    });
  });

  test("standard adapter refuses a body without a type", () => {
    expect(() =>
      webhookAdapter("standard").read({
        headers: headersOf({}),
        body: encoder.encode(JSON.stringify({ data: {} })),
        receivedAt,
      }),
    ).toThrow(WebhookBodyError);
  });

  test("linear adapter verifies the signature and timestamp and names Issue.create", () => {
    const adapter = webhookAdapter("linear");
    const secret = "lin_wh_secret_value";
    const payload = {
      action: "create",
      type: "Issue",
      createdAt: "2026-10-24T09:59:30.000Z",
      actor: { id: "u1", type: "user", name: "Ada" },
      url: "https://linear.app/acme/issue/ENG-42/fix-login",
      data: {
        id: "issue-uuid",
        identifier: "ENG-42",
        title: "Fix login",
        priority: 2,
      },
      webhookId: "webhook-config-id",
      webhookTimestamp: receivedAt.getTime() - 5_000,
    };
    const body = encoder.encode(JSON.stringify(payload));
    const headers = headersOf({
      "linear-signature": signHexBodyHmac(secret, body),
      "linear-delivery": "delivery-1",
      "linear-event": "Issue",
    });
    expect(
      adapter.verify({
        secret,
        headers,
        body,
        nowSeconds: receivedAt.getTime() / 1000,
      }),
    ).toEqual({
      ok: true,
      deliveryKey: "linear-delivery:delivery-1",
    });
    expect(
      adapter.verify({
        secret,
        headers,
        body,
        nowSeconds: receivedAt.getTime() / 1000 + 120,
      }).ok,
    ).toBe(false);
    expect(
      adapter.verify({
        secret: "other",
        headers,
        body,
        nowSeconds: receivedAt.getTime() / 1000,
      }).ok,
    ).toBe(false);
    const reading = adapter.read({ headers, body, receivedAt });
    if (reading.kind !== "events") throw new Error("expected events");
    const [event] = reading.events;
    expect(event).toMatchObject({
      externalId: null,
      type: "Issue.create",
      subject: "ENG-42",
      summary: "Issue created: ENG-42 Fix login",
      actor: { kind: "person", name: "Ada" },
    });
    expect(event?.data.webhookId).toBeUndefined();
  });

  test("sentry adapter names the resource and action from the header", () => {
    const adapter = webhookAdapter("sentry");
    const secret = "sentry-client-secret";
    const body = encoder.encode(
      JSON.stringify({
        action: "created",
        actor: { type: "application", name: "Sentry" },
        data: {
          issue: {
            id: "123",
            shortId: "API-7",
            title: "TypeError: x is undefined",
            web_url: "https://acme.sentry.io/issues/123/",
            lastSeen: "2026-10-24T09:58:00.000Z",
          },
        },
      }),
    );
    const headers = headersOf({
      "sentry-hook-signature": signHexBodyHmac(secret, body),
      "sentry-hook-resource": "issue",
      "request-id": "req-1",
    });
    expect(adapter.verify({ secret, headers, body })).toEqual({
      ok: true,
      deliveryKey: "request-id:req-1",
    });
    const reading = adapter.read({ headers, body, receivedAt });
    if (reading.kind !== "events") throw new Error("expected events");
    expect(reading.events[0]).toMatchObject({
      type: "issue.created",
      subject: "API-7",
      summary: "issue created: API-7 TypeError: x is undefined",
      url: "https://acme.sentry.io/issues/123/",
      actor: { kind: "bot", name: "Sentry" },
      occurredAt: new Date("2026-10-24T09:58:00.000Z"),
    });
  });
});

describe("event bounds", () => {
  test("data that fits is kept as is", () => {
    expect(boundEventData({ a: 1, b: "x" })).toEqual({
      data: { a: 1, b: "x" },
      truncated: false,
    });
    expect(boundEventData("scalar")).toEqual({
      data: { value: "scalar" },
      truncated: false,
    });
  });

  test("large data is cut to the budget", () => {
    const large = {
      text: "x".repeat(200_000),
      list: Array.from({ length: 5_000 }, (_, i) => ({ i })),
    };
    const bounded = boundEventData(large);
    expect(bounded.truncated).toBe(true);
    expect(jsonUtf8Bytes(bounded.data)).toBeLessThanOrEqual(EVENT_DATA_MAX_BYTES);
    expect(typeof bounded.data.text).toBe("string");
  });

  test("events are bounded field by field", () => {
    const event = boundEvent(
      {
        externalId: "e".repeat(600),
        type: "a.b",
        occurredAt: new Date(Number.NaN),
        subject: " multi\nline ",
        summary: "  ",
        url: "javascript:alert(1)",
        actor: { kind: "person", name: "Ada\nLovelace" },
        data: {},
      },
      new Date("2026-10-24T10:00:00.000Z"),
    );
    expect(event).toMatchObject({
      externalId: null,
      occurredAt: new Date("2026-10-24T10:00:00.000Z"),
      subject: "multi line",
      summary: "a.b",
      url: null,
      actor: { kind: "person", name: "Ada Lovelace" },
      streamKey: "",
      gapBefore: false,
    });
  });
});

describe("trigger matching", () => {
  const event: MatchableEvent = {
    type: "pull_request.opened",
    subject: "acme/api#42",
    summary: "Pull request opened: Add retries",
    url: "https://github.com/acme/api/pull/42",
    actor: { kind: "person", name: "ada" },
    data: {
      repository: "acme/api",
      pull_request: { draft: false, labels: ["bug", "p1"] },
      number: 42,
    },
  };

  test("type patterns", () => {
    expect(eventTypeMatches("*", "anything")).toBe(true);
    expect(eventTypeMatches("pull_request.*", "pull_request.opened")).toBe(true);
    expect(eventTypeMatches("pull_request.*", "pull_request_review.submitted")).toBe(false);
    expect(eventTypeMatches("pull_request.opened", "pull_request.opened")).toBe(true);
    expect(eventTypeMatches("pull_request.opened", "pull_request.closed")).toBe(false);
  });

  test("conditions all have to hold", () => {
    const base = { eventTypes: ["pull_request.*"], includeOwnEvents: false };
    expect(
      eventMatchesTrigger(event, {
        ...base,
        conditions: [
          { field: "data.repository", op: "equals", value: "acme/api" },
          { field: "data.pull_request.draft", op: "equals", value: false },
          { field: "data.pull_request.labels", op: "contains", value: "p1" },
          { field: "data.number", op: "in", value: ["41", "42"] },
          { field: "summary", op: "contains", value: "RETRIES" },
          { field: "data.missing", op: "not_exists" },
        ],
      }),
    ).toBe(true);
    expect(
      eventMatchesTrigger(event, {
        ...base,
        conditions: [{ field: "data.repository", op: "not_in", value: ["acme/api"] }],
      }),
    ).toBe(false);
  });

  test("Opengeni's own events are ignored unless the trigger opts in", () => {
    const own = {
      ...event,
      actor: { kind: "opengeni" as const, name: "opengeni[bot]" },
    };
    const trigger = { eventTypes: ["*"], conditions: [] };
    expect(eventMatchesTrigger(own, { ...trigger, includeOwnEvents: false })).toBe(false);
    expect(eventMatchesTrigger(own, { ...trigger, includeOwnEvents: true })).toBe(true);
  });
});

describe("events carried into an event run", () => {
  function inbound(
    index: number,
    data: Record<string, unknown>,
    dataTruncated = false,
  ): InboundEvent {
    return {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      sourceId: "00000000-0000-4000-8000-00000000aaaa",
      sourceKind: "webhook",
      type: "deploy.finished",
      occurredAt: `2026-10-24T10:0${index}:00.000Z`,
      receivedAt: `2026-10-24T10:0${index}:01.000Z`,
      subject: `deploy ${index}`,
      summary: `Deploy ${index} finished`,
      url: null,
      actor: { kind: "unknown", name: null },
      data,
      dataTruncated,
      gapBefore: false,
    };
  }
  function summaryOf(event: InboundEvent) {
    const { receivedAt: _r, data: _d, dataTruncated: _t, gapBefore: _g, ...summary } = event;
    return summary;
  }

  test("events keep their summary and a bounded excerpt of their data, oldest first", () => {
    const events = [inbound(1, { ok: true }), inbound(2, { text: "y".repeat(10_000) }, false)];
    const carried = scheduledOccurrenceEvents({
      occurrenceId: "occurrence-1",
      eventCount: 2,
      gapBefore: true,
      summaries: events.map(summaryOf),
      events,
      budgetBytes: 1_000_000,
    });
    expect(carried.occurrenceId).toBe("occurrence-1");
    expect(carried.eventCount).toBe(2);
    expect(carried.gapBefore).toBe(true);
    expect(carried.events.map((event) => event.subject)).toEqual(["deploy 1", "deploy 2"]);
    expect(carried.events[0]).toMatchObject({
      data: { ok: true },
      dataTruncated: false,
    });
    expect(carried.events[1]?.dataTruncated).toBe(true);
    expect(jsonUtf8Bytes(carried.events[1]?.data)).toBeLessThanOrEqual(
      SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES,
    );
  });

  test("an event whose stored copy expired is carried as its summary only", () => {
    const expired = inbound(3, { gone: true });
    const carried = scheduledOccurrenceEvents({
      occurrenceId: "occurrence-2",
      eventCount: 1,
      gapBefore: false,
      summaries: [summaryOf(expired)],
      events: [],
      budgetBytes: 1_000_000,
    });
    expect(carried.events).toEqual([{ ...summaryOf(expired), data: {}, dataTruncated: true }]);
  });

  test("events stop at the smaller of the room left and the events budget", () => {
    const events = Array.from({ length: 9 }, (_, index) =>
      inbound(index, { text: "z".repeat(1_800) }),
    );
    const wide = scheduledOccurrenceEvents({
      occurrenceId: "occurrence-3",
      eventCount: 40,
      gapBefore: false,
      summaries: events.map(summaryOf),
      events,
      budgetBytes: 1_000_000,
    });
    expect(jsonUtf8Bytes(wide)).toBeLessThanOrEqual(SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES);
    expect(wide.events.length).toBeGreaterThan(0);
    expect(wide.events.length).toBeLessThan(events.length);
    expect(wide.eventCount).toBe(40);

    const narrow = scheduledOccurrenceEvents({
      occurrenceId: "occurrence-3",
      eventCount: 40,
      gapBefore: false,
      summaries: events.map(summaryOf),
      events,
      budgetBytes: 3_000,
    });
    expect(jsonUtf8Bytes(narrow)).toBeLessThanOrEqual(3_000);
    expect(narrow.events.length).toBeLessThan(wide.events.length);

    const none = scheduledOccurrenceEvents({
      occurrenceId: "occurrence-3",
      eventCount: 40,
      gapBefore: false,
      summaries: events.map(summaryOf),
      events,
      budgetBytes: -5,
    });
    expect(none.events).toEqual([]);
  });
});
