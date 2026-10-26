import { describe, expect, test } from "bun:test";

import type { ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";

import {
  AUTOMATION_NAME_MAX_LENGTH,
  automationCadence,
  automationCreateRequest,
  automationDraftFrom,
  automationName,
  automationNextRun,
  automationRunErrorText,
  automationRunEventsLabel,
  automationScheduleSpec,
  automationUpdateRequest,
  automationWhenSentence,
  automationWhenWords,
  defaultAutomationCadence,
  deriveAutomationName,
  eventArgumentFields,
  eventArgumentLabel,
  eventArgumentsForEvent,
  eventArgumentsValue,
  hasAutomationDraftIssues,
  isAgentAutomation,
  newAutomationDraft,
  newEventTriggerDraft,
  sessionAutomationWaitWords,
  sortAutomations,
  validateAutomationDraft,
  withEventArgument,
  type AutomationDraft,
} from "../src/automations";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();
const NOW = new Date("2026-10-21T10:30:00.000Z");
const SESSION_ID = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SOURCE_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const sources = [{ id: SOURCE_ID, kind: "mcp" as const, name: "Orders" }];

const weekdays = {
  timeZone: "Europe/Oslo",
  rule: { frequency: "weekdays", time: "08:00" },
} as const;

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "Morning digest",
    status: "active",
    schedule: automationScheduleSpec(weekdays, NOW),
    events: null,
    runMode: "existing_session",
    targetSessionId: SESSION_ID,
    agentConfig: { prompt: "Summarize yesterday's orders." },
    action: { kind: "agent" },
    ...overrides,
  } as unknown as ScheduledTask;
}

function mcpTrigger(argumentsText = '{ "projectId": "p-1" }') {
  return {
    ...newEventTriggerDraft(SOURCE_ID),
    eventTypes: ["order.created"],
    argumentsText,
  };
}

function draft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    ...newAutomationDraft({ cadence: weekdays }),
    instructions: "Check the orders",
    ...overrides,
  };
}

describe("automation schedules", () => {
  test("a stored schedule round-trips as a cadence, and no cadence stores manual", () => {
    const spec = automationScheduleSpec(weekdays, NOW);
    expect(automationCadence(spec)).toEqual(weekdays);
    expect(automationScheduleSpec(null, NOW)).toEqual({ type: "manual" });
    expect(automationCadence({ type: "manual" })).toBeNull();
  });

  test("a new draft starts on the default schedule unless told otherwise", () => {
    expect(newAutomationDraft().cadence).toEqual(defaultAutomationCadence());
    expect(newAutomationDraft({ cadence: null }).cadence).toBeNull();
  });

  test("the next run skips paused, finished and unscheduled automations", () => {
    expect(automationNextRun(task(), NOW)?.toISOString()).toBe("2026-10-22T06:00:00.000Z");
    expect(automationNextRun(task({ status: "paused" }), NOW)).toBeNull();
    expect(automationNextRun(task({ schedule: { type: "manual" } }), NOW)).toBeNull();
    const finished = task({
      events: { triggers: [], once: true, completedAt: NOW.toISOString() } as never,
    });
    expect(automationNextRun(finished, NOW)).toBeNull();
  });

  test("scheduled ones sort by next run, then listeners, then the rest by name", () => {
    const listening = task({
      id: "listening",
      name: "B listens",
      schedule: { type: "manual" },
      events: { triggers: [{ id: "x", sourceId: SOURCE_ID }], once: false } as never,
    });
    const paused = task({ id: "paused", name: "A paused", status: "paused" });
    const scheduled = task({ id: "scheduled", name: "Z scheduled" });
    expect(sortAutomations([paused, listening, scheduled], NOW).map((entry) => entry.id)).toEqual([
      "scheduled",
      "listening",
      "paused",
    ]);
  });

  test("knowledge syncs are not agent automations", () => {
    expect(isAgentAutomation(task())).toBe(true);
    expect(isAgentAutomation(task({ action: { kind: "knowledge_source_sync" } as never }))).toBe(
      false,
    );
  });
});

