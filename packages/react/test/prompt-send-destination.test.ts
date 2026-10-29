import { describe, expect, test } from "bun:test";
import { promptSendDestination } from "../src/session-status-model";
import { promptSendDestination as fromTimelineModel } from "../src/timeline-model";
import { promptSendDestination as fromPackageRoot } from "../src/index";

describe("where a person's Send shows before the server answers", () => {
  test("a turn parked on a usage limit does not hold the Send: it starts in the chat", () => {
    // The server replaces the parked turn with the Send, so it never queues,
    // even when earlier prompts are still waiting.
    expect(
      promptSendDestination({
        status: "waiting_capacity",
        activeTurnId: "turn-1",
        queuedPrompts: 0,
      }),
    ).toBe("chat");
    expect(
      promptSendDestination({
        status: "waiting_capacity",
        activeTurnId: "turn-1",
        queuedPrompts: 1,
      }),
    ).toBe("chat");
  });

  test("a current turn or waiting prompts still queue the Send", () => {
    expect(
      promptSendDestination({
        status: "running",
        activeTurnId: "turn-1",
        queuedPrompts: 0,
      }),
    ).toBe("queue");
    expect(
      promptSendDestination({
        status: "running",
        activeTurnId: null,
        queuedPrompts: 0,
      }),
    ).toBe("queue");
    expect(
      promptSendDestination({
        status: "recovering",
        activeTurnId: "turn-1",
        queuedPrompts: 0,
      }),
    ).toBe("queue");
    expect(
      promptSendDestination({
        status: "idle",
        activeTurnId: null,
        queuedPrompts: 2,
      }),
    ).toBe("queue");
    expect(
      promptSendDestination({
        status: "idle",
        activeTurnId: null,
        queuedPrompts: 0,
      }),
    ).toBe("chat");
    expect(
      promptSendDestination({
        status: undefined,
        activeTurnId: undefined,
        queuedPrompts: 0,
      }),
    ).toBe("chat");
  });

  test("web, embedded and native surfaces share the same rule", () => {
    expect(fromTimelineModel).toBe(promptSendDestination);
    expect(fromPackageRoot).toBe(promptSendDestination);
  });
});
