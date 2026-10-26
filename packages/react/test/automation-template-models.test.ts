import { describe, expect, test } from "bun:test";

import type { EventSource, ScheduledTask, WorkspaceAutomationTemplate } from "@opengeni/sdk";

import {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  automationDraftFromTemplate,
  automationTemplateCadence,
  automationTemplateFromTask,
  automationTemplateOfSaved,
  automationTemplateSchedule,
  automationTemplateSourceId,
  automationTemplatesFor,
  automationTemplateWhenWords,
  builtinAutomationTemplates,
  eventSourceChoiceName,
  eventSourceChoiceOf,
  withTemplateSources,
  type AutomationTemplate,
} from "../src/automations";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();
const NOW = new Date("2026-10-25T12:00:00.000Z");
const WORKSPACE_ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";

function source(overrides: Partial<EventSource>): EventSource {
  return {
    id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
    workspaceId: WORKSPACE_ID,
    kind: "github",
    adapter: null,
    format: null,
    name: "Acme GitHub",
    ownerSubjectId: null,
    visibility: "workspace",
    status: "active",
    statusReason: null,
    statusReasonCode: null,
    statusReasonDetail: null,
    webhookUrl: null,
    awaitingSigningSecret: false,
    mcp: null,
    lastDeliveryAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const builtin = builtinAutomationTemplates(t);
const byId = (id: string) => builtin.find((template) => template.id === id)!;

describe("built-in templates", () => {
  test("Meeting notes listens for a meeting's transcript on this workspace's events", () => {
    const notes = byId("meeting-notes");
    expect(notes.name).toBe("Meeting notes");
    expect(notes.schedule).toBeNull();
    expect(notes.triggers).toEqual([
      {
        source: { kind: "workspace" },
        eventTypes: ["recording.transcript.ready"],
        // Only meetings the person recorded: not voice notes, other recordings or
        // a teammate's shared meeting, which their own automation writes up.
        conditions: [
          { field: "data.purpose", op: "equals", value: "meeting" },
          { field: "data.recordedByYou", op: "equals", value: true },
        ],
      },
    ]);
    expect(notes.instructions).toContain("data.recordingId");
    expect(automationTemplateWhenWords(t, notes, NOW)).toBe("When a meeting's transcript is ready");
  });

  test("every built-in template has distinct words and fits the API's limits", () => {
    expect(new Set(builtin.map((template) => template.id)).size).toBe(builtin.length);
    for (const template of builtin) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.name.length).toBeLessThanOrEqual(120);
      expect(template.description.length).toBeLessThanOrEqual(500);
      expect(template.instructions.length).toBeGreaterThan(40);
    }
  });

  test("a place offers event templates only where events run, and workspace ones where offered", () => {
    const ids = (templates: AutomationTemplate[]) => templates.map((template) => template.id);
    expect(ids(automationTemplatesFor(builtin, { eventTriggers: false }))).toEqual([
      "morning-brief",
      "dependency-pr",
      "cost-check",
    ]);
    expect(ids(automationTemplatesFor(builtin, { eventTriggers: true }))).not.toContain(
      "meeting-notes",
    );
    expect(
      ids(automationTemplatesFor(builtin, { eventTriggers: true, workspaceEvents: true })),
    ).toContain("meeting-notes");
  });

  test("a scheduled template's card says when it runs", () => {
    expect(automationTemplateWhenWords(t, byId("dependency-pr"), NOW)).toBe(
      "Every week on Mon at 09:30",
    );
  });
});

