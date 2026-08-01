import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { isApiContractProtectedMutation } from "../src/app";
import { requireAccessKey } from "../src/http/auth";
import {
  registerSlackInteractionRoutes,
  slackEventInboxEntry,
  SLACK_DELIVERY_EVENT_TYPES,
  SLACK_INTERACTION_MAX_BODY_BYTES,
  SLACK_TASK_INSTRUCTIONS,
  verifySlackRequestSignature,
} from "../src/integrations/slack-interactions";

const signingSecret = "slack-signing-secret-for-tests";
const now = new Date("2026-08-01T12:00:00.000Z");

function signature(rawBody: string, timestamp = Math.floor(now.getTime() / 1000)) {
  return `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
}

function routeDeps(): ApiRouteDeps {
  return {
    settings: testSettings({ slackSigningSecret: signingSecret }),
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("signed Slack boundary touched tenant storage");
        },
      },
    ),
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: async () => {} },
    getDocumentServices: () => ({}),
    resumeBoxById: async () => {
      throw new Error("unused");
    },
  } as unknown as ApiRouteDeps;
}

function signedRequest(path: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": signature(rawBody, timestamp),
    },
    body: rawBody,
  });
}

describe("Slack interaction signature boundary", () => {
  test("accepts a valid v0 signature inside the replay window", () => {
    const rawBody = '{"type":"url_verification"}';
    const timestamp = String(Math.floor(now.getTime() / 1000));
    expect(
      verifySlackRequestSignature(
        { timestamp, signature: signature(rawBody), rawBody },
        signingSecret,
        now.getTime(),
      ),
    ).toBe(true);
  });

  test("rejects invalid signatures and stale or future timestamps", () => {
    const rawBody = "{}";
    const current = Math.floor(now.getTime() / 1000);
    expect(
      verifySlackRequestSignature(
        {
          timestamp: String(current),
          signature: `v0=${"0".repeat(64)}`,
          rawBody,
        },
        signingSecret,
        now.getTime(),
      ),
    ).toBe(false);
    for (const timestamp of [current - 301, current + 301]) {
      expect(
        verifySlackRequestSignature(
          {
            timestamp: String(timestamp),
            signature: signature(rawBody, timestamp),
            rawBody,
          },
          signingSecret,
          now.getTime(),
        ),
      ).toBe(false);
    }
  });

  test("answers signed URL verification without tenant database access", async () => {
    const app = new Hono();
    registerSlackInteractionRoutes(app, routeDeps());
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "challenge-123",
    });
    const response = await app.request(signedRequest("/v1/integrations/slack/events", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "challenge-123" });
  });

  test("rejects malformed JSON and oversized bodies before tenant access", async () => {
    const app = new Hono();
    registerSlackInteractionRoutes(app, routeDeps());
    const malformed = await app.request(signedRequest("/v1/integrations/slack/events", "{"));
    expect(malformed.status).toBe(400);

    const oversizedBody = "x".repeat(SLACK_INTERACTION_MAX_BODY_BYTES + 1);
    const oversized = await app.request(
      signedRequest("/v1/integrations/slack/events", oversizedBody),
    );
    expect(oversized.status).toBe(413);
  });

  test("exempts only the three exact signed Slack ingress paths from product API auth", async () => {
    const paths = [
      "/v1/integrations/slack/events",
      "/v1/integrations/slack/commands",
      "/v1/integrations/slack/interactions",
    ];
    const app = new Hono();
    app.use("*", requireAccessKey(testSettings({ authRequired: true, accessKey: "required" })));
    app.all("*", (c) => c.json({ ok: true }));
    for (const path of paths) {
      expect((await app.request(path, { method: "POST" })).status).toBe(200);
      expect(isApiContractProtectedMutation("POST", path)).toBe(false);
    }
    for (const path of [
      "/v1/integrations/slack/events/",
      "/v1/integrations/slack/events/replay",
      "/v1/integrations/slack/commands-extra",
      "/v1/integrations/slack/interactions/extra",
    ]) {
      expect((await app.request(path, { method: "POST" })).status).toBe(401);
      expect(isApiContractProtectedMutation("POST", path)).toBe(true);
    }
  });
});

describe("Slack event classification and safe projection", () => {
  const bot = { botId: "B_OPEN_GENI", botUserId: "U_OPEN_GENI" };
  const envelope = (event: Record<string, unknown>) => ({
    type: "event_callback",
    team_id: "T1",
    event_id: "Ev1",
    event,
  });

  test("classifies mentions, top-level bot DMs, and thread continuations", () => {
    expect(
      slackEventInboxEntry(
        envelope({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1.1",
          text: "help",
        }),
        bot,
      )?.triggerKind,
    ).toBe("app_mention");
    expect(
      slackEventInboxEntry(
        envelope({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "1.2",
          thread_ts: "1.1",
          text: "adopt this existing thread",
        }),
        bot,
      )?.triggerKind,
    ).toBe("app_mention");
    expect(
      slackEventInboxEntry(
        envelope({
          type: "message",
          channel_type: "im",
          user: "U1",
          channel: "D1",
          ts: "2.1",
          text: "private task",
        }),
        bot,
      )?.triggerKind,
    ).toBe("dm");
    expect(
      slackEventInboxEntry(
        envelope({
          type: "message",
          user: "U1",
          channel: "C1",
          ts: "3.2",
          thread_ts: "3.1",
          text: "continue",
        }),
        bot,
      )?.triggerKind,
    ).toBe("thread_reply");
  });

  test("suppresses self, bot, subtype, unmatched, and malformed messages", () => {
    const ignored = [
      {
        type: "message",
        user: "U_OPEN_GENI",
        channel: "D1",
        ts: "1",
        text: "self",
      },
      {
        type: "message",
        user: "U1",
        bot_id: "B_OTHER",
        channel: "C1",
        ts: "2",
        text: "bot",
      },
      {
        type: "message",
        user: "U1",
        subtype: "message_changed",
        channel: "C1",
        ts: "3",
        text: "edit",
      },
      {
        type: "message",
        user: "U1",
        channel: "C1",
        ts: "4",
        text: "ordinary channel message",
      },
      { type: "message", user: "U1", channel: "C1", ts: "5" },
    ];
    for (const event of ignored) expect(slackEventInboxEntry(envelope(event), bot)).toBeNull();
  });

  test("allows only bounded user-safe delivery events and freezes no-persistence instructions", () => {
    expect(SLACK_DELIVERY_EVENT_TYPES).not.toContain("agent.reasoning.delta" as never);
    expect(SLACK_DELIVERY_EVENT_TYPES).not.toContain("agent.toolCall.output" as never);
    expect(SLACK_TASK_INSTRUCTIONS).toContain("task-local only");
    expect(SLACK_TASK_INSTRUCTIONS).toContain("Do not write Slack context to Documents");
    expect(SLACK_TASK_INSTRUCTIONS).toContain("Never expose private reasoning");
  });
});
