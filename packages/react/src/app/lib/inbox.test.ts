import { describe, expect, test } from "bun:test";
import type { ListInboxResponse } from "@opengeni/sdk";

import { hasInbox, InboxStore } from "./inbox";

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
