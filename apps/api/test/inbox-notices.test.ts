// A notice about something other than a chat (migration 1503), such as a
// subscription account that needs signing in again: no session, and a link
// to its page in the web app.
import { describe, expect, test } from "bun:test";
import { InboxItem, InboxNotice, ListInboxResponse } from "@opengeni/contracts";
import { presentInboxNotice } from "../src/routes/inbox";

describe("a notice about something other than a chat", () => {
  test("shows no session and links to its page on the deployment's web address", () => {
    const path = "/workspaces/w/organization?section=models&view=connect-org:claude_subscription";
    const notice = {
      id: crypto.randomUUID(),
      workspaceId: crypto.randomUUID(),
      sessionId: null,
      kind: "notification" as const,
      sourceKey: "subscription-relogin:c:1",
      title: "Sign in to Claude again",
      subtitle: "person@example.test",
      body: "Claude stopped accepting the sign-in.",
      facts: [],
      link: { url: path, label: "Sign in again" },
      eventSequence: null,
      choices: [],
      serverQuestion: null,
      urgency: "normal" as const,
      status: "open" as const,
      unread: true,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      resolvedAt: null,
      sender: null,
    };
    const presented = presentInboxNotice(notice, "https://console.example.test/");
    expect(presented).toMatchObject({
      sessionId: null,
      sessionTitle: null,
      sessionAvailable: false,
      link: { url: `https://console.example.test${path}`, label: "Sign in again" },
    });
    expect(InboxNotice.parse(presented).sessionId).toBeNull();
    // Items from chats keep their session; notices travel in their own list.
    expect(InboxItem.safeParse(presented).success).toBe(false);
    expect(
      ListInboxResponse.parse({ items: [], notices: [presented], needsYouCount: 0, unreadCount: 0 })
        .notices,
    ).toHaveLength(1);
    // Without a configured web address the path stays, for the web app to open in place.
    expect(presentInboxNotice(notice, undefined).link?.url).toBe(path);
  });
});
