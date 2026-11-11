import { describe, expect, test } from "bun:test";
import { promptSendDestination, sessionTurnKeepsRunControl } from "../src/session-status-model";
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

  test("an admission block still holds the Send in the queue", () => {
    // Used-up Opengeni allowance or credits refuse every new turn, so the
    // server keeps the Send queued even while a turn is parked.
    expect(
      promptSendDestination({
        status: "waiting_capacity",
        activeTurnId: "turn-1",
        queuedPrompts: 0,
        admissionBlock: { reason: "allowance_exhausted" },
      }),
    ).toBe("queue");
    expect(
      promptSendDestination({
        status: "waiting_capacity",
        activeTurnId: "turn-1",
        queuedPrompts: 0,
        admissionBlock: null,
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

describe("the composer's Pause while the session's own turn is current", () => {
  test("a turn parked on a usage limit keeps Pause, so it does not continue by itself at the reset", () => {
    expect(sessionTurnKeepsRunControl("waiting_capacity")).toBe(true);
    expect(sessionTurnKeepsRunControl("running")).toBe(true);
    expect(sessionTurnKeepsRunControl("recovering")).toBe(true);
  });

  test("an idle, finished or undecided session has no turn to pause", () => {
    for (const status of ["idle", "failed", "cancelled", "queued", undefined, null] as const)
      expect(sessionTurnKeepsRunControl(status)).toBe(false);
  });
});
