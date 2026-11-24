import { expect, test } from "bun:test";

import {
  AGENT_TRIGGER_EVENT_MESSAGE,
  AGENT_TRIGGER_SCHEDULE_MESSAGE,
  AGENT_TRIGGER_SHARED_DENIED,
  agentTriggerChatWords,
  agentTriggerCreateRequest,
  agentTriggerDraftForPick,
  agentTriggerDraftFromSuggestion,
  agentTriggerIssues,
  agentTriggerMissingSource,
  agentTriggerOptions,
  agentTriggerPickKey,
  agentTriggerAwaitsSecret,
  agentTriggerSecretIssue,
  agentTriggerSourceStep,
  agentTriggerSaveError,
  agentTriggerWithSources,
  agentTriggerRepositoryEvents,
  addAgentSuggestedTrigger,
  agentTriggerOffers,
  agentUsesGitHub,
  availableCommonTriggers,
  AGENT_TRIGGER_OFFERS_MAX,
} from "../src/app/components/agents/agent-trigger-model";
import {
  eventConditionFromDraft,
  newEventTriggerDraft,
} from "../src/components/automations/event-trigger-model";
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
  // A suggested app webhook is added on the Add a source page too.
  expect(
    agentTriggerSourceStep({ kind: "webhook", adapter: "custom", preset: "linear" } as never, {
      githubConnected: true,
    }),
  ).toBe("add_source");
});

const MENTIONED: AgentTemplateTrigger = {
  name: "Review when mentioned on a PR",
  instructions: "Someone mentioned you on this pull request. Review it.",
  schedule: null,
  oneClick: true,
  triggers: [
    {
      source: { kind: "github" },
      eventTypes: ["issue_comment.created"],
      conditions: [
        { field: "data.issue.pull_request", op: "equals", value: true },
        { field: "data.comment.mentions_app", op: "equals", value: true },
        {
          field: "data.comment.author_association",
          op: "in",
          value: ["OWNER", "MEMBER", "COLLABORATOR"],
        },
      ],
    },
    {
      source: { kind: "github" },
      eventTypes: ["pull_request_review_comment.created"],
      conditions: [{ field: "data.comment.mentions_app", op: "equals", value: true }],
    },
  ] as AgentTemplateTrigger["triggers"],
};

function oneClickClient(sources: EventSource[]) {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async listEventSources() {
      return sources;
    },
    async createEventSource(_workspaceId: string, request: unknown) {
      calls.push(["createEventSource", request]);
      return { source: { ...GITHUB, id: "source-new" } as EventSource };
    },
    async createScheduledTask(_workspaceId: string, request: any) {
      calls.push(["createScheduledTask", request]);
      return { id: "task-1", name: request.name } as any;
    },
  };
}

test("a one-click suggestion is added as it is, on the person's GitHub source", async () => {
  const client = oneClickClient([GITHUB]);
  const outcome = await addAgentSuggestedTrigger(t, {
    client,
    workspaceId: "ws",
    agent: { ...AGENT, visibility: "workspace" },
    suggestion: MENTIONED,
    githubConnected: true,
    now: NOW,
  });
  expect(outcome.kind).toBe("created");
  expect(client.calls.map(([name]) => name)).toEqual(["createScheduledTask"]);
  const request = client.calls[0]![1] as any;
  expect(request.name).toBe("Bug fixer: Review when mentioned on a PR");
  expect(request.visibility).toBe("workspace");
  expect(request.agentConfig.agentId).toBe(AGENT.id);
  expect(request.agentConfig.prompt).toBe(MENTIONED.instructions);
  const triggers = request.events.triggers;
  expect(triggers.map((entry: any) => [entry.sourceId, entry.eventTypes])).toEqual([
    ["source-gh", ["issue_comment.created"]],
    ["source-gh", ["pull_request_review_comment.created"]],
  ]);
  expect(triggers[0].conditions).toContainEqual({
    field: "data.comment.author_association",
    op: "in",
    value: ["OWNER", "MEMBER", "COLLABORATOR"],
  });
});

