import { describe, expect, test } from "bun:test";
import { inputWaitReply } from "../src/activities/agent-turn/input-wait-reply";

const status = "Two of the ten reviews are done; the rest are still running.";

describe("reply recorded when a turn ends waiting for input", () => {
  test("a human or API message that ends in wait_for_input records its latest message", () => {
    for (const turnSource of ["user", "api"]) {
      expect(
        inputWaitReply({
          inputWaitYielded: true,
          turnSource,
          latestAssistantMessageText: status,
        }),
      ).toBe(status);
    }
  });

  test("machine-started turns, ordinary completions and silent waits record nothing", () => {
    for (const turnSource of ["goal", "system", "scheduled_task", "compaction", undefined]) {
      expect(
        inputWaitReply({
          inputWaitYielded: true,
          turnSource,
          latestAssistantMessageText: status,
        }),
      ).toBeNull();
    }
    // The answer of an ordinary completion is the turn output itself.
    expect(
      inputWaitReply({
        inputWaitYielded: false,
        turnSource: "user",
        latestAssistantMessageText: status,
      }),
    ).toBeNull();
    for (const latestAssistantMessageText of [null, "", "  \n"]) {
      expect(
        inputWaitReply({ inputWaitYielded: true, turnSource: "user", latestAssistantMessageText }),
      ).toBeNull();
    }
  });
});