describe("automation words", () => {
  test("when it runs, in a line and a sentence", () => {
    expect(automationWhenWords(t, task(), sources, NOW)).toContain("08:00");
    expect(automationWhenSentence(t, task(), NOW)).toMatch(/\.$/);
    const onEvents = task({
      schedule: { type: "manual" },
      events: {
        triggers: [{ id: "x", sourceId: SOURCE_ID, eventTypes: ["order.created"] }],
        once: true,
      } as never,
    });
    expect(automationWhenSentence(t, onEvents, NOW)).toBe(t("automations.when.onceOnEvent"));
    expect(automationWhenSentence(t, task({ schedule: { type: "manual" } }), NOW)).toBe(
      `${t("automations.when.manualSentence")}.`,
    );
  });

  test("a run's events read as the first one and a count", () => {
    const run = (eventCount: number) =>
      ({
        eventOccurrence: {
          eventCount,
          events: [{ type: "order.created", summary: "Order 42 created", subject: null }],
        },
      }) as unknown as ScheduledTaskRun;
    expect(automationRunEventsLabel(t, { eventOccurrence: null } as never)).toBeNull();
    expect(automationRunEventsLabel(t, run(1))).toBe("Order 42 created");
    expect(automationRunEventsLabel(t, run(3))).toContain("Order 42 created");
    expect(automationRunEventsLabel(t, run(3))).toContain("2");
  });

  test("a run's recorded reason reads as a sentence, never as its code", () => {
    expect(automationRunErrorText(t, "scheduled_turn_failed")).toBe(
      t("automations.run.error.turnFailed"),
    );
    expect(automationRunErrorText(t, " scheduled_session_not_idle ")).toBe(
      t("automations.run.error.chatBusy"),
    );
    // Refusals before a run starts share the words of the codes they mean.
    expect(automationRunErrorText(t, "machine_enrollment_inactive")).toBe(
      automationRunErrorText(t, "scheduled_machine_unavailable"),
    );
    expect(automationRunErrorText(t, "model is not available: gpt-6-luna")).toBe(
      t("automations.run.error.modelUnavailable"),
    );
    // A code this version doesn't know, or an inherited key name, is not shown.
    for (const unknown of ["scheduled_something_new", "constructor", ""]) {
      expect(automationRunErrorText(t, unknown)).toBe(t("automations.run.error.unknown"));
    }
    expect(automationRunErrorText(t, "  Sandbox capacity is unavailable.  ")).toBe(
      "Sandbox capacity is unavailable.",
    );
  });

  test("every reason the scheduler records has its own words", () => {
    const codes = [
      "scheduled_turn_failed",
      "scheduled_turn_cancelled",
      "scheduled_turn_superseded",
      "scheduled_turn_withdrawn_for_edit",
      "scheduled_update_failed",
      "scheduled_session_not_idle",
      "scheduled_session_paused",
      "session_cancelled",
      "scheduled_target_session_unavailable",
      "scheduled_target_execution_changed",
      "scheduled_workspace_paused",
      "scheduled_task_paused_before_claim",
      "scheduled_machine_unavailable",
      "scheduled_authority_unavailable",
      "scheduled_authority_exhausted",
      "connection_account_unavailable",
      "scheduled_model_unavailable",
      "machine_target_unavailable",
      "variable_set_unavailable",
      "rig_version_unavailable",
      "insufficient_credits",
      "allowance_exhausted",
      "monthly_model_cost_limit",
      "monthly_agent_run_limit",
      "session_usage_limit",
    ];
    for (const code of codes) {
      const text = automationRunErrorText(t, code);
      expect(text).not.toBe(t("automations.run.error.unknown"));
      expect(text).not.toContain("_");
    }
  });

  test("names come from the instructions when none is typed", () => {
    expect(deriveAutomationName("every weekday at 08:00: check the orders. Then rest.")).toBe(
      "Check the orders",
    );
    expect(deriveAutomationName("")).toBe("");
    const long = deriveAutomationName(
      "Read every new order in the shop and write a short note about each of the customers and the",
    );
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(61);
    expect(automationName(t, { name: "", instructions: "" })).toBe(t("automations.name.untitled"));
    expect(automationName(t, { name: " Mine ", instructions: "x" })).toBe("Mine");
  });
});

