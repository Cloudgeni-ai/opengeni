import { describe, expect, test } from "bun:test";
import {
  SessionNotificationPostedPayload,
  connectionCardNotice,
  connectionCardNoticeKey,
  isConnectionCardNoticeKey,
} from "../src";

const stepUp = {
  providerDomain: "gmailmcp.googleapis.com",
  toolName: "batch_modify_messages",
  reason: "insufficient_scope",
  connectionId: "11111111-1111-4111-8111-111111111111",
};

describe("connection card notices", () => {
  test("a card the person can act on is announced like an approval, one per account", () => {
    const notice = connectionCardNotice(stepUp)!;
    expect(SessionNotificationPostedPayload.parse(notice)).toEqual(notice);
    expect(notice.title).toBe("Gmail needs your permission");
    expect(isConnectionCardNoticeKey(notice.key)).toBe(true);
    // A repeat for the same account updates the same notice.
    expect(connectionCardNotice({ ...stepUp, reason: "expired" })!.key).toBe(notice.key);
    expect(connectionCardNotice({ ...stepUp, reason: "expired" })!.title).toBe("Reconnect Gmail");
    expect(
      connectionCardNotice({ ...stepUp, connectionId: "22222222-2222-4222-8222-222222222222" })!
        .key,
    ).not.toBe(notice.key);
  });

  test("an agent's capability request is keyed by the capability its continuation names", () => {
    const card = {
      providerDomain: "linear.app",
      reason: "missing_connection",
      capability: { id: "mcp:linear", name: "Linear" },
    };
    expect(connectionCardNotice(card)!.title).toBe("Connect Linear");
    expect(connectionCardNotice(card)!.key).toBe(
      connectionCardNoticeKey({ providerDomain: "", capability: { id: "mcp:linear" } }),
    );
  });

  test("a card that only explains something unavailable asks nothing of the person", () => {
    expect(connectionCardNotice({ ...stepUp, reason: "unsupported_auth" })).toBeNull();
  });

  test("only a card the agent waits on is announced, never one from preparing the turn", () => {
    // Found while preparing the turn: no call needed it, so it would announce
    // itself again every turn.
    expect(connectionCardNotice({ ...stepUp, toolName: undefined })).toBeNull();
    // Opengeni's own permissions are settings, not a connection to make.
    expect(
      connectionCardNotice({ ...stepUp, providerDomain: "opengeni", reason: "insufficient_scope" }),
    ).toBeNull();
    // An agent's request is announced whatever tool posted it.
    expect(
      connectionCardNotice({
        providerDomain: "linear.app",
        reason: "missing_connection",
        capability: { id: "mcp:linear", name: "Linear" },
      }),
    ).not.toBeNull();
  });
});
