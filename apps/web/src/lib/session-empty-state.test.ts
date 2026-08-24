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
    expect(sessionTimelineEmptyStateCopy("waiting_capacity", false).title).toBe(
      "Waiting for capacity",
    );
    expect(sessionTimelineEmptyStateCopy("requires_action", false).title).toBe(
      "Waiting for your response",
    );
  });

  test("effective pause wins over a stale running status", () => {
    expect(sessionTimelineEmptyStateCopy("running", true)).toEqual({
      title: "Workstream paused",
      description: "Queued work stays saved. Resume the workstream when you want it to continue.",
    });
  });
});