describe("automation drafts", () => {
  test("validation names what is missing", () => {
    const issues = validateAutomationDraft(
      t,
      draft({ instructions: " ", name: "x".repeat(AUTOMATION_NAME_MAX_LENGTH + 1) }),
      sources,
      NOW,
    );
    expect(issues.instructions).toBeTruthy();
    expect(issues.name).toBeTruthy();
    expect(hasAutomationDraftIssues(validateAutomationDraft(t, draft(), sources, NOW))).toBe(false);
  });

  test("a run-once automation can't also repeat on a schedule", () => {
    const once = draft({ events: { triggers: [mcpTrigger()], once: true, maxRunsPerHour: 30 } });
    expect(validateAutomationDraft(t, once, sources, NOW).when).toBeTruthy();
    expect(
      validateAutomationDraft(t, { ...once, cadence: null }, sources, NOW).when,
    ).toBeUndefined();
  });

  test("an automation in a chat continues it with that chat's settings", () => {
    const request = automationCreateRequest(
      t,
      draft({
        cadence: null,
        events: { triggers: [mcpTrigger()], once: true, maxRunsPerHour: 30 },
      }),
      { kind: "chat", sessionId: SESSION_ID },
      NOW,
    );
    expect(request).toEqual({
      name: "Check the orders",
      schedule: { type: "manual" },
      prompt: "Check the orders",
      targetSessionId: SESSION_ID,
      events: {
        triggers: [
          {
            sourceId: SOURCE_ID,
            eventTypes: ["order.created"],
            conditions: [],
            includeOwnEvents: false,
            arguments: { projectId: "p-1" },
          },
        ],
        maxRunsPerHour: 30,
        once: true,
      },
    });
  });

  test("an automation that starts new chats follows the workspace defaults, unscoped", () => {
    const request = automationCreateRequest(t, draft(), { kind: "new_chat" }, NOW);
    expect(request).toMatchObject({
      runMode: "new_session_per_run",
      agentConfig: {
        prompt: "Check the orders",
        toolPolicy: { mode: "workspace_default", excludedMcpServerIds: [] },
        executionTarget: "workspace_default",
      },
    });
    expect(request).not.toHaveProperty("events");
    expect(request).not.toHaveProperty("targetSessionId");
  });

  test("an edit sends only what changed", () => {
    const saved = task();
    const initial = automationDraftFrom(saved);
    expect(automationUpdateRequest(t, initial, initial, NOW)).toEqual({});
    expect(
      automationUpdateRequest(t, initial, { ...initial, instructions: "New words" }, NOW),
    ).toEqual({ prompt: "New words" });
    expect(automationUpdateRequest(t, initial, { ...initial, name: "" }, NOW)).toEqual({
      name: "Summarize yesterday's orders",
    });
    expect(
      automationUpdateRequest(
        t,
        { ...initial, name: "Kept" },
        { ...initial, name: "Kept", cadence: null },
        NOW,
      ),
    ).toEqual({ schedule: { type: "manual" } });
    const withEvents = {
      ...initial,
      events: { triggers: [mcpTrigger()], once: false, maxRunsPerHour: 30 },
    };
    expect(automationUpdateRequest(t, withEvents, initial, NOW)).toEqual({
      events: { triggers: [] },
    });
  });
});

describe("event arguments", () => {
  const schema = {
    type: "object",
    properties: {
      status: { enum: ["open", "closed"] },
      projectId: { type: "string", format: "uuid", description: "The project." },
      limit: { type: "integer", default: 10 },
      urgent: { type: "boolean" },
      region: {
        oneOf: [
          { const: "eu", title: "Europe" },
          { const: "us", title: "United States" },
        ],
      },
    },
    required: ["projectId"],
  };

  test("flat schemas become labelled fields, required first", () => {
    const fields = eventArgumentFields(schema);
    expect(fields?.map((field) => [field.name, field.kind, field.required])).toEqual([
      ["projectId", "text", true],
      ["status", "choice", false],
      ["limit", "number", false],
      ["urgent", "boolean", false],
      ["region", "choice", false],
    ]);
    expect(fields?.[0]).toMatchObject({
      label: "Project id",
      format: "uuid",
      description: "The project.",
    });
    expect(fields?.[2]).toMatchObject({ integer: true, placeholder: "10" });
    expect(fields?.[4]).toMatchObject({
      options: [
        { value: "eu", label: "Europe" },
        { value: "us", label: "United States" },
      ],
    });
  });

  test("schemas the form can't show fall back to JSON", () => {
    expect(eventArgumentFields(null)).toEqual([]);
    expect(eventArgumentFields({ type: "object" })).toEqual([]);
    expect(eventArgumentFields({ type: "array" })).toBeNull();
    expect(
      eventArgumentFields({ type: "object", properties: { filter: { type: "object" } } }),
    ).toBeNull();
    expect(
      eventArgumentFields({ type: "object", properties: { tags: { type: "array" } } }),
    ).toBeNull();
  });

  test("labels read as words", () => {
    expect(eventArgumentLabel("projectId")).toBe("Project id");
    expect(eventArgumentLabel("max_items")).toBe("Max items");
  });

  test("editing one argument keeps the others, and removing the last empties the text", () => {
    const text = withEventArgument('{ "keep": 1 }', "projectId", "p-1");
    expect(eventArgumentsValue(text)).toEqual({ keep: 1, projectId: "p-1" });
    expect(withEventArgument(withEventArgument("", "a", 1), "a", undefined)).toBe("");
    expect(eventArgumentsValue("[1]")).toBeNull();
    expect(eventArgumentsValue("not json")).toBeNull();
    expect(eventArgumentsValue("")).toEqual({});
  });

  test("a newly picked event keeps what fits and fills in the host's defaults", () => {
    const next = eventArgumentsForEvent(schema, '{ "status": "open", "other": true }', {
      projectId: "p-9",
      unrelated: "x",
    });
    expect(eventArgumentsValue(next)).toEqual({ status: "open", projectId: "p-9" });
    expect(
      eventArgumentsForEvent(schema, '{ "projectId": "mine" }', { projectId: "p-9" }),
    ).toContain('"mine"');
    expect(eventArgumentsForEvent(undefined, "not json", { projectId: "p-9" })).toBe("not json");
    expect(eventArgumentsForEvent(schema, "", undefined)).toBe("");
  });
});

