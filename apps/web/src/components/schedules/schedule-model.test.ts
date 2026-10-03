import { describe, expect, test } from "bun:test";

import type { ScheduledTask } from "@/types";

import {
  SCHEDULE_FREQUENCIES,
  cadenceOfSchedule,
  createRequestFromDraft,
  deriveScheduleName,
  newScheduleDraft,
  nextRunOf,
  scheduleAgentOpeningMessage,
  scheduleErrorText,
  scheduleWords,
  sortSchedulesForList,
  specFromCadence,
  updateRequestFromDraft,
  type ScheduleDraft,
} from "./schedule-model";

// Sunday 27 Sep 2026, 12:00 UTC.
const NOW = new Date("2026-09-27T12:00:00.000Z");

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "00000000-0000-4000-8000-0000000000aa",
    workspaceId: "00000000-0000-4000-8000-0000000000bb",
    name: "Check AWS cost anomalies",
    ownerSubjectId: "dev",
    status: "active",
    schedule: { type: "calendar", timeZone: "Europe/Oslo", hour: 8, minute: 0 },
    temporalScheduleId: "t",
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: { prompt: "Compare spend.", resources: [], tools: [], metadata: {} },
    createdBy: { kind: "subject", subjectId: "dev" },
    createdByContext: {},
    authorityRevision: 1,
    executionDigest: "0".repeat(64),
    reusableSessionId: null,
    targetSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
    ...overrides,
  } as ScheduledTask;
}

describe("schedule cadence", () => {
  test("never offers monthly: the API can't store a day of the month", () => {
    expect(SCHEDULE_FREQUENCIES).not.toContain("monthly");
  });

  test("a new schedule defaults to every weekday at 09:00 in the viewer's zone", () => {
    const draft = newScheduleDraft({ includeOpenGeniTool: false }, "Europe/Oslo");
    expect(draft.cadence).toEqual({
      timeZone: "Europe/Oslo",
      rule: { frequency: "weekdays", time: "09:00" },
    });
    expect(specFromCadence(draft.cadence!, NOW)).toEqual({
      type: "calendar",
      timeZone: "Europe/Oslo",
      hour: 9,
      minute: 0,
      daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
    });
  });

  test("describes stored specs in words, including 30-day intervals and on-demand", () => {
    expect(scheduleWords(task().schedule, NOW).short).toBe("Every day at 08:00 · Oslo");
    expect(scheduleWords({ type: "interval", everySeconds: 2_592_000 }, NOW).short).toBe(
      "Every 30 days",
    );
    expect(scheduleWords({ type: "manual" }, NOW).short).toBe("Only when you run it");
    expect(cadenceOfSchedule({ type: "manual" })).toBeNull();
  });

  test("paused and on-demand schedules have no next run", () => {
    expect(nextRunOf(task(), NOW)?.toISOString()).toBe("2026-09-28T06:00:00.000Z");
    expect(nextRunOf(task({ status: "paused" }), NOW)).toBeNull();
    expect(nextRunOf(task({ schedule: { type: "manual" } }), NOW)).toBeNull();
  });

  test("lists active schedules by next run, then the rest by name", () => {
    const hourly = task({
      id: "00000000-0000-4000-8000-000000000002",
      name: "Hourly",
      schedule: { type: "interval", everySeconds: 3_600 },
    });
    const paused = task({
      id: "00000000-0000-4000-8000-000000000003",
      name: "A paused one",
      status: "paused",
    });
    const daily = task();
    expect(sortSchedulesForList([paused, daily, hourly], NOW).map((each) => each.name)).toEqual([
      "Hourly",
      "Check AWS cost anomalies",
      "A paused one",
    ]);
  });
});

