import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: Array<{ type: string; turnId?: string | null; payload: unknown }> = [];
const controlApplications: Array<{
  workspaceId: string;
  sessionId: string;
  attemptId: string;
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
        settleSessionAttemptInterruptions: mock(
          async (_db, workspaceId: string, sessionId: string, attemptId: string) => {
            controlApplications.push({ workspaceId, sessionId, attemptId });
            return {
              action: "paused" as const,
              attemptId,
              turnId: "turn-1",
              outcome: "interrupted_recoverable" as const,
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
                  payload: { status: "recovering" },
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
      },
    );

    await activities.settleSessionInterruptions({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "workflow-1",
      turnId: "turn-1",
    });

    expect(controlApplications).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
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
