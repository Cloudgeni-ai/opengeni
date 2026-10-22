import { describe, expect, test } from "bun:test";
import { ToolAuthNeededPayload } from "@opengeni/contracts";
import { chromeSetupCardPayload } from "@opengeni/core";
import { chromeSetupCardPoster } from "../src/activities/agent-turn/chrome-setup-card";

const ids = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  turnId: "00000000-0000-4000-8000-000000000003",
  attemptId: "00000000-0000-4000-8000-000000000004",
};

describe("Chrome setup card", () => {
  test("is a Connected Machine card for Chrome raised by browser_open", () => {
    const payload = ToolAuthNeededPayload.parse(chromeSetupCardPayload("browser_open"));
    expect(payload).toMatchObject({
      serverId: "opengeni",
      toolName: "browser_open",
      reason: "missing_connection",
      purpose: "chrome",
      capability: { id: "api:connected-machine", action: "connect" },
    });
    expect(payload.capability?.rationale).toBe("Connect your Chrome so the agent can use it.");
  });

  test("posts nothing when Connected Machines are off", () => {
    expect(
      chromeSetupCardPoster({
        db: {} as never,
        bus: {} as never,
        enabled: false,
        executionGeneration: 1,
        ...ids,
      }),
    ).toBeUndefined();
  });

  test("appends the card once for the calling turn attempt and publishes it", async () => {
    const appends: unknown[][] = [];
    const published: unknown[][] = [];
    const event = { id: "event-1" };
    const post = chromeSetupCardPoster({
      db: "db" as never,
      bus: "bus" as never,
      enabled: true,
      executionGeneration: 7,
      ...ids,
      append: (async (...args: unknown[]) => {
        appends.push(args);
        return { events: [event], accepted: true, existingEventId: null };
      }) as never,
      publish: (async (...args: unknown[]) => {
        published.push(args);
      }) as never,
    })!;
    expect(await post()).toBe(true);
    expect(appends).toEqual([
      [
        "db",
        ids.workspaceId,
        ids.sessionId,
        ids.turnId,
        7,
        ids.attemptId,
        "api:connected-machine",
        { type: "tool.auth_needed", payload: chromeSetupCardPayload("browser_open") },
      ],
    ]);
    expect(published).toEqual([["bus", ids.workspaceId, ids.sessionId, [event]]]);
  });

  test("reports a card this turn already showed, and a replaced turn as not posted", async () => {
    const outcomes = [
      { events: [], accepted: true, existingEventId: "earlier" },
      { events: [], accepted: false, existingEventId: null },
    ];
    const results: boolean[] = [];
    for (const outcome of outcomes) {
      const post = chromeSetupCardPoster({
        db: {} as never,
        bus: {} as never,
        enabled: true,
        executionGeneration: 1,
        ...ids,
        append: (async () => outcome) as never,
        publish: (async () => {}) as never,
      })!;
      results.push(await post());
    }
    expect(results).toEqual([true, false]);
  });
});
