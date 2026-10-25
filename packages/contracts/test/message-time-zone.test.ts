import { describe, expect, test } from "bun:test";
import {
  ClientSessionEvent,
  CreateSessionRequest,
  formatZonedModelContextTimestamp,
  MESSAGE_TIME_ZONE_METADATA_KEY,
  MessageTimeZone,
  messageTimeZoneFromTurnMetadata,
  normalizeMessageTimeZone,
  renderMessageSentAtForModel,
  renderUserMessageContentForModel,
  SteerSessionMessageRequest,
  SubmitComposerDraftRequest,
} from "../src/index";
import { currentMessageTimeZone } from "../src/message-time-zone";

const sentAt = new Date("2026-10-25T08:08:30Z");

describe("message sent line with the sender's time zone", () => {
  test("shows local time first and keeps UTC", () => {
    expect(renderMessageSentAtForModel(sentAt, "Ada", "Europe/Oslo")).toBe(
      "[Message sent Sunday 2026-10-25 09:08 Europe/Oslo (08:08 UTC) by Ada]",
    );
    expect(renderMessageSentAtForModel(sentAt, null, "America/New_York")).toBe(
      "[Message sent Sunday 2026-10-25 04:08 America/New_York (08:08 UTC)]",
    );
    // Quarter-hour offsets keep their minutes.
    expect(renderMessageSentAtForModel(sentAt, null, "Asia/Kathmandu")).toBe(
      "[Message sent Sunday 2026-10-25 13:53 Asia/Kathmandu (08:08 UTC)]",
    );
  });

  test("renders an unzoned message exactly as before", () => {
    for (const zone of [undefined, null, ""]) {
      expect(renderMessageSentAtForModel(sentAt, "Ada", zone)).toBe(
        "[Message sent Sunday 2026-10-25 08:08 UTC by Ada]",
      );
      expect(renderMessageSentAtForModel(sentAt, null, zone)).toBe(
        "[Message sent Sunday 2026-10-25 08:08 UTC]",
      );
    }
    expect(renderMessageSentAtForModel(sentAt, "Ada")).toBe(
      "[Message sent Sunday 2026-10-25 08:08 UTC by Ada]",
    );
    expect(
      renderUserMessageContentForModel("Hi", [], null, undefined, sentAt, "Ada", undefined),
    ).toEqual(renderUserMessageContentForModel("Hi", [], null, undefined, sentAt, "Ada"));
  });

  test("UTC zones and zones this runtime cannot resolve render as plain UTC", () => {
    for (const zone of ["UTC", "Etc/UTC", "Etc/GMT", "GMT", "Zulu", "Not/AZone", "+01:00"]) {
      expect(renderMessageSentAtForModel(sentAt, null, zone)).toBe(
        "[Message sent Sunday 2026-10-25 08:08 UTC]",
      );
    }
  });

  test("names the local weekday and date, and the UTC ones when they differ", () => {
    // Ahead of UTC: already the next day locally.
    expect(renderMessageSentAtForModel(new Date("2026-10-24T23:30:00Z"), null, "Asia/Tokyo")).toBe(
      "[Message sent Sunday 2026-10-25 08:30 Asia/Tokyo (Saturday 2026-10-24 23:30 UTC)]",
    );
    // Behind UTC: still the previous day locally.
    expect(
      renderMessageSentAtForModel(new Date("2026-10-25T03:30:00Z"), null, "America/Los_Angeles"),
    ).toBe(
      "[Message sent Saturday 2026-10-24 20:30 America/Los_Angeles (Sunday 2026-10-25 03:30 UTC)]",
    );
    // Local midnight renders as 00, never 24.
    expect(renderMessageSentAtForModel(new Date("2026-10-24T22:00:00Z"), null, "Europe/Oslo")).toBe(
      "[Message sent Sunday 2026-10-25 00:00 Europe/Oslo (Saturday 2026-10-24 22:00 UTC)]",
    );
  });

  test("follows daylight saving time changes", () => {
    // Spring forward: 02:00 local does not exist on 2026-03-29.
    expect(formatZonedModelContextTimestamp("2026-03-29T00:59:00Z", "Europe/Oslo")).toBe(
      "Sunday 2026-03-29 01:59 Europe/Oslo (00:59 UTC)",
    );
    expect(formatZonedModelContextTimestamp("2026-03-29T01:00:00Z", "Europe/Oslo")).toBe(
      "Sunday 2026-03-29 03:00 Europe/Oslo (01:00 UTC)",
    );
    // Fall back: 02:30 local happens twice; the UTC part tells them apart.
    expect(formatZonedModelContextTimestamp("2026-10-25T00:30:00Z", "Europe/Oslo")).toBe(
      "Sunday 2026-10-25 02:30 Europe/Oslo (00:30 UTC)",
    );
    expect(formatZonedModelContextTimestamp("2026-10-25T01:30:00Z", "Europe/Oslo")).toBe(
      "Sunday 2026-10-25 02:30 Europe/Oslo (01:30 UTC)",
    );
    // Summer and winter offsets under another region's rules.
    expect(formatZonedModelContextTimestamp("2026-07-01T12:00:00Z", "America/New_York")).toBe(
      "Wednesday 2026-07-01 08:00 America/New_York (12:00 UTC)",
    );
    expect(formatZonedModelContextTimestamp("2026-12-01T12:00:00Z", "America/New_York")).toBe(
      "Tuesday 2026-12-01 07:00 America/New_York (12:00 UTC)",
    );
  });

  test("rides on the sent-at part of the canonical user message only", () => {
    expect(
      renderUserMessageContentForModel(
        "Remind me tomorrow at 9",
        [],
        "selected record 42",
        undefined,
        sentAt,
        "ada@example.com",
        "Europe/Oslo",
      ),
    ).toEqual([
      {
        type: "input_text",
        text: "[Application context attached to this user message]\nselected record 42",
      },
      {
        type: "input_text",
        text: "[Message sent Sunday 2026-10-25 09:08 Europe/Oslo (08:08 UTC) by ada@example.com]",
      },
      { type: "input_text", text: "Remind me tomorrow at 9" },
    ]);
    // A zone without a durable send time adds nothing.
    expect(
      renderUserMessageContentForModel("Hi", [], null, undefined, null, null, "Europe/Oslo"),
    ).toBe("Hi");
  });
});

