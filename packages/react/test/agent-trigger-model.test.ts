import { expect, test } from "bun:test";

import {
  AGENT_TRIGGER_EVENT_MESSAGE,
  AGENT_TRIGGER_SCHEDULE_MESSAGE,
  AGENT_TRIGGER_SHARED_DENIED,
  agentTriggerCreateRequest,
  agentTriggerDraftForPick,
  agentTriggerDraftFromSuggestion,
  agentTriggerIssues,
  agentTriggerMissingSource,
  agentTriggerOptions,
  agentTriggerPickKey,
  agentTriggerSourceStep,
  agentTriggerSaveError,
  agentTriggerWithSources,
} from "../src/app/components/agents/agent-trigger-model";
import {
  eventSourceChoices,
  type EventSourceChoice,
} from "../src/components/automations/event-source-model";
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
  const draft = agentTriggerDraftFromSuggestion(SUGGESTION, { sources: [GITHUB] });
  expect(draft.instructions).toBe(SUGGESTION.instructions);
  expect(draft.cadence).toBeNull();
  expect(draft.events.triggers).toEqual([
    expect.objectContaining({ sourceId: "source-gh", eventTypes: ["issues.labeled"] }),
  ]);
  expect(draft.events.triggers[0]!.conditions).toHaveLength(1);
  expect(agentTriggerMissingSource(draft, [GITHUB])).toBeUndefined();
  // Without a GitHub source it asks for one, and takes it once sources load.
  const waiting = agentTriggerDraftFromSuggestion(SUGGESTION, {});
  expect(agentTriggerMissingSource(waiting, [])).toEqual({ kind: "github" });
  const filled = agentTriggerWithSources(waiting.events, [GITHUB]);
  expect(filled.triggers[0]!.sourceId).toBe("source-gh");
  expect(agentTriggerWithSources(filled, [GITHUB])).toBe(filled);
  // GitHub is added here once the workspace has it connected; else connecting comes first.
  expect(agentTriggerSourceStep({ kind: "github" }, { githubConnected: true })).toBe("create");
  expect(agentTriggerSourceStep({ kind: "github" }, { githubConnected: null })).toBe("create");
  expect(agentTriggerSourceStep({ kind: "github" }, { githubConnected: false })).toBe(
    "connect_github",
  );
  expect(
    agentTriggerSourceStep({ kind: "webhook", adapter: "standard" }, { githubConnected: true }),
  ).toBe("add_source");
});

test("the picker offers a schedule, the person's sources and every kind they can still add", () => {
  const options = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [GITHUB],
    eventTriggers: true,
    githubConnected: true,
  });
  const keys = options.map((option) => option.key);
  expect(keys[0]).toBe("schedule");
  expect(keys[1]).toBe("source:source-gh");
  // GitHub is offered once, as the person's source; every other kind of the catalog follows.
  expect(keys).not.toContain("new:github");
  for (const meta of eventSourceChoices(t)) {
    if (meta.choice !== "github") expect(keys).toContain(`new:${meta.choice}`);
  }
  const setupOf = (key: string) => options.find((option) => option.key === key)?.setup;
  expect(setupOf("new:slack")).toBe("create");
  expect(setupOf("new:workspace")).toBe("create");
  expect(setupOf("new:webhook")).toBe("create_webhook");
  expect(setupOf("new:linear")).toBe("add_source");
  expect(setupOf("new:gmail")).toBe("add_source");
  expect(options.find((option) => option.key === "new:webhook")?.label).toBe("Create a webhook");
  // Without GitHub connected, picking GitHub starts with connecting it.
  const unconnected = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [],
    eventTriggers: true,
    githubConnected: false,
  });
  expect(unconnected.find((option) => option.key === "new:github")?.setup).toBe("connect_github");
  // Where events don't run, only a schedule.
  expect(
    agentTriggerOptions(t, {
      choices: eventSourceChoices(t),
      sources: [GITHUB],
      eventTriggers: false,
      githubConnected: true,
    }).map((option) => option.key),
  ).toEqual(["schedule"]);
});

test("a newly registered kind of source shows up in the picker without changes here", () => {
  const jira = "jira" as EventSourceChoice;
  const options = agentTriggerOptions(t, {
    choices: [
      ...eventSourceChoices(t),
      {
        choice: jira,
        name: "Jira",
        description: "Issues from Jira.",
        providerDomain: "atlassian.com",
        setup: "automatic",
        audience: "workspace",
      },
    ],
    // And a source of a kind this client doesn't know yet, from a newer server.
    sources: [
      { ...GITHUB, id: "source-new", kind: "newkind", name: "New kind" } as unknown as EventSource,
    ],
    eventTriggers: true,
    githubConnected: true,
  });
  expect(options.find((option) => option.key === "new:jira")).toEqual(
    expect.objectContaining({ label: "Jira", setup: "add_source" }),
  );
  expect(options.find((option) => option.key === "source:source-new")?.label).toBe("New kind");
});

test("a pick starts the default schedule or one trigger on its source, keeping the note", () => {
  const schedule = agentTriggerDraftForPick({ kind: "schedule" }, { note: "Hi", timeZone: "UTC" });
  expect(schedule.events.triggers).toEqual([]);
  expect(schedule.cadence?.rule.frequency).toBe("weekdays");
  expect(schedule.instructions).toBe("Hi");
  const event = agentTriggerDraftForPick({ kind: "source", sourceId: "source-gh" });
  expect(event.cadence).toBeNull();
  expect(event.events.triggers.map((trigger) => trigger.sourceId)).toEqual(["source-gh"]);
  expect(agentTriggerPickKey({ kind: "new", choice: "webhook" })).toBe("new:webhook");
});

test("it needs a schedule or an event, never a message", () => {
  const none = agentTriggerDraftForPick({ kind: "new", choice: "github" });
  expect(agentTriggerIssues(t, none, [], NOW).when).toBe("Choose when it starts.");
  const schedule = agentTriggerDraftForPick({ kind: "schedule" }, { timeZone: "UTC" });
  expect(agentTriggerIssues(t, schedule, [], NOW)).toEqual({});
});

test("it saves as a new chat with the agent each run, shared like the agent", () => {
  const draft = agentTriggerDraftFromSuggestion(SUGGESTION, { sources: [GITHUB] });
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
  const schedule = agentTriggerDraftForPick({ kind: "schedule" }, { timeZone: "UTC" });
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
