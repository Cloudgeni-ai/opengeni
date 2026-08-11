import { describe, expect, test } from "bun:test";
import type { ScheduledTask } from "@/types";
import {
  agentConfigFromFormState,
  formStateFromScheduledTask,
  newScheduledTaskFormState,
  scheduleLabel,
  scheduledTaskStateLabel,
  summarizeLastRun,
} from "./scheduled-tasks";

const connectionId = "11111111-1111-4111-8111-111111111111";

function scheduledTask(): ScheduledTask {
  const now = new Date(0).toISOString();
  return {
    id: "22222222-2222-4222-8222-222222222222",
    accountId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "44444444-4444-4444-8444-444444444444",
    name: "Explicit Slack routing",
    status: "active",
    schedule: { type: "interval", everySeconds: 3_600 },
    temporalScheduleId: "scheduled-task-test",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: {
      prompt: "Use the selected OpenGeni Slack bot",
      resources: [],
      tools: [{ kind: "mcp", id: "opengeni" }],
      metadata: {},
      slackBotConnectionId: connectionId,
    },
    targetSessionId: null,
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("scheduled task Slack bot selection", () => {
  test("labels on-demand connector cadence and summarizes deterministic sync counts", () => {
    expect(scheduleLabel({ type: "manual" })).toBe("On demand");
    expect(
      summarizeLastRun([
        {
          id: connectionId,
          accountId: scheduledTask().accountId,
          workspaceId: scheduledTask().workspaceId,
          taskId: scheduledTask().id,
          status: "succeeded",
          triggerType: "manual",
          scheduledAt: null,
          firedAt: new Date(0).toISOString(),
          sessionId: null,
          triggerEventId: null,
          actionKind: "knowledge_source_sync",
          knowledgeSyncRunId: null,
          knowledgeSummary: {
            phase: "completed",
            scanned: 5,
            imported: 2,
            unchanged: 3,
            skipped: 0,
            failed: 0,
            bytes: 10,
            providerRequests: 2,
            elapsedMs: 250,
            indexed: 2,
            aclPending: 2,
            retryable: false,
            limitReached: null,
            checkpointed: false,
            reconnectRequired: false,
            failures: [],
          },
          completedAt: new Date(1).toISOString(),
          error: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(1).toISOString(),
        },
      ])?.label,
    ).toContain("imported 2, unchanged 3, failed 0");
  });

  test("keeps user pause, connection pause, and disabled sync distinct", () => {
    const task = scheduledTask();
    expect(scheduledTaskStateLabel(task)).toMatchObject({ label: "Active", reason: "active" });
    expect(scheduledTaskStateLabel({ ...task, status: "paused" })).toMatchObject({
      label: "Paused",
      reason: "user_paused",
    });
    expect(
      scheduledTaskStateLabel({
        ...task,
        action: {
          kind: "knowledge_source_sync",
          sourceId: connectionId,
          sourceGeneration: 0,
          sourceLifecycleGeneration: 1,
          sourceConfigGeneration: 1,
          controlWorkspaceId: task.workspaceId,
          providerCoordinationKey: "google-drive:google-consumer:my-drive",
          connection: {
            connectionId,
            connectionVersion: 1,
            providerDomain: "googleapis.com",
            kind: "oauth2",
            ownerSubjectId: "subject-a",
          },
          destination: { kind: "workspace", workspaceId: task.workspaceId, subjectId: null },
          initiatingSubjectId: "subject-a",
          allDescendants: true,
          limits: {
            maxItems: 500,
            maxBytes: 500_000_000,
            maxFileBytes: 100_000_000,
            maxProviderRequests: 1_000,
            maxElapsedSeconds: 300,
            maxConcurrency: 4,
            maxFailureDetails: 25,
          },
        },
        metadata: { knowledgeSourceSync: { sourceEnabled: true, connectionPaused: true } },
      }),
    ).toMatchObject({ label: "Connection paused", reason: "connection_paused" });
  });

  test("round-trips an explicit connection and omits routing when cleared", () => {
    const task = scheduledTask();
    const form = formStateFromScheduledTask(task);
    expect(form.slackBotConnectionId).toBe(connectionId);
    expect(agentConfigFromFormState(form, task).slackBotConnectionId).toBe(connectionId);

    const cleared = { ...form, slackBotConnectionId: "" };
    expect(agentConfigFromFormState(cleared, task)).not.toHaveProperty("slackBotConnectionId");

    const fresh = newScheduledTaskFormState(true);
    expect(fresh.slackBotConnectionId).toBe("");
    expect(agentConfigFromFormState(fresh)).not.toHaveProperty("slackBotConnectionId");
  });

  test("round-trips an exact existing-session target without changing cadence", () => {
    const targetSessionId = "55555555-5555-4555-8555-555555555555";
    const intervalTask = scheduledTask();
    intervalTask.runMode = "existing_session";
    intervalTask.targetSessionId = targetSessionId;
    const intervalForm = formStateFromScheduledTask(intervalTask);
    expect(intervalForm.targetSessionId).toBe(targetSessionId);
    expect(intervalForm.intervalMinutes).toBe(60);

    const calendarTask = scheduledTask();
    calendarTask.runMode = "existing_session";
    calendarTask.targetSessionId = targetSessionId;
    calendarTask.schedule = { type: "calendar", timeZone: "UTC", hour: 9, minute: 30 };
    const calendarForm = formStateFromScheduledTask(calendarTask);
    expect(calendarForm.targetSessionId).toBe(targetSessionId);
    expect(calendarForm.calendarTime).toBe("09:30");
    expect(calendarForm.timeZone).toBe("UTC");
  });
});
