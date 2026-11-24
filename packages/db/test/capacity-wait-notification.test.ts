import { describe, expect, test } from "bun:test";
import { capacityWaitNotificationPayload } from "../src/capacity-wait-attention";

const turnId = "00000000-0000-4000-8000-000000000001";

describe("the person's capacity-wait notification", () => {
  test("an unclassified Codex wait does not claim the accounts are busy", () => {
    const payload = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt: new Date("2026-11-11T21:35:31.000Z"),
      waitReason: "no_eligible_capacity",
    });
    expect(payload.title).toBe("Chat waiting for Codex capacity");
    expect(payload.body).toBe(
      "No Codex subscription can serve this turn right now. Your message will be answered as soon as one has room, expected around 2026-11-11 21:35 UTC. To continue sooner, switch the chat to another model; its waiting turn continues on that model.",
    );
  });

  test("an unknown earliest time names no date", () => {
    const payload = capacityWaitNotificationPayload({ turnId, provider: "codex", resetsAt: null });
    expect(payload.body).toBe(
      "No Codex subscription can serve this turn right now. Your message will be answered as soon as one has room. To continue sooner, switch the chat to another model; its waiting turn continues on that model.",
    );
  });

  test.each([
    [
      "codex_relogin_required",
      "The Codex account “Primary” needs a new sign-in. An admin must reconnect it.",
      null,
    ],
    [
      "codex_plan_no_capacity",
      "The ChatGPT plans available to this chat don’t provide Codex capacity for this model.",
      null,
    ],
    [
      "codex_rate_limited",
      "Codex is rate-limited. This turn continues automatically when an account has capacity again. Expected around 2026-11-11 21:35 UTC.",
      new Date("2026-11-11T21:35:31.000Z"),
    ],
  ] as const)("explains %s without treating it as a busy pool", (waitReason, text, resetsAt) => {
    const { body } = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt,
      waitReason,
      waitAccount: { label: "“Primary”", personal: false },
    });
    expect(body).toStartWith(text);
    expect(body).not.toContain("busy");
  });

  test("a chat pinned to an account names it and offers automatic account choice, not a model", () => {
    const pinned = capacityWaitNotificationPayload({
      turnId,
      provider: "claude",
      resetsAt: new Date("2026-11-28T18:00:00.000Z"),
      waitReason: "pinned_account_unavailable",
      waitAccount: { label: "“Team Max”", personal: false },
    });
    expect(pinned.title).toBe("Chat waiting for its pinned Claude account");
    expect(pinned.body).toBe(
      "This chat is pinned to the Claude account “Team Max”, which has no capacity until about 2026-11-28 18:00 UTC. It continues by itself then, or sooner on another account once the chat is switched back to automatic account choice.",
    );
    expect(pinned.body).not.toContain("model");
    // Unnamed (no label, or only an email) and with no known reset.
    const unnamed = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt: null,
      waitReason: "pinned_account_unavailable",
    });
    expect(unnamed.body).toBe(
      "This chat is pinned to the Codex account, which has no capacity right now. It continues by itself when that account has room again, or sooner on another account once the chat is switched back to automatic account choice.",
    );
  });

  test("a wait with another reason keeps its own explanation", () => {
    // A wait only a person can end says how, and promises nothing by itself.
    const disabled = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt: null,
      waitReason: "pinned_account_disabled",
    });
    expect(disabled.body).toBe(
      "The Codex account pinned to this chat is turned off. Turn it back on, choose another account, or switch the chat to automatic. Waiting alone will not fix this.",
    );
    expect(disabled.title).toBe("Chat waiting for its pinned Codex account");
  });
});
