import { describe, expect, test } from "bun:test";
import type { ToolAuthNeededPayload } from "@opengeni/contracts";
import { createToolAuthNeededCardLedger } from "../src/activities/agent-turn";

const stepUp: ToolAuthNeededPayload = {
  serverId: "gmail",
  toolName: "batch_modify_messages",
  providerDomain: "gmailmcp.googleapis.com",
  reason: "insufficient_scope",
  connectionId: "11111111-1111-4111-8111-111111111111",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
} as ToolAuthNeededPayload;

describe("connection cards in one turn", () => {
  test("a repeated ask for the same access reuses the card already posted", async () => {
    const ledger = createToolAuthNeededCardLedger();
    const posted: ToolAuthNeededPayload[] = [];
    const post = (payload: ToolAuthNeededPayload) =>
      ledger.post(payload, async () => {
        posted.push(payload);
      });
    await post(stepUp);
    // The agent retried, from another tool that needs the same access.
    await post({ ...stepUp, toolName: "modify_message", scopes: [...stepUp.scopes!].reverse() });
    expect(posted).toHaveLength(1);
    // Other access, or another account, is its own card.
    await post({ ...stepUp, scopes: ["https://www.googleapis.com/auth/gmail.compose"] });
    await post({ ...stepUp, connectionId: "22222222-2222-4222-8222-222222222222" });
    await post({ ...stepUp, reason: "expired" });
    expect(posted).toHaveLength(4);
  });

  test("an ask whose card failed to post can post again", async () => {
    const ledger = createToolAuthNeededCardLedger();
    await expect(
      ledger.post(stepUp, async () => {
        throw new Error("event store unavailable");
      }),
    ).rejects.toThrow("event store unavailable");
    let posted = 0;
    await ledger.post(stepUp, async () => {
      posted += 1;
    });
    expect(posted).toBe(1);
  });

  test("agent capability requests are never folded together", async () => {
    const ledger = createToolAuthNeededCardLedger();
    const request = {
      ...stepUp,
      reason: "missing_connection",
      capability: {
        id: "mcp:gmail",
        name: "Gmail",
        kind: "mcp",
        source: "catalog",
        action: "connect",
        rationale: "To read your mail.",
        requiredVariables: [],
      },
    } as unknown as ToolAuthNeededPayload;
    let posted = 0;
    await ledger.post(request, async () => {
      posted += 1;
    });
    await ledger.post(request, async () => {
      posted += 1;
    });
    expect(posted).toBe(2);
  });
});
