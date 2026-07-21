import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const fakeDb = {};
const publishedEvents: Array<{ type: string; turnId?: string | null; payload: unknown }> = [];
const controlApplications: Array<{
  workspaceId: string;
  sessionId: string;
  attemptId: string;
}> = [];
const quiescenceReceipts: Array<{
  accountId?: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  temporalWorkflowId: string;
  temporalWorkflowRunId?: string;
  temporalActivityId?: string;
  allowUninterrupted?: boolean;
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

  test("keeps the v1 receipt command replay-compatible without repeating logical settlement", async () => {
    quiescenceReceipts.length = 0;
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
        markSessionAttemptQuiesced: mock(async (_db, input) => {
          quiescenceReceipts.push(input);
          return [];
        }),
        settleSessionAttemptInterruptions: mock(async () => {
          throw new Error("logical settlement must not be repeated");
        }),
      },
    );

    expect(
      await activities.settleSessionInterruptions({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "workflow-1",
        phase: "attempt_quiesced",
      }),
    ).toEqual({ action: "stale" });
    expect(quiescenceReceipts).toEqual([
      {
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        temporalWorkflowId: "workflow-1",
      },
    ]);
    expect(controlApplications).toHaveLength(0);
  });

  test("persists and publishes an exact activity-owned quiescence proof", async () => {
    quiescenceReceipts.length = 0;
    publishedEvents.length = 0;
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
        markSessionAttemptQuiesced: mock(async (_db, input) => {
          quiescenceReceipts.push(input);
          return [
            {
              type: "session.queue.changed",
              payload: { operation: "attempt_quiesced" },
            },
          ] as any;
        }),
        publishDurableSessionEvents: mock(
          async (_bus, _workspaceId, _sessionId, events: typeof publishedEvents) => {
            publishedEvents.push(...events);
          },
        ),
      },
    );

    await activities.persistSessionAttemptQuiescence({
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "workflow-1",
      workflowRunId: "run-1",
      activityId: "activity-1",
    });

    expect(quiescenceReceipts).toEqual([
      {
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        temporalWorkflowId: "workflow-1",
        temporalWorkflowRunId: "run-1",
        temporalActivityId: "activity-1",
        allowUninterrupted: true,
      },
    ]);
    expect(publishedEvents).toEqual([
      {
        type: "session.queue.changed",
        payload: { operation: "attempt_quiesced" },
      },
    ]);
  });

  test("does not retry an authoritative receipt because NATS fanout failed", async () => {
    quiescenceReceipts.length = 0;
    const fanoutErrors: unknown[] = [];
    const activities = createSessionStateActivities(
      async () =>
        ({
          db: fakeDb,
          bus: { publish: async () => undefined },
          settings: {},
          observability: {
            error: (_message: string, attributes: unknown) => fanoutErrors.push(attributes),
          },
          wakeSessionWorkflow: null,
        }) as any,
      {
        markSessionAttemptQuiesced: mock(async (_db, input) => {
          quiescenceReceipts.push(input);
          return [];
        }),
        publishDurableSessionEvents: mock(async () => {
          throw new Error("NATS unavailable after receipt commit");
        }),
      },
    );

    await expect(
      activities.persistSessionAttemptQuiescence({
        accountId: "account-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        attemptId: "attempt-1",
        workflowId: "workflow-1",
        workflowRunId: "run-1",
        activityId: "activity-1",
      }),
    ).resolves.toBeUndefined();
    expect(quiescenceReceipts).toHaveLength(1);
    expect(fanoutErrors).toHaveLength(1);
  });
});
