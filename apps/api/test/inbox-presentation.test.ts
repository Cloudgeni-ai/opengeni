import { describe, expect, test } from "bun:test";
import type { InboxItemRow } from "@opengeni/db";
import { presentInboxItem } from "../src/routes/inbox";

const row = (title: string, body: string): InboxItemRow => ({
  id: "item",
  workspaceId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  kind: "reply",
  sourceKey: "k",
  title,
  subtitle: "",
  body,
  facts: [],
  link: null,
  eventSequence: 7,
  choices: [],
  urgency: "normal",
  status: "open",
  unread: true,
  snoozedUntil: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  resolvedAt: null,
  sender: null,
});

describe("an inbox item as the person sees it", () => {
  test("a reply written after a web search shows without citation handles", () => {
    const stored = row(
      "Permit check citeturn0search1",
      "The permit is required. \uE200cite\uE202turn559410search0\uE201\n- Due Friday",
    );
    for (const available of [true, false]) {
      expect(presentInboxItem(stored, "Permits", available)).toMatchObject({
        title: "Permit check",
        body: "The permit is required.\n- Due Friday",
      });
    }
    // The stored row, which agents read, keeps the exact text.
    expect(stored.body).toContain("\uE200cite");
  });
});
