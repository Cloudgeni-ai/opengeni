import { describe, expect, test } from "bun:test";
import { sessionTimelineEmptyStateCopy } from "./session-empty-state";

describe("sessionTimelineEmptyStateCopy", () => {
  test("reports the actual zero-step lifecycle", () => {
    expect(sessionTimelineEmptyStateCopy("queued", false)).toEqual({
      title: "Starting the agent",
      description: "Your prompt is in the conversation while the agent starts.",
    });
    expect(sessionTimelineEmptyStateCopy("running", false).title).toBe("Starting the agent");
    expect(sessionTimelineEmptyStateCopy("recovering", false).title).toBe("Restoring this session");
    expect(sessionTimelineEmptyStateCopy("waiting_capacity", false)).toEqual({
      title: "Limit reached",
      description: "Your work is saved and continues automatically when capacity is available.",
    });
    expect(sessionTimelineEmptyStateCopy("requires_action", false).title).toBe(
      "Waiting for your response",
    );
    // The runtime could not start the first step: nothing to answer.
    expect(sessionTimelineEmptyStateCopy("blocked", false)).toEqual({
      title: "Could not start",
      description: "Nothing is needed from you. Your prompt is kept; recheck below to try again.",
    });
  });

  test("effective pause wins over a stale running status", () => {
    expect(sessionTimelineEmptyStateCopy("running", true)).toEqual({
      title: "Workstream paused",
      description: "Queued work stays saved. Resume the workstream when you want it to continue.",
    });
  });
});