test("a one-click suggestion adds the GitHub source it lacks, or asks to set up", async () => {
  const client = oneClickClient([]);
  const added = await addAgentSuggestedTrigger(t, {
    client,
    workspaceId: "ws",
    agent: { ...AGENT, visibility: "workspace" },
    suggestion: MENTIONED,
    githubConnected: true,
    now: NOW,
  });
  expect(added.kind).toBe("created");
  expect(client.calls.map(([name]) => name)).toEqual(["createEventSource", "createScheduledTask"]);
  expect(
    (client.calls[1]![1] as any).events.triggers.every(
      (entry: any) => entry.sourceId === "source-new",
    ),
  ).toBe(true);

  const unconnected = oneClickClient([]);
  const waiting = await addAgentSuggestedTrigger(t, {
    client: unconnected,
    workspaceId: "ws",
    agent: { ...AGENT, visibility: "workspace" },
    suggestion: MENTIONED,
    githubConnected: false,
    now: NOW,
  });
  expect(waiting.kind).toBe("needs_setup");
  expect(unconnected.calls).toEqual([]);
});

test("a pasted webhook waiting for its secret can be picked, and a short secret is refused", () => {
  const linear = {
    id: "source-linear",
    name: "Linear",
    kind: "webhook",
    adapter: "custom",
    format: { preset: "linear", signature: { scheme: "hmac_sha256" } },
    status: "blocked",
    statusReason: "Paste the signing secret Linear shows for this webhook.",
    statusReasonCode: "awaiting_secret",
    awaitingSigningSecret: true,
    mcp: null,
  } as unknown as EventSource;
  expect(agentTriggerAwaitsSecret(linear)).toBe(true);
  expect(agentTriggerAwaitsSecret({ ...linear, awaitingSigningSecret: false })).toBe(false);
  expect(agentTriggerAwaitsSecret(GITHUB)).toBe(false);
  expect(agentTriggerAwaitsSecret(undefined)).toBe(false);
  const option = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [linear],
    eventTriggers: true,
    githubConnected: true,
  }).find((entry) => entry.key === "source:source-linear");
  expect(option?.unavailable).toBeUndefined();
  // Any other blocked webhook still can't be picked.
  const other = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [{ ...linear, awaitingSigningSecret: false } as EventSource],
    eventTriggers: true,
    githubConnected: true,
  }).find((entry) => entry.key === "source:source-linear");
  expect(other?.unavailable).toBeDefined();
  const setup = { app: "Linear", secretName: "signing secret" };
  expect(agentTriggerSecretIssue("  short  ", setup)).toBe(
    "Paste the signing secret Linear shows.",
  );
  expect(agentTriggerSecretIssue("lin_wh_0123456789", setup)).toBeUndefined();
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
  expect(setupOf("new:linear")).toBe("create_pasted");
  expect(setupOf("new:sentry")).toBe("create_pasted");
  expect(setupOf("new:tailscale")).toBe("create_pasted");
  expect(setupOf("new:mcp")).toBe("add_source");
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

test("a paused or blocked source stands for its kind, unavailable, with why", () => {
  const paused = {
    ...GITHUB,
    status: "disabled",
    statusReason: null,
    statusReasonCode: "turned_off",
  } as unknown as EventSource;
  const options = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [paused],
    eventTriggers: true,
    githubConnected: true,
  });
  const tile = options.find((option) => option.key === "source:source-gh");
  expect(tile?.unavailable).toBe("Turned off.");
  // Its kind isn't offered again as new.
  expect(options.map((option) => option.key)).not.toContain("new:github");
  // An active source comes first and can be picked.
  const active = { ...GITHUB, id: "source-gh-2", name: "Other GitHub" } as EventSource;
  const both = agentTriggerOptions(t, {
    choices: eventSourceChoices(t),
    sources: [paused, active],
    eventTriggers: true,
    githubConnected: true,
  });
  expect(both.slice(1, 3).map((option) => [option.key, option.unavailable])).toEqual([
    ["source:source-gh-2", undefined],
    ["source:source-gh", "Turned off."],
  ]);
  // Blocked without a known code shows the server's sentence.
  const blocked = {
    ...paused,
    status: "blocked",
    statusReasonCode: null,
    statusReason: "Sign in again.",
  } as unknown as EventSource;
  expect(
    agentTriggerOptions(t, {
      choices: eventSourceChoices(t),
      sources: [blocked],
      eventTriggers: true,
      githubConnected: true,
    }).find((option) => option.key === "source:source-gh")?.unavailable,
  ).toBe("Sign in again.");
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