describe("message time zone validation", () => {
  test("normalizes resolvable IANA names and drops everything else", () => {
    expect(normalizeMessageTimeZone("Europe/Oslo")).toBe("Europe/Oslo");
    expect(normalizeMessageTimeZone("europe/oslo")).toBe("Europe/Oslo");
    expect(normalizeMessageTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "America/Argentina/Buenos_Aires",
    );
    expect(normalizeMessageTimeZone("Etc/GMT+5")).toBe("Etc/GMT+5");
    for (const value of [
      undefined,
      null,
      42,
      "",
      "UTC",
      "Etc/UTC",
      "Not/AZone",
      "+01:00",
      "Europe/Oslo]\n[Message sent",
      "Europe/Oslo by someone",
      "../etc/passwd",
      `Europe/${"x".repeat(80)}`,
    ]) {
      expect(normalizeMessageTimeZone(value)).toBeUndefined();
    }
  });

  test("request schemas accept a zone name and reject malformed or oversized values", () => {
    expect(MessageTimeZone.safeParse("Europe/Oslo").success).toBe(true);
    // Well-formed names this server does not know are accepted and ignored later.
    expect(MessageTimeZone.safeParse("Mars/Olympus_Mons").success).toBe(true);
    for (const value of ["", "+01:00", "Europe/Oslo ", "a]b", "x".repeat(65), 7]) {
      expect(MessageTimeZone.safeParse(value).success).toBe(false);
    }
    const message = (timeZone: unknown) =>
      ClientSessionEvent.safeParse({
        type: "user.message",
        payload: { text: "hello", timeZone },
      }).success;
    expect(message("Europe/Oslo")).toBe(true);
    expect(message("+01:00")).toBe(false);
    expect(
      SteerSessionMessageRequest.safeParse({ text: "now", timeZone: "Asia/Tokyo" }).success,
    ).toBe(true);
    expect(SteerSessionMessageRequest.safeParse({ text: "now", timeZone: "a b" }).success).toBe(
      false,
    );
    const submit = SubmitComposerDraftRequest.parse({
      text: "hi",
      annotations: [],
      resources: [],
      model: "test-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      expectedDraftRevision: 1,
      clientEventId: crypto.randomUUID(),
      delivery: "send",
      timeZone: "Europe/Oslo",
    });
    expect(submit.timeZone).toBe("Europe/Oslo");
    const create = CreateSessionRequest.parse({ initialMessage: "hi", timeZone: "Europe/Oslo" });
    expect(create.timeZone).toBe("Europe/Oslo");
    expect(
      CreateSessionRequest.safeParse({ initialMessage: "hi", timeZone: "+02:00" }).success,
    ).toBe(false);
  });

  test("reads only a usable zone back from turn metadata", () => {
    expect(
      messageTimeZoneFromTurnMetadata({ [MESSAGE_TIME_ZONE_METADATA_KEY]: "Europe/Oslo" }),
    ).toBe("Europe/Oslo");
    for (const metadata of [
      undefined,
      null,
      [],
      {},
      { [MESSAGE_TIME_ZONE_METADATA_KEY]: 3 },
      { [MESSAGE_TIME_ZONE_METADATA_KEY]: "Nowhere/Land" },
      { [MESSAGE_TIME_ZONE_METADATA_KEY]: "UTC" },
    ]) {
      expect(messageTimeZoneFromTurnMetadata(metadata)).toBeUndefined();
    }
  });

  test("reports this runtime's own zone only when it is a usable IANA name", () => {
    const zone = currentMessageTimeZone();
    if (zone !== undefined) expect(normalizeMessageTimeZone(zone)).toBe(zone);
  });
});
