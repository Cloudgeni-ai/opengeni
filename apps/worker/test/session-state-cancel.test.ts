import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: Array<{ type: string; turnId?: string | null; payload: unknown }> = [];
const controlApplications: Array<{
  workspaceId: string;
  sessionId: string;
  controlEventId: string;
}> = [];

describe("session-state interrupt settlement", () => {
  test("publishes the already-atomic durable pause recovery batch", async () => {
    publishedEvents.length = 0;
    controlApplications.length = 0;
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: { publish: async () => undefined },
          settings: {},
          observability: {},
          wakeSessionWorkflow: null,
        }) as any,
      {
        settlePendingSessionControl: mock(
          async (_db, workspaceId: string, sessionId: string, controlEventId: string) => {
            controlApplications.push({ workspaceId, sessionId, controlEventId });
            return {
              recoveringTurnId: "turn-1",
              events: [
                {
                  id: "event-recovery",
                  workspaceId,
                  sessionId,
                  sequence: 1,
                  type: "turn.recovery.requested",
                  turnId: "turn-1",
                  payload: { reason: "user_pause" },
                  occurredAt: "2026-07-10T00:00:00.000Z",
                  clientEventId: null,
                },
                {
                  id: "event-status",
                  workspaceId,
                  sessionId,
                  sequence: 2,
                  type: "session.status.changed",
                  turnId: "turn-1",
                  payload: { status: "paused" },
                  occurredAt: "2026-07-10T00:00:00.000Z",
                  clientEventId: null,
                },
              ],
            };
          },
        ),
        publishDurableSessionEvents: mock(
          async (_bus, _workspaceId, _sessionId, events: typeof publishedEvents) => {
            publishedEvents.push(...events);
          },
        ),
        countQueuedTurns: mock(async () => 0),
        recordTurnsQueuedGauge: mock(() => undefined),
      },
    );

    await activities.settleSessionControl({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      triggerEventId: "event-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    expect(controlApplications).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        controlEventId: "event-1",
      },
    ]);
    expect(publishedEvents.map((event) => event.type)).toEqual([
      "turn.recovery.requested",
      "session.status.changed",
    ]);
    expect(publishedEvents[0]).toMatchObject({
      type: "turn.recovery.requested",
      turnId: "turn-1",
      payload: { reason: "user_pause" },
    });
  });
});