describe("template schedules", () => {
  test("a calendar schedule comes back the same through the person's time zone", () => {
    const schedule = {
      type: "calendar" as const,
      hour: 8,
      minute: 0,
      daysOfWeek: ["MONDAY" as const],
    };
    const cadence = automationTemplateCadence(schedule, "Europe/Oslo");
    expect(cadence.timeZone).toBe("Europe/Oslo");
    expect(automationTemplateSchedule(cadence, NOW)).toEqual(schedule);
  });

  test("an interval keeps its length, and a one-time run keeps nothing", () => {
    const every = { type: "interval" as const, everySeconds: 3600 };
    expect(automationTemplateSchedule(automationTemplateCadence(every, "UTC"), NOW)).toEqual(every);
    expect(automationTemplateSchedule(null, NOW)).toBeNull();
    expect(
      automationTemplateSchedule(
        { timeZone: "UTC", rule: { frequency: "once", date: "2026-11-01", time: "09:00" } },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("template sources", () => {
  const github = source({ id: "a1000000-0000-4000-8000-000000000001" });
  const sharedGithub = source({ id: "a1000000-0000-4000-8000-000000000002", name: "Org" });
  const linear = source({
    id: "a1000000-0000-4000-8000-000000000003",
    kind: "webhook",
    adapter: "custom",
    format: { preset: "linear" } as EventSource["format"],
    name: "Linear",
  });

  test("a trigger takes the named source when the person can use it, else the first of its kind", () => {
    expect(automationTemplateSourceId({ kind: "github" }, [linear, github, sharedGithub])).toBe(
      github.id,
    );
    expect(
      automationTemplateSourceId({ kind: "github", sourceId: sharedGithub.id }, [
        github,
        sharedGithub,
      ]),
    ).toBe(sharedGithub.id);
    expect(
      automationTemplateSourceId({ kind: "webhook", adapter: "custom", preset: "linear" }, [
        github,
        linear,
      ]),
    ).toBe(linear.id);
    // A template saved before presets names Linear by its older adapter.
    expect(
      automationTemplateSourceId({ kind: "webhook", adapter: "linear" }, [github, linear]),
    ).toBe(linear.id);
    // Any other custom webhook is not Linear's.
    expect(
      automationTemplateSourceId({ kind: "webhook", adapter: "custom", preset: "linear" }, [
        { ...linear, format: { preset: "tailscale" } as EventSource["format"] },
      ]),
    ).toBe("");
    expect(
      automationTemplateSourceId({ kind: "github" }, [{ ...github, status: "disabled" }]),
    ).toBe("");
  });

  test("a template's draft waits for sources, then fills its triggers once", () => {
    const draft = automationDraftFromTemplate(byId("pr-review"), { timeZone: "UTC" });
    expect(draft.name).toBe("Review new pull requests");
    expect(draft.cadence).toBeNull();
    expect(draft.events.maxRunsPerHour).toBe(DEFAULT_EVENT_RUNS_PER_HOUR);
    const [trigger] = draft.events.triggers;
    expect(trigger?.sourceId).toBe("");
    expect(trigger?.templateSource).toEqual({ kind: "github" });
    expect(trigger?.eventTypes).toEqual(["pull_request.opened", "pull_request.ready_for_review"]);
    expect(withTemplateSources(draft.events, undefined)).toBe(draft.events);
    expect(withTemplateSources(draft.events, [linear])).toBe(draft.events);
    const filled = withTemplateSources(draft.events, [linear, github]);
    expect(filled.triggers[0]?.sourceId).toBe(github.id);
    expect(withTemplateSources(filled, [sharedGithub])).toBe(filled);
  });

  test("a saved template keeps the kind of each source and names only shared ones", () => {
    const mine = source({
      id: "a1000000-0000-4000-8000-000000000004",
      kind: "gmail",
      visibility: "private",
      ownerSubjectId: "viewer",
    });
    const task = {
      name: "Weekly triage",
      schedule: {
        type: "calendar",
        hour: 9,
        minute: 0,
        daysOfWeek: ["FRIDAY"],
        timeZone: "Europe/Oslo",
      },
      agentConfig: { prompt: "Triage what came in this week." },
      events: {
        maxRunsPerHour: 10,
        once: false,
        triggers: [
          {
            id: "t1",
            sourceId: sharedGithub.id,
            sourceKind: "github",
            eventTypes: ["issues.opened"],
            conditions: [{ field: "data.repository", op: "equals", value: "acme/api" }],
            includeOwnEvents: false,
            arguments: null,
          },
          {
            id: "t2",
            sourceId: mine.id,
            sourceKind: "gmail",
            eventTypes: ["message.received"],
            conditions: [],
            includeOwnEvents: true,
            arguments: null,
          },
          {
            // Someone else's webhook: its kind of sender can't be told.
            id: "t3",
            sourceId: "a1000000-0000-4000-8000-0000000000ff",
            sourceKind: "webhook",
            eventTypes: ["thing.happened"],
            conditions: [],
            includeOwnEvents: false,
            arguments: null,
          },
        ],
      },
    } as unknown as Pick<ScheduledTask, "name" | "schedule" | "events" | "agentConfig">;
    const request = automationTemplateFromTask(t, task, [sharedGithub, mine], {
      name: "  ",
      description: " Friday triage. ",
      now: NOW,
    });
    expect(request).toEqual({
      name: "Weekly triage",
      description: "Friday triage.",
      instructions: "Triage what came in this week.",
      schedule: { type: "calendar", hour: 9, minute: 0, daysOfWeek: ["FRIDAY"] },
      triggers: [
        {
          source: { kind: "github", sourceId: sharedGithub.id },
          eventTypes: ["issues.opened"],
          conditions: [{ field: "data.repository", op: "equals", value: "acme/api" }],
          includeOwnEvents: false,
        },
        {
          // Private to its owner: the next person uses their own mailbox.
          source: { kind: "gmail" },
          eventTypes: ["message.received"],
          conditions: [],
          includeOwnEvents: true,
        },
      ],
      maxRunsPerHour: 10,
    });
  });

  test("a saved template reads back as one to start from", () => {
    const saved: WorkspaceAutomationTemplate = {
      id: "b2000000-0000-4000-8000-000000000001",
      workspaceId: WORKSPACE_ID,
      name: "Standup notes",
      description: "",
      instructions: "Write the standup notes.",
      schedule: null,
      triggers: [
        {
          source: { kind: "workspace" },
          eventTypes: ["recording.transcript.ready"],
          conditions: [],
          includeOwnEvents: false,
        },
      ],
      maxRunsPerHour: null,
      createdBySubjectId: "someone",
      viewerAccess: "use",
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    const template = automationTemplateOfSaved(saved);
    const workspace = source({ id: "c3000000-0000-4000-8000-000000000001", kind: "workspace" });
    const draft = automationDraftFromTemplate(template, { sources: [workspace], timeZone: "UTC" });
    expect(draft.instructions).toBe("Write the standup notes.");
    expect(draft.events.triggers[0]?.sourceId).toBe(workspace.id);
    expect(draft.events.maxRunsPerHour).toBe(DEFAULT_EVENT_RUNS_PER_HOUR);
  });
});

describe("source kinds from a newer server", () => {
  test("an unknown kind still has a name and a choice", () => {
    const unknown = source({ kind: "calendar" as never });
    expect(eventSourceChoiceOf(unknown)).toBe("calendar" as never);
    expect(eventSourceChoiceName(t, "calendar" as never)).toBe("calendar");
  });
});
