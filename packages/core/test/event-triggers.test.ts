import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  EVENT_DATA_MAX_BYTES,
  SCHEDULED_OCCURRENCE_EVENT_DATA_MAX_BYTES,
  SCHEDULED_OCCURRENCE_EVENTS_MAX_BYTES,
  type InboundEvent,
  WebhookFormat,
  type WebhookFormatInput,
  webhookFormatOfPreset,
} from "@opengeni/contracts";
import {
  boundEvent,
  boundEventData,
  eventMatchesTrigger,
  eventTypeMatches,
  generateStandardWebhookSecret,
  jsonUtf8Bytes,
  readPath,
  scheduledOccurrenceEvents,
  signHexBodyHmac,
  signStandardWebhook,
  signTimestampedHmac,
  signBodyHmac,
  standardWebhookSecretKey,
  verifyStandardWebhook,
  webhookEventTypeCatalog,
  webhookAdapterFor,
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
    const adapter = webhookAdapterFor({ adapter: "standard", format: null });
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
      webhookAdapterFor({ adapter: "standard", format: null }).read({
        headers: headersOf({}),
        body: encoder.encode(JSON.stringify({ data: {} })),
        receivedAt,
      }),
    ).toThrow(WebhookBodyError);
  });

  // A source stored as `linear` (before the presets) reads with Linear's preset.
  for (const stored of [
    { adapter: "linear" as const, format: null },
    { adapter: "custom" as const, format: webhookFormatOfPreset("linear") },
  ]) {
    test(`Linear's preset (${stored.adapter}) verifies the signature and timestamp and names Issue.create`, () => {
      const adapter = webhookAdapterFor(stored);
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
        deliveryKey: "delivery-id:delivery-1",
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
        summary: "Fix login",
        url: "https://linear.app/acme/issue/ENG-42/fix-login",
        occurredAt: new Date("2026-10-24T09:59:30.000Z"),
        actor: { kind: "person", name: "Ada" },
      });
      expect(adapter.retainedHeaders).toEqual(["linear-delivery"]);
    });
  }

  for (const stored of [
    { adapter: "sentry" as const, format: null },
    { adapter: "custom" as const, format: webhookFormatOfPreset("sentry") },
  ]) {
    test(`Sentry's preset (${stored.adapter}) names the resource and action from the header`, () => {
      const adapter = webhookAdapterFor(stored);
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
        deliveryKey: "delivery-id:req-1",
      });
      expect(adapter.verify({ secret: "other", headers, body }).ok).toBe(false);
      const reading = adapter.read({ headers, body, receivedAt });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events[0]).toMatchObject({
        type: "issue.created",
        subject: "API-7",
        summary: "TypeError: x is undefined",
        url: "https://acme.sentry.io/issues/123/",
        actor: { kind: "bot", name: "Sentry" },
        occurredAt: new Date("2026-10-24T09:58:00.000Z"),
      });
      expect(() =>
        adapter.read({
          headers: headersOf({ "request-id": "req-2" }),
          body,
          receivedAt,
        }),
      ).toThrow("The delivery has no Sentry-Hook-Resource header for its event type");
    });
  }

  describe("custom adapter", () => {
    const now = 1_800_000_000;
    const custom = (format: WebhookFormatInput) =>
      webhookAdapterFor({ adapter: "custom", format: WebhookFormat.parse(format) });

    describe("Tailscale's format: a timestamped signature over a list of events", () => {
      const adapter = custom({
        preset: "tailscale",
        signature: { scheme: "timestamped_hmac_sha256", header: "Tailscale-Webhook-Signature" },
        batch: {},
        type: { path: "type" },
        occurredAt: "timestamp",
        summary: "message",
        subject: "data.deviceName",
        url: "data.url",
        actor: "data.actor",
      });
      const secret = "tskey-webhook-kTEST1CNTRL-SecretValue1234";
      const events = [
        {
          timestamp: "2026-10-24T09:58:00.000Z",
          version: 1,
          type: "nodeNeedsApproval",
          tailnet: "example.com",
          message: "Node laptop.example.ts.net needs approval",
          data: {
            nodeID: "nAbC123",
            deviceName: "laptop.example.ts.net",
            actor: "ada@example.com",
            url: "https://login.tailscale.com/admin/machines/100.64.0.7",
          },
        },
        {
          timestamp: "2026-10-24T09:59:00.000Z",
          version: 1,
          type: "userRoleUpdated",
          tailnet: "example.com",
          message: "User bo@example.com role changed",
          data: { user: "bo@example.com", actor: "ada@example.com", newRoles: ["Admin"] },
        },
      ];
      const body = encoder.encode(JSON.stringify(events));
      const signed = (value: string, timestampSeconds = now) =>
        headersOf({
          "tailscale-webhook-signature": signTimestampedHmac({
            secret: value,
            body,
            timestampSeconds,
          }),
        });

      test("verifies the documented signature, any v1 entry, and dedupes by body", () => {
        // Computed independently of the helper, as Tailscale and Stripe document it.
        const documented = createHmac("sha256", secret)
          .update(`${now}.${new TextDecoder().decode(body)}`)
          .digest("hex");
        const headers = headersOf({
          "tailscale-webhook-signature": `t=${now},v1=${"0".repeat(64)},v1=${documented}`,
        });
        expect(adapter.verify({ secret, headers, body, nowSeconds: now })).toEqual({
          ok: true,
          deliveryKey: null,
        });
        expect(signed(secret).get("tailscale-webhook-signature")).toBe(`t=${now},v1=${documented}`);
      });

      test("refuses a wrong secret, a stale time, a tampered body or no header", () => {
        expect(
          adapter.verify({ secret, headers: signed("tskey-webhook-other"), body, nowSeconds: now }),
        ).toEqual({
          ok: false,
          reason: "The Tailscale-Webhook-Signature header does not match the signing secret",
        });
        expect(
          adapter.verify({ secret, headers: signed(secret, now - 301), body, nowSeconds: now }),
        ).toEqual({ ok: false, reason: "The delivery was signed more than 300 seconds from now" });
        expect(adapter.verify({ secret, headers: headersOf({}), body, nowSeconds: now })).toEqual({
          ok: false,
          reason: "Missing or malformed Tailscale-Webhook-Signature header",
        });
        const tampered = encoder.encode(JSON.stringify([{ ...events[0], type: "test" }]));
        expect(
          adapter.verify({ secret, headers: signed(secret), body: tampered, nowSeconds: now }).ok,
        ).toBe(false);
      });

      test("reads every event in the list with its mapped fields", () => {
        const reading = adapter.read({ headers: signed(secret), body, receivedAt });
        if (reading.kind !== "events") throw new Error("expected events");
        expect(reading.events).toHaveLength(2);
        expect(reading.events[0]).toMatchObject({
          externalId: null,
          type: "nodeNeedsApproval",
          occurredAt: new Date("2026-10-24T09:58:00.000Z"),
          subject: "laptop.example.ts.net",
          summary: "Node laptop.example.ts.net needs approval",
          url: "https://login.tailscale.com/admin/machines/100.64.0.7",
          actor: { kind: "unknown", name: "ada@example.com" },
        });
        expect(readPath(reading.events[0]?.data, "data.nodeID")).toBe("nAbC123");
        expect(reading.events[1]).toMatchObject({ type: "userRoleUpdated", subject: null });
        expect(
          adapter.read({ headers: new Headers(), body: encoder.encode("[]"), receivedAt }),
        ).toEqual({ kind: "ignored", reason: "The delivery holds no events" });
      });

      test("refuses a body that is not a list of typed objects", () => {
        for (const value of [{ type: "test" }, [1], [{ message: "no type" }], [{ type: "a b" }]]) {
          expect(() =>
            adapter.read({
              headers: new Headers(),
              body: encoder.encode(JSON.stringify(value)),
              receivedAt,
            }),
          ).toThrow(WebhookBodyError);
        }
      });

      test("the preset lists Tailscale's documented types, then received ones", () => {
        const catalog = webhookEventTypeCatalog(
          { adapter: "custom", format: { preset: "tailscale" } },
          [{ type: "nodeAuthorized", count: 2 }],
        );
        const types = catalog.map((entry) => entry.type);
        expect(types).toContain("nodeNeedsApproval");
        expect(types).toContain("policyUpdate");
        expect(types.at(-1)).toBe("nodeAuthorized");
        expect(
          webhookEventTypeCatalog({ adapter: "custom", format: { preset: "other" } }, []),
        ).toEqual([]);
      });
    });

    test("a base64 body HMAC with the type and delivery id in headers (Shopify's format)", () => {
      const adapter = custom({
        signature: { scheme: "hmac_sha256", header: "X-Shopify-Hmac-Sha256", encoding: "base64" },
        type: { header: "X-Shopify-Topic" },
        deliveryId: { header: "X-Shopify-Webhook-Id" },
        eventId: "id",
        summary: "name",
      });
      const secret = "shpss_example_secret";
      const body = encoder.encode(JSON.stringify({ id: 820982911946154500, name: "#9999" }));
      const headers = headersOf({
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
        "x-shopify-topic": "orders/create",
        "x-shopify-webhook-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      });
      expect(adapter.verify({ secret, headers, body })).toEqual({
        ok: true,
        deliveryKey: "delivery-id:b54557e4-bdd9-4b37-8a5f-bf7d70bcd043",
      });
      expect(adapter.retainedHeaders).toEqual(["x-shopify-topic", "x-shopify-webhook-id"]);
      const reading = adapter.read({ headers, body, receivedAt });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events[0]).toMatchObject({
        type: "orders/create",
        externalId: "820982911946154500",
        summary: "#9999",
      });
      expect(
        adapter.verify({
          secret: "another-secret",
          headers,
          body,
        }),
      ).toEqual({
        ok: false,
        reason: "The X-Shopify-Hmac-Sha256 header does not match the signing secret",
      });
      expect(() => adapter.read({ headers: headersOf({}), body, receivedAt })).toThrow(
        "The delivery has no X-Shopify-Topic header for its event type",
      );
    });

    test("a prefixed hex HMAC, and a body path for the delivery id", () => {
      const adapter = custom({
        signature: { scheme: "hmac_sha256", header: "X-Signature-256", prefix: "sha256=" },
        type: { path: "event.kind" },
        deliveryId: { path: "delivery" },
      });
      const secret = "a-shared-secret";
      const body = encoder.encode(JSON.stringify({ delivery: "d-1", event: { kind: "ping" } }));
      const signature = signBodyHmac({ secret, body, encoding: "hex", prefix: "sha256=" });
      expect(signature).toBe(`sha256=${signHexBodyHmac(secret, body)}`);
      expect(
        adapter.verify({ secret, headers: headersOf({ "x-signature-256": signature }), body }),
      ).toEqual({ ok: true, deliveryKey: "delivery-id:d-1" });
      expect(
        adapter.verify({
          secret,
          headers: headersOf({ "x-signature-256": signHexBodyHmac(secret, body) }),
          body,
        }),
      ).toEqual({ ok: false, reason: 'The X-Signature-256 header does not start with "sha256="' });
    });

    test("a shared token after a prefix, one type for every delivery, a list at a path", () => {
      const adapter = custom({
        signature: { scheme: "token", header: "Authorization", prefix: "Bearer " },
        batch: { path: "alerts" },
        type: { value: "alert.fired" },
        subject: "labels.host",
      });
      const body = encoder.encode(
        JSON.stringify({ alerts: [{ labels: { host: "a" } }, { labels: { host: "b" } }] }),
      );
      const secret = "token-1234567890";
      expect(
        adapter.verify({
          secret,
          headers: headersOf({ authorization: "bearer token-1234567890" }),
          body,
        }),
      ).toEqual({ ok: true, deliveryKey: null });
      for (const value of ["Bearer token-123456789", "token-1234567890x", ""]) {
        expect(
          adapter.verify({ secret, headers: headersOf({ authorization: value }), body }).ok,
        ).toBe(false);
      }
      const reading = adapter.read({ headers: new Headers(), body, receivedAt });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events.map((event) => [event.type, event.subject])).toEqual([
        ["alert.fired", "a"],
        ["alert.fired", "b"],
      ]);
      const tooMany = encoder.encode(JSON.stringify({ alerts: Array(101).fill({}) }));
      expect(() => adapter.read({ headers: new Headers(), body: tooMany, receivedAt })).toThrow(
        "The delivery holds 101 events; at most 100 are read",
      );
    });

    test("Standard Webhooks signatures from an app's own whsec_ secret (Svix)", () => {
      const adapter = custom({
        signature: { scheme: "standard_webhooks" },
        type: { path: "type" },
        eventId: "data.id",
      });
      const secret = generateStandardWebhookSecret();
      const body = JSON.stringify({ type: "user.created", data: { id: "user_1" } });
      const headers = headersOf(
        signStandardWebhook({ secret, webhookId: "msg_1", body, timestampSeconds: now }),
      );
      expect(
        adapter.verify({ secret, headers, body: encoder.encode(body), nowSeconds: now }),
      ).toEqual({
        ok: true,
        deliveryKey: "webhook-id:msg_1",
      });
      const reading = adapter.read({ headers, body: encoder.encode(body), receivedAt });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events[0]).toMatchObject({ type: "user.created", externalId: "user_1" });
    });

    test("a custom source without a format refuses every delivery", () => {
      const adapter = webhookAdapterFor({ adapter: "custom", format: null });
      expect(
        adapter.verify({ secret: "x", headers: new Headers(), body: new Uint8Array() }),
      ).toEqual({
        ok: false,
        reason: "This custom webhook has no format yet",
      });
    });

    test("a signed-content layout with the timestamp header, checked for freshness (Slack's format)", () => {
      const adapter = custom({
        signature: {
          scheme: "hmac_sha256",
          header: "X-Slack-Signature",
          prefix: "v0=",
          signedContent: "v0:{header:X-Slack-Request-Timestamp}:{body}",
        },
        freshness: { header: "X-Slack-Request-Timestamp", toleranceSeconds: 300 },
        type: { path: "event.type" },
        eventId: "event_id",
      });
      const secret = "8f742231b10e8888abcd99yyyzzz85a5";
      const body = JSON.stringify({ event_id: "Ev1", event: { type: "app_mention" } });
      const slackHeaders = (timestamp: number, signed = body) =>
        headersOf({
          "x-slack-request-timestamp": String(timestamp),
          "x-slack-signature": `v0=${createHmac("sha256", secret)
            .update(`v0:${timestamp}:${signed}`)
            .digest("hex")}`,
        });
      const verify = (headers: Headers, nowSeconds = now) =>
        adapter.verify({ secret, headers, body: encoder.encode(body), nowSeconds });
      expect(verify(slackHeaders(now))).toEqual({ ok: true, deliveryKey: null });
      // The timestamp is part of what was signed, so changing it breaks the signature.
      const moved = slackHeaders(now);
      moved.set("x-slack-request-timestamp", String(now + 1));
      expect(verify(moved).ok).toBe(false);
      expect(verify(slackHeaders(now, `${body} `)).ok).toBe(false);
      expect(verify(slackHeaders(now - 600), now)).toEqual({
        ok: false,
        reason:
          "The send time in the X-Slack-Request-Timestamp header is more than 300 seconds from now",
      });
      const missing = slackHeaders(now);
      missing.delete("x-slack-request-timestamp");
      expect(verify(missing)).toEqual({
        ok: false,
        reason: "Missing X-Slack-Request-Timestamp header",
      });
      const reading = adapter.read({
        headers: slackHeaders(now),
        body: encoder.encode(body),
        receivedAt,
      });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events[0]).toMatchObject({ type: "app_mention", externalId: "Ev1" });
    });

    test("Ed25519 signatures over the timestamp and body, with the app's public key (Discord's format)", () => {
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
      const adapter = custom({
        signature: {
          scheme: "ed25519",
          header: "X-Signature-Ed25519",
          signedContent: "{header:X-Signature-Timestamp}{body}",
        },
        freshness: { header: "X-Signature-Timestamp" },
        type: { path: "type" },
      });
      const body = JSON.stringify({ type: "message.created", id: "m1" });
      const headers = headersOf({
        "x-signature-timestamp": String(now),
        "x-signature-ed25519": sign(null, Buffer.from(`${now}${body}`), privateKey).toString("hex"),
      });
      const verify = (secret: string, delivered = body) =>
        adapter.verify({ secret, headers, body: encoder.encode(delivered), nowSeconds: now });
      for (const key of [
        raw.toString("hex"),
        raw.toString("base64"),
        publicKey.export({ format: "pem", type: "spki" }).toString(),
      ]) {
        expect(verify(key)).toEqual({ ok: true, deliveryKey: null });
      }
      expect(verify(raw.toString("hex"), `${body} `)).toEqual({
        ok: false,
        reason: "The X-Signature-Ed25519 header is not a valid signature from the app's key",
      });
      const other = generateKeyPairSync("ed25519").publicKey;
      expect(
        verify(other.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")).ok,
      ).toBe(false);
      expect(verify("not-a-key")).toEqual({
        ok: false,
        reason: "The source's secret is not an Ed25519 public key",
      });
    });

    test("a secret in the address's query, for an app that can't sign", () => {
      const adapter = custom({
        signature: { scheme: "url_token", parameter: "key" },
        type: { value: "monitor.triggered" },
        summary: ["result.summary", "goal"],
        eventId: "run_id",
      });
      const secret = "u3T9kq2LxP0wZ7vN4bC8yR1d";
      const body = encoder.encode(JSON.stringify({ run_id: "run_1", goal: "Price drops" }));
      const verify = (query: string) =>
        adapter.verify({
          secret,
          headers: new Headers(),
          body,
          query: new URLSearchParams(query),
        });
      expect(verify(`key=${secret}`)).toEqual({ ok: true, deliveryKey: null });
      expect(verify(`key=${secret}x`)).toEqual({
        ok: false,
        reason: "The address's ?key= is not the secret",
      });
      expect(verify(`token=${secret}`)).toEqual({
        ok: false,
        reason: "The address has no ?key= secret",
      });
      const reading = adapter.read({ headers: new Headers(), body, receivedAt });
      if (reading.kind !== "events") throw new Error("expected events");
      expect(reading.events[0]).toMatchObject({
        type: "monitor.triggered",
        externalId: "run_1",
        summary: "Price drops",
      });
    });

    test("a type joined from parts, fallback paths, a body send time and the actor's kind", () => {
      const adapter = custom({
        signature: { scheme: "token", header: "X-Token" },
        freshness: { path: "sent_at", toleranceSeconds: 60 },
        type: { parts: [{ header: "X-Resource" }, { path: "change" }], separator: ":" },
        subject: ["order.number", "order.id"],
        occurredAt: ["order.updated", "order.created"],
        actor: ["by.name", "by.login"],
        actorKind: { path: "by.kind", person: ["member", "owner"] },
      });
      const event = (by: Record<string, unknown> | null, sentAt: unknown = now * 1000) =>
        encoder.encode(
          JSON.stringify({
            sent_at: sentAt,
            change: "paid",
            order: { id: 7, created: "2026-10-24T09:00:00.000Z" },
            ...(by ? { by } : {}),
          }),
        );
      const headers = headersOf({ "x-token": "s3cret-token", "x-resource": "order" });
      const verify = (body: Uint8Array) =>
        adapter.verify({ secret: "s3cret-token", headers, body, nowSeconds: now });
      expect(verify(event(null)).ok).toBe(true);
      expect(verify(event(null, new Date(now * 1000).toISOString())).ok).toBe(true);
      expect(verify(event(null, now - 120))).toEqual({
        ok: false,
        reason: 'The send time in "sent_at" is more than 60 seconds from now',
      });
      expect(verify(event(null, "soon"))).toEqual({
        ok: false,
        reason: 'The delivery has no send time in "sent_at"',
      });
      const read = (by: Record<string, unknown> | null) => {
        const reading = adapter.read({ headers, body: event(by), receivedAt });
        if (reading.kind !== "events") throw new Error("expected events");
        return reading.events[0];
      };
      expect(read({ kind: "member", login: "ada" })).toMatchObject({
        type: "order:paid",
        subject: "7",
        occurredAt: new Date("2026-10-24T09:00:00.000Z"),
        actor: { kind: "person", name: "ada" },
      });
      expect(read({ kind: "integration", name: "Zap" })?.actor).toEqual({
        kind: "bot",
        name: "Zap",
      });
      expect(read(null)?.actor).toEqual({ kind: "unknown", name: null });
      expect(adapter.retainedHeaders).toEqual(["x-resource"]);
    });

    test("a signed-content layout holds {body} once and names headers in its other braces", () => {
      const layout = (signedContent: string) =>
        WebhookFormat.safeParse({
          signature: { scheme: "hmac_sha256", header: "X-Signature", signedContent },
          type: { path: "type" },
        }).success;
      expect(layout("v0:{header:X-Timestamp}:{body}")).toBe(true);
      expect(layout("{header:X-Timestamp}.{header:X-Id}")).toBe(false);
      expect(layout("{body}{body}")).toBe(false);
      expect(layout("{body}:{timestamp}")).toBe(false);
      expect(layout("{body}:{header:not a header}")).toBe(false);
      expect(layout("{body}}")).toBe(false);
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
