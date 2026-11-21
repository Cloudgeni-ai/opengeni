import { expect, test } from "bun:test";

import {
  AGENT_TRIGGER_EVENT_MESSAGE,
  AGENT_TRIGGER_SCHEDULE_MESSAGE,
  AGENT_TRIGGER_SHARED_DENIED,
  agentTriggerCreateRequest,
  agentTriggerDraft,
  agentTriggerDraftOfKind,
  agentTriggerIssues,
  agentTriggerMissingSource,
  agentTriggerSaveError,
  agentTriggerWithSources,
} from "../src/app/components/agents/agent-trigger-model";
import { createOpenGeniText } from "../src/messages";
import type { AgentTemplateTrigger, EventSource } from "@opengeni/sdk";

const t = createOpenGeniText();
const NOW = new Date("2026-11-21T10:00:00.000Z");
const AGENT = { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", name: "Bug fixer" };
const SUGGESTION: AgentTemplateTrigger = {
  name: "When an issue is labelled bug",
  instructions: "An issue was labelled as a bug. Fix it.",
  schedule: null,
  triggers: [
    {
      source: { kind: "github" },
      eventTypes: ["issues.labeled"],
      conditions: [{ field: "data.label", op: "equals", value: "bug" }],
    },
  ] as AgentTemplateTrigger["triggers"],
};
const GITHUB = {
  id: "source-gh",
  name: "Acme GitHub",
  kind: "github",
  status: "active",
  adapter: null,
  mcp: null,
} as unknown as EventSource;

test("a suggestion starts with its events, conditions and message on the person's source", () => {
  const draft = agentTriggerDraft(SUGGESTION, { eventTriggers: true, sources: [GITHUB] });
  expect(draft.instructions).toBe(SUGGESTION.instructions);
  expect(draft.cadence).toBeNull();
  expect(draft.events.triggers).toEqual([
    expect.objectContaining({ sourceId: "source-gh", eventTypes: ["issues.labeled"] }),
  ]);
  expect(draft.events.triggers[0]!.conditions).toHaveLength(1);
  expect(agentTriggerMissingSource(draft, [GITHUB])).toBeUndefined();
  // Without a GitHub source it asks for one.
  const waiting = agentTriggerDraft(SUGGESTION, { eventTriggers: true, sources: [] });
  expect(agentTriggerMissingSource(waiting, [])).toEqual({ kind: "github" });
});

test("a blank trigger starts on one event, or on the default schedule where events don't run", () => {
  const event = agentTriggerDraft(undefined, { eventTriggers: true, sources: [GITHUB] });
  expect(event.cadence).toBeNull();
  expect(event.events.triggers.map((trigger) => trigger.sourceId)).toEqual(["source-gh"]);
  const schedule = agentTriggerDraft(undefined, { eventTriggers: false, timeZone: "UTC" });
  expect(schedule.events.triggers).toEqual([]);
  expect(schedule.cadence?.rule.frequency).toBe("weekdays");
  // Switching keeps only what the new kind uses.
  const switched = agentTriggerDraftOfKind("schedule", event, [GITHUB], "UTC");
  expect(switched.events.triggers).toEqual([]);
  expect(switched.cadence).not.toBeNull();
  expect(agentTriggerDraftOfKind("event", switched, [GITHUB]).cadence).toBeNull();
  // Opened before sources load, a blank event takes the only source once they do.
  const early = agentTriggerDraft(undefined, { eventTriggers: true });
  expect(early.events.triggers[0]!.sourceId).toBe("");
  const filled = agentTriggerWithSources(early.events, [GITHUB]);
  expect(filled.triggers[0]!.sourceId).toBe("source-gh");
  expect(agentTriggerWithSources(filled, [GITHUB])).toBe(filled);
});

test("it needs a schedule or an event, never a message", () => {
  const blank = agentTriggerDraft(undefined, { eventTriggers: true, sources: [] });
  const none = { ...blank, events: { ...blank.events, triggers: [] } };
  expect(agentTriggerIssues(t, none, [], NOW).when).toBe("Choose when it starts.");
  const schedule = agentTriggerDraft(undefined, { eventTriggers: false, timeZone: "UTC" });
  expect(agentTriggerIssues(t, schedule, [], NOW)).toEqual({});
});

test("it saves as a new chat with the agent each run, shared like the agent", () => {
  const draft = agentTriggerDraft(SUGGESTION, { eventTriggers: true, sources: [GITHUB] });
  const repository = {
    kind: "repository" as const,
    uri: "https://github.com/acme/app.git",
    ref: "main",
    provider: "github" as const,
    mountPath: "/workspace/repos/github.com/acme/app",
  };
  const shared = agentTriggerCreateRequest(t, {
    agent: { ...AGENT, visibility: "workspace" },
    suggestion: SUGGESTION,
    draft,
    resources: [repository],
    sources: [GITHUB],
    now: NOW,
  }) as Record<string, any>;
  expect(shared.name).toBe("Bug fixer: When an issue is labelled bug");
  expect(shared.visibility).toBe("workspace");
  expect(shared.runMode).toBe("new_session_per_run");
  expect(shared.agentConfig.agentId).toBe(AGENT.id);
  expect(shared.agentConfig.prompt).toBe(SUGGESTION.instructions);
  expect(shared.agentConfig.resources).toEqual([repository]);
  expect(shared.events.triggers[0].conditions).toEqual([
    { field: "data.label", op: "equals", value: "bug" },
  ]);
  // An organization agent's trigger is shared with the workspace too; an Only me agent's is Only me.
  const organization = agentTriggerCreateRequest(t, {
    agent: { ...AGENT, visibility: "organization" },
    draft: { ...draft, instructions: "  " },
    sources: [GITHUB],
    now: NOW,
  }) as Record<string, any>;
  expect(organization.visibility).toBe("workspace");
  expect(organization.agentConfig.prompt).toBe(AGENT_TRIGGER_EVENT_MESSAGE);
  expect(organization.name).toStartWith("Bug fixer: ");
  const schedule = agentTriggerDraft(undefined, { eventTriggers: false, timeZone: "UTC" });
  const personal = agentTriggerCreateRequest(t, {
    agent: { ...AGENT, visibility: "private" },
    draft: schedule,
    sources: [],
    now: NOW,
  }) as Record<string, any>;
  expect(personal.visibility).toBe("private");
  expect(personal.agentConfig.prompt).toBe(AGENT_TRIGGER_SCHEDULE_MESSAGE);
  expect(personal.schedule.type).toBe("calendar");
});

test("a refused shared trigger says who can add one", () => {
  const forbidden = Object.assign(new Error("Opengeni API 403: missing permission"), {
    status: 403,
  });
  expect(agentTriggerSaveError(forbidden, "workspace")).toBe(AGENT_TRIGGER_SHARED_DENIED);
  expect(agentTriggerSaveError(forbidden, "private")).not.toBe(AGENT_TRIGGER_SHARED_DENIED);
});