describe("schedule names", () => {
  test("derives a name from the first sentence without the cadence prefix", () => {
    expect(deriveScheduleName("Every weekday at 08:00: summarize open incidents. Then stop.")).toBe(
      "Summarize open incidents",
    );
    const long = deriveScheduleName(
      "Look at Sentry issues first seen in the last hour for the web and api projects and group them",
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("schedule requests", () => {
  const base = (): ScheduleDraft => ({
    ...newScheduleDraft({ includeOpenGeniTool: false }, "Europe/Oslo"),
    prompt: "Summarize open incidents.",
  });

  test("a new-chat schedule is created with the default overlap and its attachments", () => {
    const request = createRequestFromDraft(
      { ...base(), overlapPolicy: "skip", variableSetId: "vs-1", rigId: "rig-1" },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request.overlapPolicy).toBe("allow_concurrent");
    if (!("agentConfig" in request)) throw new Error("Expected a separate agent");
    expect(request.variableSetId).toBe("vs-1");
    expect(request.rigId).toBe("rig-1");
    expect(request.name).toBe("Summarize open incidents");
    expect(request.metadata).toEqual({});
  });

  test("an ongoing chat keeps Skip", () => {
    const request = createRequestFromDraft(
      { ...base(), runMode: "reusable_session", overlapPolicy: "skip" },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request.overlapPolicy).toBe("skip");
  });

  test("an existing-chat message carries no copied execution settings", () => {
    const request = createRequestFromDraft(
      {
        ...base(),
        runMode: "existing_session",
        targetSessionId: "00000000-0000-4000-8000-000000000099",
        variableSetId: "stale-set",
        rigId: "stale-environment",
      },
      { now: NOW, learningScope: "workspace" },
    );
    expect(request).toMatchObject({
      targetSessionId: "00000000-0000-4000-8000-000000000099",
      prompt: "Summarize open incidents.",
    });
    expect("agentConfig" in request).toBe(false);
    expect("variableSetId" in request).toBe(false);
    expect("rigId" in request).toBe(false);
  });

  test("moving a schedule sends only its new destination and changed message", () => {
    const initial = base();
    const stored = task();
    const request = updateRequestFromDraft(
      stored,
      initial,
      {
        ...initial,
        runMode: "existing_session",
        targetSessionId: "destination",
        prompt: "Review urgent incidents.",
      },
      { now: NOW },
    );
    expect(request).toEqual({
      expectedExecutionDigest: stored.executionDigest,
      runMode: "existing_session",
      targetSessionId: "destination",
      prompt: "Review urgent incidents.",
      name: "Review urgent incidents",
    });
  });

  test("an edit sends the schedule and attachments only when they changed", () => {
    const initial: ScheduleDraft = { ...base(), variableSetId: "vs-1", rigId: null };
    const untouched = updateRequestFromDraft(
      task(),
      initial,
      { ...initial, name: "Renamed" },
      {
        now: NOW,
      },
    );
    expect(untouched.name).toBe("Renamed");
    expect("schedule" in untouched).toBe(false);
    expect("variableSetId" in untouched).toBe(false);
    expect("rigId" in untouched).toBe(false);

    const changed = updateRequestFromDraft(
      task(),
      initial,
      {
        ...initial,
        variableSetId: null,
        rigId: "rig-2",
        cadence: { timeZone: "Europe/Oslo", rule: { frequency: "hourly" } },
      },
      { now: NOW },
    );
    expect(changed.schedule).toEqual({ type: "interval", everySeconds: 3_600 });
    expect(changed.variableSetId).toBeNull();
    expect(changed.rigId).toBe("rig-2");
  });

  test("an edit keeps a stored description it no longer shows", () => {
    const stored = task({ metadata: { scheduleDescription: "Old summary", other: 1 } });
    const initial: ScheduleDraft = { ...base(), description: "Old summary" };
    const request = updateRequestFromDraft(stored, initial, initial, { now: NOW });
    expect(request.metadata).toBeUndefined();
    expect(request).toEqual({ expectedExecutionDigest: stored.executionDigest });
  });

  test("separate-agent message edits preserve hidden settings through a narrow patch", () => {
    const stored = task();
    stored.agentConfig.approvalTimeoutSeconds = 300;
    stored.agentConfig.maxNestedAgentDepth = 0;
    stored.agentConfig.bundledSkillIds = [];
    const initial = { ...base(), name: stored.name };
    const request = updateRequestFromDraft(
      stored,
      initial,
      { ...initial, prompt: "New message" },
      { now: NOW },
    );
    expect(request).toEqual({
      expectedExecutionDigest: stored.executionDigest,
      prompt: "New message",
    });
    const changedTools = updateRequestFromDraft(
      stored,
      initial,
      { ...initial, includeOpenGeniTool: true },
      { now: NOW },
    );
    expect(changedTools.agentConfig).toMatchObject({
      approvalTimeoutSeconds: 300,
      maxNestedAgentDepth: 0,
      bundledSkillIds: [],
    });
    expect(changedTools.agentConfig).not.toHaveProperty("connectionAccountsFrozen");
  });
});

describe("schedule errors", () => {
  test("drops the API prefix and the request reference", () => {
    expect(
      scheduleErrorText(
        new Error(
          "OpenGeni API 422: self-hosted scheduled tasks require a Connected Machine; select a machine before saving Reference: 58f70db6-fcc9-4e4a-8b58-064908f49d53.",
        ),
      ),
    ).toBe(
      "Self-hosted scheduled tasks require a Connected Machine; select a machine before saving.",
    );
  });
});

describe("scheduleAgentOpeningMessage", () => {
  test("carries only the scheduling request and the person's time zone", () => {
    const message = scheduleAgentOpeningMessage(
      "  Every weekday morning, summarize new Sentry errors and post them to #eng \n",
      "Europe/Oslo",
    );
    expect(message).toBe(
      "Help me create a schedule in this workspace.\n\nEvery weekday morning, summarize new Sentry errors and post them to #eng\n\nMy time zone is Europe/Oslo.",
    );
  });
});
