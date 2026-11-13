import { describe, expect, test } from "bun:test";
import { capacityWaitNotificationPayload } from "../src/capacity-wait-attention";

const turnId = "00000000-0000-4000-8000-000000000001";

describe("the person's capacity-wait notification", () => {
  test("a busy pool says the message is answered when there is room, with the known earliest time", () => {
    const payload = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt: new Date("2026-11-11T21:35:31.000Z"),
      waitReason: "no_eligible_capacity",
    });
    expect(payload.title).toBe("Chat waiting for Codex capacity");
    expect(payload.body).toBe(
      "All Codex subscriptions are busy. Your message will be answered as soon as one has room, expected around 2026-11-11 21:35 UTC. To continue sooner, switch the chat to another model; its waiting turn continues on that model.",
    );
  });

  test("an unknown earliest time names no date", () => {
    const payload = capacityWaitNotificationPayload({ turnId, provider: "codex", resetsAt: null });
    expect(payload.body).toBe(
      "All Codex subscriptions are busy. Your message will be answered as soon as one has room. To continue sooner, switch the chat to another model; its waiting turn continues on that model.",
    );
  });

  test("a wait with another reason keeps its own explanation", () => {
    const pinned = capacityWaitNotificationPayload({
      turnId,
      provider: "codex",
      resetsAt: new Date("2026-11-14T08:46:34.000Z"),
      waitReason: "pinned_account_unavailable",
    });
    expect(pinned.body).toBe(
      "The Codex account chosen for this session is unavailable right now. This turn continues automatically once it is available again. Expected around 2026-11-14 08:46 UTC. To continue sooner, switch the chat to another model; its waiting turn continues on that model.",
    );
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
  });
});
