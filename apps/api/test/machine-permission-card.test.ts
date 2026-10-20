import { describe, expect, test } from "bun:test";
import {
  MACHINE_PERMISSION_CARD_SHOWN_REASON,
  connectedMachineCardInTurn,
  withMachinePermissionCard,
} from "../src/mcp/machine-permission-card";

const permissionRequired = {
  swapped: false,
  code: "personal_machine_permission_required",
  reason:
    "This is a personal (Only me) machine, and its owner has not allowed this chat to use it.",
};

describe("Connected Machine card on a permission refusal", () => {
  test("shows the card and tells the agent not to wait or retry", async () => {
    let posts = 0;
    const result = await withMachinePermissionCard(permissionRequired, async () => {
      posts += 1;
      return { eventId: "event-1" };
    });
    expect(posts).toBe(1);
    expect(result).toMatchObject({
      swapped: false,
      code: "personal_machine_permission_required",
      card: "shown",
      cardEventId: "event-1",
      reason: MACHINE_PERMISSION_CARD_SHOWN_REASON,
    });
    expect(result.reason).toContain("A card is now shown in this chat");
    expect(result.reason).toContain("Do not wait for it and do not retry");
  });

  test("never shows it for someone who is not the owner, or for other failures", async () => {
    for (const refused of [
      { ok: false, code: "personal_machine_not_permitted", reason: "Only its owner can use it." },
      { swapped: false, code: "offline_enrollment", reason: "offline" },
      { ok: false, reason: "sandbox x not found in this workspace" },
      { ok: true, stdout: "ok" },
    ]) {
      let posts = 0;
      const result = await withMachinePermissionCard(refused, async () => {
        posts += 1;
        return { eventId: "event-1" };
      });
      expect(posts).toBe(0);
      expect(result).toEqual(refused);
    }
  });

  test("keeps the original refusal when no card can be posted", async () => {
    expect(await withMachinePermissionCard(permissionRequired, async () => null)).toEqual(
      permissionRequired,
    );
    expect(
      await withMachinePermissionCard(permissionRequired, async () => {
        throw new Error("The calling turn was replaced.");
      }),
    ).toEqual(permissionRequired);
  });

  test("reuses this turn's machine card and leaves every other card alone", () => {
    const card = (id: string, turnId: string, capabilityId: string, turnAssociation?: string) => ({
      id,
      type: "tool.auth_needed" as const,
      turnId,
      turnAssociation: (turnAssociation ?? "current") as "current",
      payload: { capability: { id: capabilityId } },
    });
    const events = [
      card("slack", "turn-1", "mcp:slack"),
      card("github", "turn-1", "api:github-app"),
      card("earlier-machine", "turn-0", "api:connected-machine"),
      card("late-machine", "turn-1", "api:connected-machine", "late_rejected"),
    ];
    // Slack and GitHub cards in the same turn do not count as a machine card.
    expect(connectedMachineCardInTurn(events, "turn-1")).toBeNull();
    expect(
      connectedMachineCardInTurn(
        [...events, card("machine", "turn-1", "api:connected-machine")],
        "turn-1",
      ),
    ).toBe("machine");
  });
});
