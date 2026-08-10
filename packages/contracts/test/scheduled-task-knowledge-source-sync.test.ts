import { describe, expect, test } from "bun:test";
import { CreateScheduledTaskRequest, ScheduledTask, ScheduledTaskRun } from "../src/index";

const accountId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const connectionId = "44444444-4444-4444-8444-444444444444";

describe("knowledge-source scheduled task contracts", () => {
  test("parses a provider-neutral action into the inert non-agent compatibility shape", () => {
    const parsed = CreateScheduledTaskRequest.parse({
      name: "Sync Drive source",
      schedule: { type: "manual" },
      overlapPolicy: "buffer_one",
      action: {
        kind: "knowledge_source_sync",
        sourceId,
        sourceGeneration: 0,
        sourceLifecycleGeneration: 1,
        sourceConfigGeneration: 1,
        controlWorkspaceId: workspaceId,
        providerCoordinationKey: "google-drive:google-consumer:my-drive",
        connection: {
          connectionId,
          connectionVersion: 7,
          providerDomain: "googleapis.com",
          kind: "oauth2",
          ownerSubjectId: "user:alice",
        },
        destination: { kind: "workspace", workspaceId, subjectId: null },
        initiatingSubjectId: "user:alice",
        allDescendants: true,
      },
    });
    expect(parsed).toMatchObject({
      runMode: "new_session_per_run",
      targetSessionId: null,
      variableSetId: null,
      rigId: null,
      agentConfig: { prompt: "Knowledge source synchronization", resources: [], tools: [] },
    });
  });

  test("legacy task rows default to the agent action while sync runs expose bounded outcomes", () => {
    const task = ScheduledTask.parse({
      id: sourceId,
      accountId,
      workspaceId,
      name: "Legacy agent task",
      status: "active",
      schedule: { type: "interval", everySeconds: 3600 },
      temporalScheduleId: "scheduled-task-legacy",
      runMode: "new_session_per_run",
      overlapPolicy: "allow_concurrent",
      agentConfig: { prompt: "Run", resources: [], tools: [], metadata: {} },
      reusableSessionId: null,
      targetSessionId: null,
      variableSetId: null,
      environmentId: null,
      rigId: null,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    expect(task.action).toEqual({ kind: "agent_turn" });

    const run = ScheduledTaskRun.parse({
      id: connectionId,
      accountId,
      workspaceId,
      taskId: sourceId,
      status: "succeeded",
      triggerType: "manual",
      scheduledAt: null,
      firedAt: new Date(0).toISOString(),
      sessionId: null,
      triggerEventId: null,
      actionKind: "knowledge_source_sync",
      knowledgeSyncRunId: null,
      knowledgeSummary: { imported: 2, unchanged: 3 },
      completedAt: new Date(1).toISOString(),
      error: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(1).toISOString(),
    });
    expect(run.knowledgeSummary).toMatchObject({ imported: 2, unchanged: 3, failed: 0 });
  });
});
