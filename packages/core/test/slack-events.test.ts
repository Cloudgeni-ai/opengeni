import { describe, expect, test } from "bun:test";
import { readSlackDelivery, slackEventTypeCatalog, WebhookBodyError } from "../src";

const encoder = new TextEncoder();
const receivedAt = new Date("2026-10-24T08:00:00.000Z");

function callback(event: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return readSlackDelivery({
    body: encoder.encode(
      JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        api_app_id: "A_OURS",
        event_id: "Ev1",
        event_time: 1_761_200_000,
        authorizations: [{ team_id: "T1", user_id: "U_BOT", is_bot: true }],
        event,
        ...extra,
      }),
    ),
    receivedAt,
  });
}

function only(reading: ReturnType<typeof readSlackDelivery>) {
  if (reading.kind !== "events") throw new Error(`expected an event, got: ${reading.reason}`);
  return reading.events[0]!;
}

const channel = { channel: "C1", channel_type: "channel" };

describe("Slack event callbacks", () => {
  test("a channel message becomes message.posted with bounded text", () => {
    const event = only(
      callback({
        type: "message",
        ...channel,
        user: "U1",
        text: "x".repeat(3_000),
        ts: "1761200000.000100",
        files: [{ id: "F1" }],
      }),
    );
    expect(event).toMatchObject({
      externalId: "Ev1",
      type: "message.posted",
      subject: "C1:1761200000.000100",
      url: "https://app.slack.com/client/T1/C1",
      actor: { kind: "person", name: "U1" },
    });
    expect(event.occurredAt.toISOString()).toBe("2025-10-23T06:13:20.000Z");
    const data = event.data as Record<string, any>;
    expect(data.channel).toEqual({ id: "C1", type: "public" });
    expect(data.files).toBe(1);
    expect(String(data.text).length).toBeLessThanOrEqual(1_501);
  });

  test("tells Opengeni's own app and other bots from people", () => {
    const kind = (event: Record<string, unknown>) =>
      only(callback({ type: "message", ...channel, ts: "1.1", text: "hi", ...event })).actor.kind;
    expect(kind({ user: "U_BOT" })).toBe("opengeni");
    expect(kind({ bot_id: "B1", bot_profile: { app_id: "A_OURS" } })).toBe("opengeni");
    expect(kind({ bot_id: "B2", bot_profile: { app_id: "A_OTHER" } })).toBe("bot");
    expect(kind({ subtype: "bot_message", bot_id: "B3" })).toBe("bot");
    expect(kind({ user: "U1" })).toBe("person");
  });

  test("edits, deletions and channel membership have their own types", () => {
    const edited = only(
      callback({
        type: "message",
        ...channel,
        subtype: "message_changed",
        ts: "1761200009.000100",
        message: { user: "U1", text: "fixed typo", ts: "1761200000.000100" },
        previous_message: { user: "U1", text: "fixd typo", ts: "1761200000.000100" },
      }),
    );
    expect(edited).toMatchObject({
      type: "message.edited",
      subject: "C1:1761200000.000100",
      data: { text: "fixed typo" },
    });
    // Slack also sends message_changed when only an unfurl changes.
    expect(
      callback({
        type: "message",
        ...channel,
        subtype: "message_changed",
        message: { user: "U1", text: "same" },
        previous_message: { user: "U1", text: "same" },
      }).kind,
    ).toBe("ignored");
    expect(
      only(
        callback({
          type: "message",
          ...channel,
          subtype: "message_deleted",
          deleted_ts: "1761200000.000100",
          previous_message: { user: "U1", text: "gone" },
        }),
      ),
    ).toMatchObject({ type: "message.deleted", data: { ts: "1761200000.000100", user: "U1" } });
    expect(
      only(callback({ type: "message", ...channel, subtype: "channel_join", user: "U2" })),
    ).toMatchObject({ type: "member.joined_channel", summary: "U2 joined channel C1" });
    expect(
      callback({ type: "message", ...channel, subtype: "channel_topic", user: "U2" }).kind,
    ).toBe("ignored");
  });

  test("reactions in channels are events; direct messages and mentions are not", () => {
    expect(
      only(
        callback({
          type: "reaction_added",
          user: "U1",
          reaction: "ticket",
          item_user: "U2",
          item: { type: "message", channel: "C1", ts: "1761200000.000100" },
          event_ts: "1761200003.000100",
        }),
      ),
    ).toMatchObject({
      type: "reaction.added",
      data: { reaction: "ticket", item_user: "U2", channel: { id: "C1", type: "public" } },
    });
    expect(
      callback({
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item: { type: "message", channel: "D1", ts: "1.1" },
      }).kind,
    ).toBe("ignored");
    expect(
      callback({ type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hi" }).kind,
    ).toBe("ignored");
    expect(
      callback({ type: "message", channel: "G1", channel_type: "mpim", user: "U1", text: "hi" })
        .kind,
    ).toBe("ignored");
    expect(callback({ type: "app_mention", ...channel, user: "U1", text: "<@U_BOT>" }).kind).toBe(
      "ignored",
    );
    expect(callback({}, { type: "url_verification" }).kind).toBe("ignored");
    expect(() => readSlackDelivery({ body: encoder.encode("nope"), receivedAt })).toThrow(
      WebhookBodyError,
    );
  });

  test("the catalog lists every recorded type", () => {
    expect(slackEventTypeCatalog().map((entry) => entry.type)).toEqual([
      "message.posted",
      "message.edited",
      "message.deleted",
      "reaction.added",
      "member.joined_channel",
      "member.left_channel",
    ]);
  });
});