test("a trigger's runs can keep one chat or continue one of the agent's chats", () => {
  const draft = agentTriggerDraftFromSuggestion(SUGGESTION, { sources: [GITHUB] });
  const agent = { ...AGENT, visibility: "workspace" as const };
  const base = { agent, draft, sources: [GITHUB], now: NOW };
  const reusable = agentTriggerCreateRequest(t, {
    ...base,
    chat: { mode: "reusable_session" },
  }) as Record<string, any>;
  expect(reusable.runMode).toBe("reusable_session");
  expect(reusable.targetSessionId).toBeUndefined();
  expect(reusable.agentConfig.agentId).toBe(AGENT.id);
  const existing = agentTriggerCreateRequest(t, {
    ...base,
    chat: { mode: "existing_session", sessionId: "chat-1" },
  }) as Record<string, any>;
  expect(existing.runMode).toBe("existing_session");
  expect(existing.targetSessionId).toBe("chat-1");
  expect(agentTriggerChatWords(AGENT, { mode: "reusable_session" })).toBe(
    "Each run continues one chat with Bug fixer",
  );
});

test("a refused shared trigger says who can add one", () => {
  const forbidden = Object.assign(new Error("Opengeni API 403: missing permission"), {
    status: 403,
  });
  expect(agentTriggerSaveError(forbidden, "workspace")).toBe(AGENT_TRIGGER_SHARED_DENIED);
  expect(agentTriggerSaveError(forbidden, "private")).not.toBe(AGENT_TRIGGER_SHARED_DENIED);
});

test("chosen repositories narrow only GitHub triggers; none chosen covers every repository", () => {
  const github = { ...newEventTriggerDraft("github-source"), eventTypes: ["pull_request.opened"] };
  const slack = { ...newEventTriggerDraft("slack-source"), eventTypes: ["message"] };
  const events = { triggers: [github, slack], once: false, maxRunsPerHour: 20 };
  const isGitHub = (trigger: { sourceId: string }) => trigger.sourceId === "github-source";

  expect(agentTriggerRepositoryEvents(events, isGitHub, [])).toBe(events);

  const one = agentTriggerRepositoryEvents(events, isGitHub, ["acme/api"]);
  expect(one.triggers[0]!.conditions.map(eventConditionFromDraft)).toEqual([
    { field: "data.repository.full_name", op: "equals", value: "acme/api" },
  ]);
  expect(one.triggers[1]!.conditions).toEqual([]);

  const several = agentTriggerRepositoryEvents(one, isGitHub, ["acme/api", "acme/web", "acme/api"]);
  expect(several.triggers[0]!.conditions.map(eventConditionFromDraft)).toEqual([
    { field: "data.repository.full_name", op: "in", value: ["acme/api", "acme/web"] },
  ]);
});

test("common triggers need GitHub unless its connection is off or the agent blocks it", () => {
  expect(agentUsesGitHub([], null)).toBe(true);
  expect(agentUsesGitHub([], false)).toBe(false);
  expect(
    agentUsesGitHub(
      [{ connector: "github.com", tool: "merge_pull_request", permission: "ask" }],
      true,
    ),
  ).toBe(true);
  expect(agentUsesGitHub([{ connector: "GitHub.com", permission: "block" }], true)).toBe(false);
  expect(availableCommonTriggers({ usesGitHub: false }).map((entry) => entry.key)).toEqual([
    "weekday_morning",
  ]);
});

test("offers put the agent's own suggestions first, skip what they cover or what is set up, and stop at three", () => {
  const mention: AgentTemplateTrigger = {
    name: "Review when mentioned on a PR",
    instructions: "Review it.",
    schedule: null,
    oneClick: true,
    triggers: availableCommonTriggers({ usesGitHub: true }).find(
      (entry) => entry.key === "mentioned_on_pull_request",
    )!.trigger.triggers,
  };
  const offers = agentTriggerOffers({
    templateSuggestions: [mention],
    usesGitHub: true,
    taskNames: [],
  });
  expect(offers.map((offer) => offer.suggestion.name)).toEqual([
    "Review when mentioned on a PR",
    "When a pull request opens",
    "Every weekday morning",
  ]);
  expect(offers[0]!.templateIndex).toBe(0);
  expect(offers[1]!.common).toBe("pull_request_opened");
  // A trigger already added under its name isn't offered again.
  expect(
    agentTriggerOffers({
      templateSuggestions: [SUGGESTION, mention],
      usesGitHub: true,
      taskNames: ["Bug fixer: Review when mentioned on a PR"],
    }).map((offer) => offer.suggestion.name),
  ).toEqual([
    "When an issue is labelled bug",
    "When a pull request opens",
    "Every weekday morning",
  ]);
  expect(
    agentTriggerOffers({ templateSuggestions: [], usesGitHub: true, taskNames: null }),
  ).toHaveLength(AGENT_TRIGGER_OFFERS_MAX);
});
