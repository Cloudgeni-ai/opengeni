import { describe, expect, test } from "bun:test";

import type { ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";

import {
  AUTOMATION_NAME_MAX_LENGTH,
  automationCadence,
  automationCreateRequest,
  automationDraftFrom,
  automationName,
  automationNextRun,
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
      overlapPolicy: "buffer_one",
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
