import { describe, expect, test } from "bun:test";
import type { ScheduledTask, ScheduledTaskRun } from "@/types";
import {
  agentConfigFromFormState,
  applyScheduledTaskCadence,
  formStateFromScheduledTask,
  groupScheduledTasksForList,
  knowledgeSyncSourceLabel,
  newScheduledTaskFormState,
  nextScheduledRunAt,
  nextScheduledRunLabel,
  notableLastRunSummary,
  recurringSessionTaskFormState,
  scheduleFromFormState,
  scheduleLabel,
  scheduledTaskCadence,
  scheduledTaskDescription,
  scheduledTaskRunLabel,
  scheduledTaskRunSessionAccess,
  scheduledTaskRunTriggerIsRedundant,
  scheduledTaskRunTriggerLabel,
  scheduledTaskStateLabel,
  summarizeLastRun,
  taskMetadataFromFormState,
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
    authorityRevision: 1,
    executionDigest: "a".repeat(64),
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

describe("scheduled task form projection", () => {
  test("labels on-demand connector cadence and summarizes deterministic sync counts", () => {
    expect(scheduleLabel({ type: "manual" })).toBe("On demand");
    expect(
      summarizeLastRun([
        {
          id: connectionId,
          accountId: scheduledTask().accountId,
          workspaceId: scheduledTask().workspaceId,
          taskId: scheduledTask().id,
          taskAuthorityRevision: null,
          taskExecutionDigest: null,
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

  test("keeps successful run text out of collapsed-card summaries", () => {
    expect(notableLastRunSummary([scheduledTaskRun({ status: "succeeded" })])).toBeNull();
    expect(
      notableLastRunSummary([scheduledTaskRun({ status: "failed", error: "Timed out" })]),
    ).toMatchObject({ tone: "failed", label: "last run failed: Timed out" });
    expect(notableLastRunSummary([scheduledTaskRun({ status: "queued" })])).toMatchObject({
      tone: "pending",
    });
  });

  test("keeps user pause, connection pause, and disabled sync distinct", () => {
    const task = scheduledTask();
    expect(scheduledTaskStateLabel(task)).toMatchObject({
      label: "Active",
      reason: "active",
    });
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
          destination: {
            kind: "workspace",
            workspaceId: task.workspaceId,
            subjectId: null,
          },
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
        metadata: {
          knowledgeSourceSync: { sourceEnabled: true, connectionPaused: true },
        },
      }),
    ).toMatchObject({
      label: "Connection paused",
      reason: "connection_paused",
    });
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

  test("keeps the human description separate from agent instructions", () => {
    const task = scheduledTask();
    task.metadata = {
      retained: true,
      scheduleDescription: "Reviews production health",
    };
    const form = formStateFromScheduledTask(task);

    expect(form.description).toBe("Reviews production health");
    expect(scheduledTaskDescription(task)).toBe("Reviews production health");
    expect(agentConfigFromFormState(form, task).prompt).toBe(task.agentConfig.prompt);
    expect(
      taskMetadataFromFormState({ ...form, description: "  Updated summary  " }, task),
    ).toEqual({ retained: true, scheduleDescription: "Updated summary" });
    expect(taskMetadataFromFormState({ ...form, description: "" }, task)).toEqual({
      retained: true,
    });
  });

  test("round-trips the model and reasoning selected for scheduled runs", () => {
    const task = scheduledTask();
    task.agentConfig.model = "codex/gpt-5.6-sol";
    task.agentConfig.reasoningEffort = "xhigh";

    const form = formStateFromScheduledTask(task);
    expect(form.model).toBe("codex/gpt-5.6-sol");
    expect(form.reasoningEffort).toBe("xhigh");
    expect(agentConfigFromFormState(form, task)).toMatchObject({
      model: "codex/gpt-5.6-sol",
      reasoningEffort: "xhigh",
    });

    const changed = {
      ...form,
      model: "openai/gpt-5.4",
      reasoningEffort: "medium" as const,
    };
    expect(agentConfigFromFormState(changed, task)).toMatchObject({
      model: "openai/gpt-5.4",
      reasoningEffort: "medium",
    });
  });

  test("round-trips a Connected Machine target and never copies it to an existing session", () => {
    const targetSandboxId = "77777777-7777-4777-8777-777777777777";
    const task = scheduledTask();
    task.agentConfig.machineTarget = {
      targetSandboxId,
      workingDir: "/home/me/repos/app",
    };

    const form = formStateFromScheduledTask(task);
    expect(form).toMatchObject({
      executionTarget: "machine",
      machineSandboxId: targetSandboxId,
      workingDir: "/home/me/repos/app",
    });
    expect(agentConfigFromFormState(form, task).machineTarget).toEqual({
      targetSandboxId,
      workingDir: "/home/me/repos/app",
    });

    expect(
      agentConfigFromFormState(
        {
          ...form,
          runMode: "existing_session",
          targetSessionId: "88888888-8888-4888-8888-888888888888",
        },
        task,
      ),
    ).not.toHaveProperty("machineTarget");
  });

  test("defaults self-hosted deployments to the first Connected Machine", () => {
    expect(
      newScheduledTaskFormState(false, [], {
        defaultSandboxBackend: "selfhosted",
        defaultMachineSandboxId: "99999999-9999-4999-8999-999999999999",
      }),
    ).toMatchObject({
      executionTarget: "machine",
      sandboxBackend: "",
      machineSandboxId: "99999999-9999-4999-8999-999999999999",
    });
  });

  test("maps clean cadence presets onto the exact supported schedule specs", () => {
    const initial = newScheduledTaskFormState(false);
    const hourly = applyScheduledTaskCadence(initial, "hourly");
    expect(scheduledTaskCadence(hourly)).toBe("hourly");
    expect(scheduleFromFormState(hourly)).toEqual({
      type: "interval",
      everySeconds: 3_600,
    });

    const weekly = applyScheduledTaskCadence(initial, "weekly");
    expect(scheduledTaskCadence(weekly)).toBe("weekly");
    expect(scheduleFromFormState(weekly)).toMatchObject({
      type: "calendar",
      daysOfWeek: ["MONDAY"],
    });

    const interval = applyScheduledTaskCadence(initial, "interval");
    expect(scheduledTaskCadence(interval)).toBe("interval");
    expect(scheduleFromFormState(interval)).toEqual({
      type: "interval",
      everySeconds: 1_800,
    });
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
    calendarTask.schedule = {
      type: "calendar",
      timeZone: "UTC",
      hour: 9,
      minute: 30,
    };
    const calendarForm = formStateFromScheduledTask(calendarTask);
    expect(calendarForm.targetSessionId).toBe(targetSessionId);
    expect(calendarForm.calendarTime).toBe("09:30");
    expect(calendarForm.timeZone).toBe("UTC");
  });

  test("carries the days of a weekly schedule through an untouched edit", () => {
    // The bug this covers: the form state dropped daysOfWeek entirely, so
    // opening Edit on a Mon/Wed/Fri schedule and saving anything at all
    // rewrote it to fire every day.
    const weekly = scheduledTask();
    weekly.schedule = {
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 5,
      daysOfWeek: ["FRIDAY", "MONDAY", "WEDNESDAY"],
    };
    const weeklyForm = formStateFromScheduledTask(weekly);
    // Canonical Sunday-first order, so an equivalent stored order cannot
    // round-trip into a different-looking spec.
    expect(weeklyForm.calendarDaysOfWeek).toEqual(["MONDAY", "WEDNESDAY", "FRIDAY"]);
    expect(scheduleFromFormState(weeklyForm)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 5,
      daysOfWeek: ["MONDAY", "WEDNESDAY", "FRIDAY"],
    });

    // A schedule with no day filter stays filterless: the contract rejects an
    // empty daysOfWeek array, so the field is omitted rather than sent empty.
    const daily = scheduledTask();
    daily.schedule = { type: "calendar", timeZone: "UTC", hour: 0, minute: 0 };
    const dailyForm = formStateFromScheduledTask(daily);
    expect(dailyForm.calendarDaysOfWeek).toEqual([]);
    const dailySpec = scheduleFromFormState(dailyForm);
    expect(dailySpec).toEqual({
      type: "calendar",
      timeZone: "UTC",
      hour: 0,
      minute: 0,
    });
    expect(dailySpec).not.toHaveProperty("daysOfWeek");

    // All seven days is a stored fact of its own and survives as itself rather
    // than being normalized into the filterless form.
    const everyDay = scheduledTask();
    everyDay.schedule = {
      type: "calendar",
      timeZone: "UTC",
      hour: 6,
      minute: 30,
      daysOfWeek: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
    };
    const everyDayForm = formStateFromScheduledTask(everyDay);
    expect(everyDayForm.calendarDaysOfWeek).toHaveLength(7);
    expect(scheduleFromFormState(everyDayForm)).toEqual(everyDay.schedule);

    // Switching a weekly schedule to another cadence carries no day filter into
    // a spec that has no such field.
    expect(scheduleFromFormState({ ...weeklyForm, scheduleType: "interval" })).toEqual({
      type: "interval",
      everySeconds: 3_600,
    });
  });

  test("prefills an explicit recurring editor without copying Slack content", () => {
    const targetSessionId = "55555555-5555-4555-8555-555555555555";
    const form = recurringSessionTaskFormState(targetSessionId, true);

    expect(form).toMatchObject({
      name: "Recurring Slack task",
      scheduleType: "interval",
      intervalMinutes: 60,
      runMode: "existing_session",
      targetSessionId,
      overlapPolicy: "skip",
      includeOpenGeniTool: true,
      slackBotConnectionId: "",
    });
    expect(form.prompt).not.toContain("Slack message");
  });
});

function knowledgeSyncAction(
  overrides: Partial<Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>> = {},
): Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }> {
  const workspaceId = scheduledTask().workspaceId;
  return {
    kind: "knowledge_source_sync",
    sourceId: connectionId,
    sourceGeneration: 0,
    sourceLifecycleGeneration: 1,
    sourceConfigGeneration: 1,
    controlWorkspaceId: workspaceId,
    providerCoordinationKey: "google-drive:google-consumer:my-drive",
    connection: {
      connectionId,
      connectionVersion: 1,
      providerDomain: "googleapis.com",
      kind: "oauth2",
      ownerSubjectId: "subject-a",
    },
    destination: { kind: "workspace", workspaceId, subjectId: null },
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
    ...overrides,
  };
}

function scheduledTaskRun(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  const task = scheduledTask();
  return {
    id: "66666666-6666-4666-8666-666666666666",
    accountId: task.accountId,
    workspaceId: task.workspaceId,
    taskId: task.id,
    taskAuthorityRevision: null,
    taskExecutionDigest: null,
    status: "succeeded",
    triggerType: "scheduled",
    scheduledAt: null,
    firedAt: "2024-05-01T09:00:00.000Z",
    sessionId: null,
    triggerEventId: null,
    actionKind: "agent_turn",
    knowledgeSyncRunId: null,
    knowledgeSummary: null,
    completedAt: null,
    error: null,
    createdAt: "2024-05-01T09:00:00.000Z",
    updatedAt: "2024-05-01T09:00:00.000Z",
    ...overrides,
  };
}

describe("scheduleLabel", () => {
  test("names every schedule variant", () => {
    expect(scheduleLabel({ type: "manual" })).toBe("On demand");
    expect(scheduleLabel({ type: "interval", everySeconds: 60 })).toBe("Every 1 minute");
    expect(scheduleLabel({ type: "interval", everySeconds: 21_600 })).toBe("Every 6 hours");
    expect(scheduleLabel({ type: "interval", everySeconds: 172_800 })).toBe("Every 2 days");
    expect(
      scheduleLabel({
        type: "calendar",
        timeZone: "Europe/Oslo",
        hour: 9,
        minute: 0,
      }),
    ).toBe("Daily 09:00 Europe/Oslo");
  });

  test("computes truthful next interval and zoned calendar boundaries", () => {
    const now = new Date("2026-08-20T10:14:30.000Z");
    expect(
      nextScheduledRunAt({ type: "interval", everySeconds: 6 * 60 * 60 }, now)?.toISOString(),
    ).toBe("2026-08-20T12:00:00.000Z");
    expect(nextScheduledRunLabel({ type: "interval", everySeconds: 6 * 60 * 60 }, now)).toBe(
      "Next in 2h",
    );
    expect(
      nextScheduledRunAt(
        {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 9,
          minute: 0,
          daysOfWeek: ["FRIDAY"],
        },
        now,
      )?.toISOString(),
    ).toBe("2026-08-21T07:00:00.000Z");
  });

  test("states the actual days of a weekly calendar schedule", () => {
    const base = {
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 5,
    } as const;

    // The bug this covers: daysOfWeek was ignored outright, so a Monday-only
    // schedule advertised itself as firing every day.
    expect(scheduleLabel({ ...base, daysOfWeek: ["MONDAY"] })).toBe("Mon 09:05 Europe/Oslo");
    expect(scheduleLabel({ ...base, daysOfWeek: ["FRIDAY", "MONDAY", "WEDNESDAY"] })).toBe(
      "Mon, Wed, Fri 09:05 Europe/Oslo",
    );
    expect(
      scheduleLabel({
        ...base,
        daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
      }),
    ).toBe("Weekdays 09:05 Europe/Oslo");
    expect(scheduleLabel({ ...base, daysOfWeek: ["SATURDAY", "SUNDAY"] })).toBe(
      "Weekends 09:05 Europe/Oslo",
    );
  });

  test("reads a full or duplicated week as plain daily", () => {
    const base = {
      type: "calendar",
      timeZone: "UTC",
      hour: 0,
      minute: 0,
    } as const;
    expect(
      scheduleLabel({
        ...base,
        daysOfWeek: ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"],
      }),
    ).toBe("Daily 00:00 UTC");
    expect(scheduleLabel({ ...base, daysOfWeek: ["MONDAY", "MONDAY"] })).toBe("Mon 00:00 UTC");
  });

  test("never claims the time zone a once schedule does not honor", () => {
    // temporalScheduleSpec materializes `once` from the absolute instant into
    // UTC calendar fields and pins the Temporal spec to UTC, so the spec's own
    // timeZone is inert. The label must not promise it.
    const label = scheduleLabel({
      type: "once",
      runAt: "2024-05-01T09:00:00.000Z",
      timeZone: "Pacific/Kiritimati",
    });
    expect(label.startsWith("Once ")).toBe(true);
    expect(label).not.toContain("Pacific/Kiritimati");
  });
});

describe("groupScheduledTasksForList", () => {
  test("orders active tasks by most recent run, then newest first", () => {
    const ran = {
      ...scheduledTask(),
      id: "task-ran",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const ranLater = {
      ...scheduledTask(),
      id: "task-ran-later",
      createdAt: "2024-03-01T00:00:00.000Z",
    };
    const neverRan = {
      ...scheduledTask(),
      id: "task-never-ran",
      createdAt: "2024-02-01T00:00:00.000Z",
    };
    const runUnknown = {
      ...scheduledTask(),
      id: "task-run-unknown",
      createdAt: "2024-04-01T00:00:00.000Z",
    };

    const groups = groupScheduledTasksForList([neverRan, ran, runUnknown, ranLater], {
      [ran.id]: "2024-05-01T00:00:00.000Z",
      [ranLater.id]: "2024-06-01T00:00:00.000Z",
      [neverRan.id]: null,
      // runUnknown is deliberately absent: a failed probe is not evidence that
      // the task has never run, and it must still sort deterministically.
    });

    expect(groups.active.map((task) => task.id)).toEqual([
      "task-ran-later",
      "task-ran",
      "task-run-unknown",
      "task-never-ran",
    ]);
    expect(groups.paused).toEqual([]);
  });

  test("separates every schedule that will not fire, not only user pauses", () => {
    const active = { ...scheduledTask(), id: "task-active" };
    const userPaused = {
      ...scheduledTask(),
      id: "task-user-paused",
      status: "paused" as const,
    };
    const connectionPaused = {
      ...scheduledTask(),
      id: "task-connection-paused",
      action: knowledgeSyncAction(),
      metadata: {
        knowledgeSourceSync: { sourceEnabled: true, connectionPaused: true },
      },
    };
    const sourceDisabled = {
      ...scheduledTask(),
      id: "task-source-disabled",
      action: knowledgeSyncAction(),
      metadata: {
        knowledgeSourceSync: { sourceEnabled: false, connectionPaused: false },
      },
    };

    const groups = groupScheduledTasksForList(
      [userPaused, active, connectionPaused, sourceDisabled],
      { [userPaused.id]: "2024-07-01T00:00:00.000Z" },
    );

    expect(groups.active.map((task) => task.id)).toEqual(["task-active"]);
    // The user-paused row ran most recently, so it leads its own section.
    expect(groups.paused.map((task) => task.id)).toEqual([
      "task-user-paused",
      "task-connection-paused",
      "task-source-disabled",
    ]);
  });
});

describe("scheduled task run rows", () => {
  test("identifies a run by outcome and fired-at, never by id", () => {
    const run = scheduledTaskRun({
      status: "failed",
      firedAt: "2024-05-01T09:00:00.000Z",
    });
    const label = scheduledTaskRunLabel(run);
    expect(label.startsWith("Failed · ")).toBe(true);
    expect(label).not.toContain(run.id);
    expect(scheduledTaskRunTriggerLabel("manual")).toBe("Run now");
    expect(scheduledTaskRunTriggerLabel("provider_event")).toBe("Provider event");
    expect(scheduledTaskRunTriggerIsRedundant("scheduled")).toBe(true);
    expect(scheduledTaskRunTriggerIsRedundant("schedule")).toBe(true);
    expect(scheduledTaskRunTriggerIsRedundant("manual")).toBe(false);
  });

  test("tells a missing session apart from one this viewer may not open", () => {
    const linked = scheduledTaskRun({
      sessionId: "77777777-7777-4777-8777-777777777777",
      status: "dispatched",
    });
    expect(scheduledTaskRunSessionAccess(linked, { canReadSessionIds: true })).toBe("open");

    // scheduledTaskRunForGrant nulls sessionId without sessions:control, so a
    // dispatched agent run really did produce a session this viewer cannot open.
    const stripped = scheduledTaskRun({
      sessionId: null,
      status: "dispatched",
    });
    expect(scheduledTaskRunSessionAccess(stripped, { canReadSessionIds: false })).toBe(
      "restricted",
    );
    expect(scheduledTaskRunSessionAccess(stripped, { canReadSessionIds: true })).toBe("none");

    // A connector sync never has a session, and a run that never dispatched has
    // nothing to link to either way.
    const sync = scheduledTaskRun({
      actionKind: "knowledge_source_sync",
      sessionId: null,
    });
    expect(scheduledTaskRunSessionAccess(sync, { canReadSessionIds: false })).toBe("none");
    const skipped = scheduledTaskRun({ status: "skipped", sessionId: null });
    expect(scheduledTaskRunSessionAccess(skipped, { canReadSessionIds: false })).toBe("none");
  });
});

describe("malformed scheduled tasks degrade instead of throwing", () => {
  test("describes a knowledge sync without printing its source uuid", () => {
    const label = knowledgeSyncSourceLabel(knowledgeSyncAction());
    expect(label).toBe("Workspace scope · googleapis.com · with descendants");
    expect(label).not.toContain(connectionId.slice(0, 8));

    expect(
      knowledgeSyncSourceLabel(
        knowledgeSyncAction({
          destination: {
            kind: "personal",
            workspaceId: null,
            subjectId: "subject-a",
          },
          allDescendants: false,
        }),
      ),
    ).toBe("Personal scope · googleapis.com · selected only");
  });

  test("survives an action missing its destination and connection", () => {
    const partial = {
      kind: "knowledge_source_sync",
      allDescendants: false,
    } as unknown as Extract<ScheduledTask["action"], { kind: "knowledge_source_sync" }>;
    expect(knowledgeSyncSourceLabel(partial)).toBe("Unknown scope · selected only");
  });

  test("survives a task with no action or metadata at all", () => {
    const partial = {
      ...scheduledTask(),
      action: undefined,
      metadata: undefined,
    } as unknown as ScheduledTask;
    expect(scheduledTaskStateLabel(partial)).toMatchObject({
      label: "Active",
      active: true,
    });
    expect(groupScheduledTasksForList([partial], {}).active.map((task) => task.id)).toEqual([
      partial.id,
    ]);
  });
});
