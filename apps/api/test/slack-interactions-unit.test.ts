import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { WorkspaceSlackReactionSummonSettings } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { isApiContractProtectedMutation } from "../src/app";
import { requireAccessKey } from "../src/http/auth";
import { authorizeSlackSharedImageRead } from "../src/integrations/slack-bot";
import {
  registerSlackInteractionRoutes,
  normalizedBlockActionInteraction,
  slackDeliveryTextsCoalesce,
  slackEventInboxEntry,
  slackInteractionRoutePolicy,
  slackInvocationModelContext,
  slackReactionInboxEntry,
  slackReactionTaskText,
  SLACK_DELIVERY_EVENT_TYPES,
  SLACK_INTERACTION_MAX_BODY_BYTES,
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

describe("Slack shared-image authorization", () => {
  const ordinary = {
    isArchived: false,
    isShared: false,
    isExternallyShared: false,
    isOrgShared: false,
    isPendingExternallyShared: false,
    isMpim: false,
  };

  test("accepts only an explicit authorized governed-conversation capability", async () => {
    let calls = 0;
    await authorizeSlackSharedImageRead(
      { ...ordinary, isShared: true, isExternallyShared: true },
      async () => {
        calls += 1;
      },
    );
    expect(calls).toBe(1);
  });

  test("denies missing or rejected shared policy and never widens ordinary conversations", async () => {
    await expect(
      authorizeSlackSharedImageRead({ ...ordinary, isShared: true }, undefined),
    ).rejects.toMatchObject({ code: "slack_connect_unsupported" });
    await expect(
      authorizeSlackSharedImageRead({ ...ordinary, isMpim: true }, async () => {
        throw new Error("shared policy drifted");
      }),
    ).rejects.toThrow("shared policy drifted");
    let ordinaryCapabilityCalls = 0;
    await expect(
      authorizeSlackSharedImageRead(ordinary, async () => {
        ordinaryCapabilityCalls += 1;
      }),
    ).rejects.toMatchObject({ code: "slack_connect_unsupported" });
    expect(ordinaryCapabilityCalls).toBe(0);
  });
});

describe("Slack event classification and safe projection", () => {
  test("normalizes exactly one opaque OpenGeni block action", () => {
    const normalized = normalizedBlockActionInteraction({
      type: "block_actions",
      team: { id: "T_ACTION" },
      user: { id: "U_ACTION" },
      channel: { id: "C_ACTION" },
      message: { ts: "1710000000.000001", thread_ts: "1710000000.000000" },
      actions: [
        {
          action_id: "opengeni.approval.approve",
          action_ts: "1710000000.000002",
          value: "9adcc1a7-9e79-4d3f-86e8-f1e65b4e76da",
        },
      ],
    });
    expect(normalized).toMatchObject({
      slackTeamId: "T_ACTION",
      slackUserId: "U_ACTION",
      slackChannelId: "C_ACTION",
      slackMessageTs: "1710000000.000001",
      slackThreadTs: "1710000000.000000",
      triggerKind: "block_action",
      text: "opengeni.approval.approve:9adcc1a7-9e79-4d3f-86e8-f1e65b4e76da",
    });
    expect(normalized.providerEventId).toMatch(/^block:[0-9a-f]{64}$/);
    expect(() =>
      normalizedBlockActionInteraction({
        type: "block_actions",
        team: { id: "T_ACTION" },
        user: { id: "U_ACTION" },
        channel: { id: "C_ACTION" },
        message: { ts: "1710000000.000001" },
        actions: [
          {
            action_id: "third_party.action",
            action_ts: "1710000000.000002",
            value: "9adcc1a7-9e79-4d3f-86e8-f1e65b4e76da",
          },
        ],
      }),
    ).toThrow("invalid Slack block action");
  });
  const bot = { botId: "B_OPEN_GENI", botUserId: "U_OPEN_GENI" };
  const envelope = (event: Record<string, unknown>, eventId = "Ev1") => ({
    type: "event_callback",
    team_id: "T1",
    event_id: eventId,
    event,
  });
  const reactionSettings = {
    enabled: true,
    emoji: "genie",
    channelPolicy: { mode: "bot_member" },
  } satisfies WorkspaceSlackReactionSummonSettings;

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
          type: "message",
          user: "U1",
          channel: "C1",
          ts: "1.3",
          thread_ts: "1.1",
          text: "<@U_OPEN_GENI> Slack delivered this threaded mention as a message",
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

  test("accepts explicit file-only events with one bounded internal placeholder", () => {
    expect(
      slackEventInboxEntry(
        envelope({
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "4.1",
          files: [{ id: "F1", name: "diagram.png" }],
        }),
        bot,
      ),
    ).toMatchObject({
      triggerKind: "app_mention",
      text: "(file-only Slack invocation)",
      slackMessageTs: "4.1",
      hasFiles: true,
    });
    expect(
      slackEventInboxEntry(
        envelope({
          type: "message",
          channel_type: "im",
          user: "U1",
          channel: "D1",
          ts: "4.2",
          files: [{ id: "F2", title: "screenshot.png" }],
        }),
        bot,
      ),
    ).toMatchObject({ triggerKind: "dm", hasFiles: true });
    expect(
      slackEventInboxEntry(
        envelope({
          type: "message",
          user: "U1",
          channel: "C1",
          ts: "4.3",
          thread_ts: "4.0",
          text: "inspect this",
          files: [{ id: "F3", name: "trace.png" }],
        }),
        bot,
      ),
    ).toMatchObject({ triggerKind: "thread_reply", hasFiles: true });
  });

  test("keeps bounded nearby context inside the Slack input budget", () => {
    const prompt = slackInvocationModelContext("1.2", {
      kind: "channel",
      nextCursor: "more",
      messages: [
        {
          timestamp: "1.1",
          userId: "U1",
          botId: "",
          threadTimestamp: "",
          text: "preceding context",
          files: [],
        },
        {
          timestamp: "1.2",
          userId: "U1",
          botId: "",
          threadTimestamp: "",
          text: `<@U_OPEN_GENI> ${"x".repeat(8_000)}`,
          files: [],
        },
      ],
    });
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(prompt).not.toContain("<@U_OPEN_GENI>");
    expect(prompt).toContain("preceding context");
    expect(prompt).toContain("Only bounded nearby channel context was provided.");
  });

  test("keeps human-DM shortcuts private and user-scoped before bot-DM rekey", () => {
    const source = {
      triggerKind: "message_shortcut" as const,
      slackChannelId: "D_HUMAN_DM",
      slackThreadTs: null,
      slackMessageTs: "3.1",
    };
    const owner = slackInteractionRoutePolicy({ ...source, slackUserId: "U_OWNER" });
    const other = slackInteractionRoutePolicy({ ...source, slackUserId: "U_OTHER" });
    expect(owner).toMatchObject({
      directMessageShortcut: true,
      requiresChannelAccess: false,
      visibility: "private",
    });
    expect(owner.initialRouteKey).not.toBe(other.initialRouteKey);
    expect(
      slackInteractionRoutePolicy({
        ...source,
        slackChannelId: "C_MEMBER_CHANNEL",
        slackUserId: "U_OWNER",
      }),
    ).toMatchObject({
      directMessageShortcut: false,
      requiresChannelAccess: true,
      visibility: "workspace",
      initialRouteKey: "C_MEMBER_CHANNEL:3.1",
    });
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

  test("filters reaction summons before content fetch and keeps remove/re-add identity stable", () => {
    const reaction = {
      type: "reaction_added",
      user: "U1",
      reaction: "genie",
      item: { type: "message", channel: "C1", ts: "4.2" },
    };
    expect(
      slackReactionInboxEntry(envelope(reaction), bot, {
        ...reactionSettings,
        enabled: false,
      }),
    ).toBeNull();
    expect(
      slackReactionInboxEntry(envelope({ ...reaction, reaction: "wave" }), bot, reactionSettings),
    ).toBeNull();
    expect(
      slackReactionInboxEntry(envelope(reaction), bot, {
        ...reactionSettings,
        channelPolicy: { mode: "allowlist", channelIds: ["C2"] },
      }),
    ).toBeNull();
    expect(
      slackReactionInboxEntry(
        envelope({ ...reaction, user: bot.botUserId }),
        bot,
        reactionSettings,
      ),
    ).toBeNull();
    expect(
      slackReactionInboxEntry(
        envelope({ ...reaction, item: { type: "file", file: "F1" } }),
        bot,
        reactionSettings,
      ),
    ).toBeNull();

    const first = slackReactionInboxEntry(
      envelope(reaction, "Ev-reaction-1"),
      bot,
      reactionSettings,
    );
    const readded = slackReactionInboxEntry(
      envelope(reaction, "Ev-reaction-2"),
      bot,
      reactionSettings,
    );
    expect(first).toMatchObject({
      providerEventId: "Ev-reaction-1",
      slackMessageTs: "4.2",
      slackThreadTs: null,
      triggerKind: "reaction",
      text: "genie",
    });
    expect(readded?.providerMessageId).toBe(first?.providerMessageId);
    expect(
      slackReactionInboxEntry(
        envelope({ ...reaction, user: "U2" }, "Ev-reaction-3"),
        bot,
        reactionSettings,
      )?.providerMessageId,
    ).not.toBe(first?.providerMessageId);
  });

  test("allows only bounded user-safe delivery events", () => {
    expect(SLACK_DELIVERY_EVENT_TYPES).not.toContain("agent.reasoning.delta" as never);
    expect(SLACK_DELIVERY_EVENT_TYPES).not.toContain("agent.toolCall.output" as never);
    expect(SLACK_DELIVERY_EVENT_TYPES).toContain("session.requiresAction");
  });

  test("coalesces only exact or boundary-safe terminal prefix shapes", () => {
    expect(slackDeliveryTextsCoalesce("Final result", "Final result")).toBe(true);
    expect(slackDeliveryTextsCoalesce("Final result", "Final result\n\nDetails")).toBe(true);
    expect(slackDeliveryTextsCoalesce("Final result. Details", "Final result")).toBe(true);
    expect(slackDeliveryTextsCoalesce("Final", "Finally different")).toBe(false);
    expect(slackDeliveryTextsCoalesce("middle", "prefix middle suffix")).toBe(false);
    expect(slackDeliveryTextsCoalesce("", "Final result")).toBe(false);
  });

  test("pins the exact reacted message before budgeting long surrounding context", () => {
    const exactText = `Pinned production decision: ${"x".repeat(3_500)}`;
    const reactedMessage = {
      timestamp: "1706100000.000017",
      threadTimestamp: "1706100000.000001",
      userId: "U_REACTED",
      botId: "",
      text: exactText,
      files: [
        {
          id: "F_PINNED",
          name: "deployment-plan.md",
          title: "Pinned deployment plan",
          mimetype: "text/markdown",
          filetype: "markdown",
          mode: "hosted",
          size: 1_024,
          originatingHuddleId: "",
          huddleTranscriptFileId: "",
        },
      ],
    };
    const prompt = slackReactionTaskText({
      reactedMessage,
      messages: [
        ...Array.from({ length: 14 }, (_, index) => ({
          ...reactedMessage,
          timestamp: `1706100000.${String(index + 1).padStart(6, "0")}`,
          text: `Long surrounding context ${index}: ${"c".repeat(550)}`,
          files: [],
        })),
        reactedMessage,
      ],
      truncated: true,
    } as never);

    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(prompt).toContain(exactText);
    expect(prompt).toContain("[reacted message]");
    expect(prompt).toContain("Pinned deployment plan");
    expect(prompt).toContain("Execute a direct, safe, sufficiently specified request immediately");
    expect(prompt).toContain("Ask one concise clarifying question only when materially required");
    expect(prompt.indexOf("[reacted message]")).toBeLessThan(
      prompt.indexOf("Bounded surrounding thread context:"),
    );
    expect(prompt).toContain("bounded Slack context limit");
  });
});
