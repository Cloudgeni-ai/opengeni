import { describe, expect, test } from "bun:test";
import { pendingConnectionCard } from "../src/timeline/pending-connection-card";
import type { AuthNeededItem, TimelineItem } from "../src/timeline/types";

const card = (id: string, extra: Partial<AuthNeededItem> = {}): TimelineItem =>
  ({
    kind: "auth-needed",
    id,
    turnId: "turn-1",
    serverId: "gmail",
    providerDomain: "gmailmcp.googleapis.com",
    connectionId: "conn-1",
    reason: "insufficient_scope",
    scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    resource: null,
    toolName: "batch_modify_messages",
    authorizationUrl: null,
    occurredAt: "2026-11-19T12:00:00.000Z",
    ...extra,
  }) as TimelineItem;
const said = (id: string) =>
  ({ kind: "agent-message", id, text: "Approve it and I'll continue." }) as unknown as TimelineItem;
const wrote = (id: string) => ({ kind: "user-message", id }) as unknown as TimelineItem;
const actionable = () => true;

describe("the connection card kept above the composer", () => {
  test("is the card the agent ended waiting on, even after more of its text", () => {
    const items = [wrote("m1"), card("c1"), said("a1")];
    expect(pendingConnectionCard(items, actionable)?.id).toBe("c1");
  });

  test("is gone once the card is done, the person wrote, or it can't be acted on", () => {
    expect(pendingConnectionCard([card("c1", { setupFinished: true })], actionable)).toBeNull();
    expect(pendingConnectionCard([card("c1"), said("a1"), wrote("m2")], actionable)).toBeNull();
    expect(pendingConnectionCard([card("c1")], () => false)).toBeNull();
    expect(pendingConnectionCard([said("a1")], actionable)).toBeNull();
  });
});
