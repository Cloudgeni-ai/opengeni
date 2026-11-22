import { describe, expect, test } from "bun:test";
import { connectionCardWithdrawals } from "../src/connection-card-withdrawals";

const notice = (sessionId: string, workspaceId: string, sourceKey: string) => ({
  kind: "notification",
  sessionId,
  workspaceId,
  sourceKey,
});

describe("connection card withdrawals", () => {
  test("an account's notices close in every workspace, a capability's only in its own", () => {
    const result = connectionCardWithdrawals(
      { workspaceId: "ws-a", sessionId: "chat-1" },
      [
        { key: "connection-card:account", accountWide: true },
        { key: "connection-card:capability", accountWide: false },
      ],
      [
        notice("chat-2", "ws-a", "connection-card:capability"),
        notice("chat-3", "ws-b", "connection-card:capability"),
        notice("chat-4", "ws-b", "connection-card:account"),
        notice("chat-5", "ws-b", "connection-card:unrelated"),
        { ...notice("chat-6", "ws-a", "connection-card:account"), kind: "approval" },
      ],
    );
    expect(
      Object.fromEntries(
        [...result].map(([id, entry]) => [id, [entry.workspaceId, [...entry.keys]]]),
      ),
    ).toEqual({
      "chat-1": ["ws-a", ["connection-card:account", "connection-card:capability"]],
      "chat-2": ["ws-a", ["connection-card:capability"]],
      "chat-4": ["ws-b", ["connection-card:account"]],
    });
  });
});