describe("sessionAutomationWaitWords", () => {
  const at = { now: NOW, timeZone: "UTC" };

  test("a chat no automation will post into waits for nothing", () => {
    expect(sessionAutomationWaitWords(t, {}, at)).toBeNull();
    expect(
      sessionAutomationWaitWords(
        t,
        { hasSchedules: true, hasUpcomingSchedules: false, waitingForEvents: false },
        at,
      ),
    ).toBeNull();
  });

  test("without the details the plain wait is named", () => {
    expect(sessionAutomationWaitWords(t, { waitingForEvents: true }, at)).toEqual({
      kind: "event",
      label: "Waiting for an event",
      short: "Waiting on an event",
    });
    expect(
      sessionAutomationWaitWords(t, { hasUpcomingSchedules: true, automationWait: null }, at),
    ).toEqual({ kind: "schedule", label: "On a schedule", short: "On a schedule" });
  });

  test("a server naming only the first event leaves the rest to a count", () => {
    expect(
      sessionAutomationWaitWords(
        t,
        {
          waitingForEvents: true,
          hasUpcomingSchedules: true,
          automationWait: {
            nextRunAt: "2026-10-22T09:00:00.000Z",
            event: {
              source: { kind: "mcp", name: "Deploys" },
              eventTypes: ["deploy.finished", "deploy.failed"],
            },
            automations: 2,
          },
        },
        at,
      ),
    ).toEqual({
      kind: "event",
      label:
        "Waiting for deploy.finished or deploy.failed from Deploys. Next run: Tomorrow, 09:00. 1 more automation is waiting too.",
      short: "Waiting on Deploys",
    });
  });

  test("every source the chat's automations wait on is named, then the next run", () => {
    const deploys = {
      source: { kind: "mcp" as const, name: "Deploys" },
      eventTypes: ["deploy.finished", "deploy.failed"],
    };
    const mail = { source: { kind: "gmail" as const, name: "Gmail" }, eventTypes: ["*"] };
    expect(
      sessionAutomationWaitWords(
        t,
        {
          waitingForEvents: true,
          hasUpcomingSchedules: true,
          automationWait: {
            nextRunAt: "2026-10-22T09:00:00.000Z",
            event: deploys,
            events: [deploys, mail],
            automations: 3,
          },
        },
        at,
      ),
    ).toEqual({
      kind: "event",
      label:
        "Waiting for deploy.finished or deploy.failed from Deploys or every event from Gmail. Next run: Tomorrow, 09:00",
      short: "Waiting on Deploys and Gmail",
    });
    const github = { source: { kind: "github" as const, name: "Acme" }, eventTypes: ["push"] };
    const hidden = { source: null, eventTypes: ["message.received"] };
    expect(
      sessionAutomationWaitWords(
        t,
        {
          waitingForEvents: true,
          automationWait: {
            nextRunAt: null,
            event: deploys,
            events: [deploys, mail, github, hidden],
            automations: 4,
          },
        },
        at,
      ),
    ).toEqual({
      kind: "event",
      label:
        "Waiting for deploy.finished or deploy.failed from Deploys, every event from Gmail, push from Acme, or message.received from a source you can't see",
      short: "Waiting on Deploys, Gmail, and 2 more",
    });
  });

  test("a schedule names its next run in the viewer's time zone", () => {
    expect(
      sessionAutomationWaitWords(
        t,
        {
          hasUpcomingSchedules: true,
          automationWait: {
            nextRunAt: "2026-10-21T14:00:00.000Z",
            event: null,
            events: [],
            automations: 3,
          },
        },
        { now: NOW, timeZone: "Europe/Oslo" },
      ),
    ).toEqual({
      kind: "schedule",
      label: "Next run: Today, 16:00",
      short: "Next: Today, 16:00",
    });
  });

  test("a source the viewer can't see stays unnamed", () => {
    expect(
      sessionAutomationWaitWords(
        t,
        {
          waitingForEvents: true,
          automationWait: {
            nextRunAt: null,
            event: { source: null, eventTypes: ["*"] },
            automations: 1,
          },
        },
        at,
      ),
    ).toEqual({
      kind: "event",
      label: "Waiting for every event from a source you can't see",
      short: "Waiting on an event",
    });
  });
});
