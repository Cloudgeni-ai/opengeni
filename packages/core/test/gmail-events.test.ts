import { describe, expect, test } from "bun:test";
import {
  eventMatchesTrigger,
  gmailDeliveryBody,
  gmailDeliveryEvents,
  gmailEventTypeCatalog,
  gmailMessageEvent,
  gmailMessageMetadata,
  parseMailbox,
} from "../src/domain/event-triggers";

const RECEIVED = new Date("2026-10-23T12:00:00Z");

function resource(headers: Array<[string, string]>, extra: Record<string, unknown> = {}) {
  return {
    id: "18b2c3",
    threadId: "18b2c0",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
    snippet: "Hi, the shipment for order 42 is late",
    internalDate: String(Date.parse("2026-10-23T11:59:00Z")),
    payload: { headers: headers.map(([name, value]) => ({ name, value })), parts: [{ body: {} }] },
    ...extra,
  };
}

describe("Gmail events", () => {
  test("a sender reads as a name and a lower-case address", () => {
    expect(parseMailbox("Ada Lovelace <Ada@Example.com>")).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
    expect(parseMailbox('"Lovelace, Ada" <ada@example.com>')).toEqual({
      name: "Lovelace, Ada",
      address: "ada@example.com",
    });
    expect(parseMailbox("<ada@example.com>")).toEqual({ name: null, address: "ada@example.com" });
    expect(parseMailbox("ada@example.com")).toEqual({ name: null, address: "ada@example.com" });
    expect(parseMailbox("Mailer daemon")).toEqual({ name: null, address: null });
    expect(parseMailbox(undefined)).toEqual({ name: null, address: null });
  });

  test("a new message becomes message.received with its headers, never its body", () => {
    const metadata = gmailMessageMetadata(
      resource([
        ["From", "Ada Lovelace <ada@example.com>"],
        ["To", "owner@example.com"],
        ["Subject", "Order 42\n is late"],
        ["X-Ignored", "not read"],
      ]),
    );
    expect(metadata).not.toBeNull();
    expect(metadata!.headers).toEqual({
      from: "Ada Lovelace <ada@example.com>",
      to: "owner@example.com",
      subject: "Order 42\n is late",
    });
    const event = gmailMessageEvent("owner@example.com", metadata!, RECEIVED);
    expect(event).toMatchObject({
      externalId: "18b2c3",
      type: "message.received",
      occurredAt: new Date("2026-10-23T11:59:00Z"),
      subject: "Order 42 is late",
      summary: "Email from Ada Lovelace: Order 42 is late",
      url: "https://mail.google.com/mail/?authuser=owner%40example.com#all/18b2c0",
      actor: { kind: "person", name: "Ada Lovelace" },
      data: {
        mailbox: "owner@example.com",
        message_id: "18b2c3",
        thread_id: "18b2c0",
        from_address: "ada@example.com",
        labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
        snippet: "Hi, the shipment for order 42 is late",
      },
    });
    expect(JSON.stringify(event.data)).not.toContain("parts");
    expect(gmailMessageMetadata({ id: "x" })).toBeNull();
  });

  test("mail Opengeni's Gmail tools wrote is Opengeni's own event", () => {
    const own = gmailMessageEvent(
      "owner@example.com",
      gmailMessageMetadata(
        resource([
          ["From", "owner@example.com"],
          ["Message-ID", "<0f5c2a2e-8a51-4b0b-9a43-2d8c1c7e0b11@opengeni.invalid>"],
        ]),
      )!,
      RECEIVED,
    );
    expect(own.actor).toEqual({ kind: "opengeni", name: "owner@example.com" });
    expect(own.summary).toBe("Email from owner@example.com: (no subject)");
    const trigger = { eventTypes: ["message.received"], conditions: [], includeOwnEvents: false };
    expect(
      eventMatchesTrigger({ ...own, data: own.data as Record<string, unknown> }, trigger),
    ).toBe(false);
    expect(
      eventMatchesTrigger(
        { ...own, data: own.data as Record<string, unknown> },
        { ...trigger, includeOwnEvents: true },
      ),
    ).toBe(true);
  });

  test("triggers match on the sender, subject and labels", () => {
    const event = gmailMessageEvent(
      "owner@example.com",
      gmailMessageMetadata(resource([["From", "Billing <billing@vendor.example>"]]))!,
      RECEIVED,
    );
    const matchable = { ...event, data: event.data as Record<string, unknown> };
    const fires = (field: string, op: "contains" | "equals", value: string) =>
      eventMatchesTrigger(matchable, {
        eventTypes: ["message.*"],
        conditions: [{ field, op, value }],
        includeOwnEvents: false,
      });
    expect(fires("data.from_address", "contains", "@VENDOR.example")).toBe(true);
    expect(fires("data.labels", "contains", "CATEGORY_PERSONAL")).toBe(true);
    expect(fires("data.labels", "contains", "CATEGORY_PROMOTIONS")).toBe(false);
    expect(fires("data.from_address", "equals", "billing@vendor.example")).toBe(true);
  });

  test("a stored read replays as the same events", () => {
    const messages = [
      gmailMessageMetadata(resource([["From", "Ada <ada@example.com>"]]))!,
      gmailMessageMetadata(
        resource([["From", "Bob <bob@example.com>"]], { id: "18b2c4", threadId: "18b2c4" }),
      )!,
    ];
    const body = gmailDeliveryBody("owner@example.com", messages);
    const replayed = gmailDeliveryEvents(body, RECEIVED);
    expect(replayed).toEqual(
      messages.map((message) => gmailMessageEvent("owner@example.com", message, RECEIVED)),
    );
    expect(gmailDeliveryEvents(new TextEncoder().encode("not json"), RECEIVED)).toEqual([]);
  });

  test("the catalog names the one event type and its fields", () => {
    const [type, ...rest] = gmailEventTypeCatalog();
    expect(rest).toEqual([]);
    expect(type).toMatchObject({ type: "message.received", available: true });
    expect(type!.fields.map((field) => field.field)).toContain("data.from_address");
  });
});
