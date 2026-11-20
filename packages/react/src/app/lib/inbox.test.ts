import { describe, expect, test } from "bun:test";
import type { ListInboxResponse } from "@opengeni/sdk";

import {
  hasInbox,
  inboxAttentionCount,
  inboxItemSessionId,
  inboxLinkAppPath,
  inboxView,
  InboxStore,
} from "./inbox";

describe("hasInbox", () => {
  test("only a signed-in person without a key credential has an inbox", () => {
    expect(hasInbox({ subjectId: "user:123" })).toBe(true);
    expect(hasInbox({ subjectId: "user:123", credential: { kind: "api_key" } })).toBe(false);
    expect(hasInbox({ subjectId: "configured:host-user" })).toBe(false);
    expect(hasInbox({ subjectId: "dev" })).toBe(false);
    expect(hasInbox(null)).toBe(false);
  });

  test("a local install's built-in human has an inbox; keys, agents and other modes do not", () => {
    const human = { principalKind: "human_session" };
    expect(hasInbox({ mode: "local", subjectId: "dev", workspaceGrants: [human] })).toBe(true);
    expect(hasInbox({ mode: "local", subjectId: "dev", workspaceGrants: [] })).toBe(false);
    expect(hasInbox({ mode: "configured", subjectId: "dev", workspaceGrants: [human] })).toBe(
      false,
    );
    expect(
      hasInbox({
        mode: "local",
        subjectId: "dev",
        workspaceGrants: [human],
        credential: { kind: "workspace_api_key" },
      }),
    ).toBe(false);
    expect(
      hasInbox({ mode: "local", subjectId: "dev", workspaceGrants: [{ principalKind: "agent" }] }),
    ).toBe(false);
    expect(
      hasInbox({
        mode: "local",
        subjectId: "dev",
        workspaceGrants: [{ ...human, metadata: { delegated: true } }],
      }),
    ).toBe(false);
    expect(
      hasInbox({ mode: "local", subjectId: "configured:host-user", workspaceGrants: [human] }),
    ).toBe(false);
  });
});

describe("InboxStore", () => {
  test("treats a 200 without an item list as a failed load and keeps the last good list", async () => {
    const good: ListInboxResponse = { items: [], needsYouCount: 0, unreadCount: 0 };
    let next: unknown = good;
    const store = new InboxStore({ listInbox: async () => next as ListInboxResponse });
    await store.refresh();
    expect(store.snapshot).toEqual({ data: good, error: null, loading: false });

    next = {};
    await store.refresh();
    expect(store.snapshot.data).toBe(good);
    expect(store.snapshot.error).toBeInstanceOf(Error);
  });
});

describe("notices about something other than a chat", () => {
  test("their link opens in this app when it points here", () => {
    const origin = "https://console.example.test";
    const path = "/workspaces/w/organization?section=models&account=org:claude:c";
    expect(inboxLinkAppPath(path, origin)).toBe(path);
    expect(inboxLinkAppPath(`${origin}${path}#top`, origin)).toBe(`${path}#top`);
    expect(inboxLinkAppPath("https://elsewhere.example.test/x", origin)).toBeNull();
    expect(inboxLinkAppPath("//elsewhere.example.test/x", origin)).toBeNull();
    expect(inboxLinkAppPath("not a url", origin)).toBeNull();
  });

  test("only an item from a chat names its session", () => {
    expect(inboxItemSessionId({ sessionId: "s", kind: "question" })).toBe("s");
    expect(() => inboxItemSessionId({ sessionId: null, kind: "notification" })).toThrow();
  });

  test("show in one list with the chat items, newest first, and count toward attention", () => {
    const base = {
      workspaceId: "w",
      sessionTitle: null,
      sourceKey: "k",
      title: "t",
      subtitle: "",
      body: "",
      facts: [],
      eventSequence: null,
      choices: [],
      urgency: "normal" as const,
      status: "open" as const,
      snoozedUntil: null,
      createdAt: "2026-11-01T00:00:00Z",
      resolvedAt: null,
    };
    const view = inboxView({
      items: [
        {
          ...base,
          id: "item",
          sessionId: "s",
          kind: "reply",
          link: null,
          unread: false,
          updatedAt: "2026-11-01T00:00:00Z",
        },
      ],
      notices: [
        {
          ...base,
          id: "notice",
          sessionId: null,
          kind: "notification",
          link: { url: "/workspaces/w/organization?section=models", label: "Sign in again" },
          unread: true,
          updatedAt: "2026-11-02T00:00:00Z",
          sessionAvailable: false,
        },
      ],
      needsYouCount: 0,
      unreadCount: 0,
    });
    expect(view.items.map((entry) => entry.id)).toEqual(["notice", "item"]);
    expect("notices" in view).toBe(false);
    expect(inboxAttentionCount(view)).toBe(1);
  });
});
