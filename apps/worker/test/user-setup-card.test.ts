import { describe, expect, test } from "bun:test";
import { ToolAuthNeededPayload, userSetupBlocker } from "@opengeni/contracts";
import { userSetupCardPayload } from "@opengeni/core";
import { userSetupCardPoster } from "../src/activities/agent-turn/user-setup-card";

const ids = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  sessionId: "00000000-0000-4000-8000-000000000002",
  turnId: "00000000-0000-4000-8000-000000000003",
  attemptId: "00000000-0000-4000-8000-000000000004",
};
const chrome = userSetupBlocker("attached_browser_unavailable")!;
const machinePermission = userSetupBlocker("personal_machine_permission_required")!;

function poster(
  overrides: Partial<Parameters<typeof userSetupCardPoster>[0]> = {},
  outcome = { events: [{ id: "event-1" }], accepted: true, existingEventId: null as string | null },
) {
  const appends: unknown[][] = [];
  const published: unknown[][] = [];
  const post = userSetupCardPoster({
    db: "db" as never,
    bus: "bus" as never,
    connectedMachinesEnabled: true,
    webBaseUrl: "https://app.example.test",
    executionGeneration: 7,
    ...ids,
    append: (async (...args: unknown[]) => {
      appends.push(args);
      return outcome;
    }) as never,
    publish: (async (...args: unknown[]) => {
      published.push(args);
    }) as never,
    ...overrides,
  });
  return { post, appends, published };
}

describe("setup card for a refusal the person can fix", () => {
  test("the Chrome blocker is a Connected Machine card for Chrome", () => {
    const payload = ToolAuthNeededPayload.parse(
      userSetupCardPayload(chrome, { toolName: "browser_open" }),
    );
    expect(payload).toMatchObject({
      serverId: "opengeni",
      toolName: "browser_open",
      reason: "missing_connection",
      purpose: "chrome",
      capability: { id: "api:connected-machine", action: "connect" },
    });
    expect(payload.capability?.rationale).toBe("Connect your Chrome so the agent can use it.");
    // A blocker without a purpose gets the plain card for its capability.
    expect(
      userSetupCardPayload(machinePermission, { toolName: "computer_open" }),
    ).not.toHaveProperty("purpose");
  });

  test("posts nothing when Connected Machines are off", async () => {
    const { post, appends } = poster({ connectedMachinesEnabled: false });
    expect(await post(chrome, "browser_open")).toBeNull();
    expect(appends).toHaveLength(0);
  });

  test("appends the card once for the calling turn attempt, publishes it and links the chat", async () => {
    const { post, appends, published } = poster();
    expect(await post(chrome, "browser_open")).toEqual({
      chatUrl: `https://app.example.test/workspaces/${ids.workspaceId}/sessions/${ids.sessionId}`,
    });
    expect(appends).toEqual([
      [
        "db",
        ids.workspaceId,
        ids.sessionId,
        ids.turnId,
        7,
        ids.attemptId,
        "api:connected-machine",
        {
          type: "tool.auth_needed",
          payload: userSetupCardPayload(chrome, { toolName: "browser_open" }),
        },
      ],
    ]);
    expect(published).toEqual([["bus", ids.workspaceId, ids.sessionId, [{ id: "event-1" }]]]);
  });

  test("reports a card this turn already showed, and a replaced turn as not posted", async () => {
    const shown = poster(
      { webBaseUrl: null },
      { events: [], accepted: true, existingEventId: "x" },
    );
    expect(await shown.post(chrome, "browser_open")).toEqual({ chatUrl: null });
    const replaced = poster({}, { events: [], accepted: false, existingEventId: null });
    expect(await replaced.post(chrome, "browser_open")).toBeNull();
  });
});
