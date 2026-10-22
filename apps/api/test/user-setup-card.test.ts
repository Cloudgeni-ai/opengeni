import { describe, expect, test } from "bun:test";
import { userSetupBlocker, userSetupCardShownMessage } from "@opengeni/contracts";
import { sessionChatUrl, withUserSetupCard } from "../src/mcp/user-setup-card";

const permissionRequired = {
  swapped: false,
  code: "personal_machine_permission_required",
  reason:
    "This is a personal (Only me) machine, and its owner has not allowed this chat to use it.",
};

describe("setup card on a refusal the person can fix", () => {
  test("posts the card, links the chat, and tells the agent not to wait or retry", async () => {
    let posts = 0;
    let blockerCode: string | undefined;
    const chatUrl = "https://app.example.test/workspaces/w/sessions/s";
    const result = await withUserSetupCard(permissionRequired, async (blocker) => {
      posts += 1;
      blockerCode = blocker.code;
      return { eventId: "event-1", chatUrl };
    });
    expect(blockerCode).toBe("personal_machine_permission_required");
    expect(posts).toBe(1);
    expect(result).toMatchObject({
      swapped: false,
      code: "personal_machine_permission_required",
      card: "shown",
      cardEventId: "event-1",
      chatUrl,
      reason: userSetupCardShownMessage(
        userSetupBlocker("personal_machine_permission_required")!,
        chatUrl,
      ),
    });
    // Truthful about where the card is: it is in the Opengeni chat, and a
    // person reading elsewhere (Slack, a worker or scheduled chat) gets the link.
    expect(result.reason).toContain("now posted in this chat in Opengeni");
    expect(result.reason).toContain(`give them this link to it: ${chatUrl}`);
    expect(result.reason).toContain("Do not wait for it and do not retry");
  });

  test("without a web address it points the person to the chat in Opengeni", async () => {
    const result = await withUserSetupCard(permissionRequired, async () => ({
      eventId: "event-1",
      chatUrl: null,
    }));
    expect(result.card).toBe("shown");
    expect("chatUrl" in result).toBe(false);
    expect(result.reason).toContain("tell them to open this chat in Opengeni to use it");
  });

  test("never shows it for someone who is not the owner, or for other failures", async () => {
    for (const refused of [
      { ok: false, code: "personal_machine_not_permitted", reason: "Only its owner can use it." },
      { swapped: false, code: "offline_enrollment", reason: "offline" },
      { ok: false, reason: "sandbox x not found in this workspace" },
      { ok: true, stdout: "ok" },
    ]) {
      let posts = 0;
      const result = await withUserSetupCard(refused, async () => {
        posts += 1;
        return { eventId: "event-1", chatUrl: null };
      });
      expect(posts).toBe(0);
      expect(result).toEqual(refused);
    }
  });

  test("keeps the original refusal when no card can be posted", async () => {
    expect(await withUserSetupCard(permissionRequired, async () => null)).toEqual(
      permissionRequired,
    );
    expect(
      await withUserSetupCard(permissionRequired, async () => {
        throw new Error("The calling turn was replaced.");
      }),
    ).toEqual(permissionRequired);
  });

  test("builds a safe chat link only from an http(s) base", () => {
    expect(sessionChatUrl("https://app.example.test/", "w 1", "s")).toBe(
      "https://app.example.test/workspaces/w%201/sessions/s",
    );
    expect(sessionChatUrl(null, "w", "s")).toBeNull();
    expect(sessionChatUrl("javascript:alert(1)", "w", "s")).toBeNull();
    expect(sessionChatUrl("https://user:pw@app.example.test", "w", "s")).toBeNull();
  });
});
