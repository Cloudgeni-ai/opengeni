import { describe, expect, test } from "bun:test";

import type { EventTypeDescriptor, ScheduledTaskEvents } from "@opengeni/sdk";

import {
  DEFAULT_EVENT_RUNS_PER_HOUR,
  EVENT_TRIGGER_TYPES_MAX,
  MAX_EVENT_RUNS_PER_HOUR,
  byteSizeLabel,
  createEventSourceRequest,
  deliveryEventsLabel,
  deliveryTitle,
  emptyEventTriggersDraft,
  eventActorLabel,
  eventConditionFieldSuggestions,
  eventConditionsLabel,
  eventSourceAddLabel,
  eventSourceChoiceOf,
  eventSourceKindLabel,
  eventSourceProviderDomain,
  eventSourceStatusBadge,
  eventStatusReasonText,
  eventSourceSubjectOfChoice,
  eventTriggersDraftFrom,
  eventTriggersInputFrom,
  eventTriggersShortLabel,
  eventTriggerWords,
  eventTypeIssue,
  eventTypesLabel,
  hasEventTriggerIssues,
  isEventSourceChoice,
  newEventConditionDraft,
  newEventTriggerDraft,
  pastedWebhookSetup,
  sameEventTriggers,
  validateEventTriggers,
  type EventTriggersDraft,
} from "../src/automations";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();

const SOURCE_ID = "8f0c2a4e-0d55-4b8e-9d55-1a2b3c4d5e6f";
const MCP_SOURCE_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
const sources = [
  { id: SOURCE_ID, kind: "github" as const, name: "Acme GitHub" },
  { id: MCP_SOURCE_ID, kind: "mcp" as const, name: "Orders" },
];

const savedEvents: ScheduledTaskEvents = {
  triggers: [
    {
      id: "0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b",
      sourceId: SOURCE_ID,
      sourceKind: "github",
      eventTypes: ["pull_request.opened", "pull_request.reopened"],
      conditions: [
        { field: "data.repository", op: "equals", value: "acme/api" },
        { field: "data.draft", op: "equals", value: false },
        { field: "data.labels", op: "in", value: ["bug", "p1"] },
        { field: "data.assignee", op: "exists" },
      ],
      includeOwnEvents: false,
      arguments: null,
      status: "active",
      statusReason: null,
      statusReasonCode: null,
      statusReasonDetail: null,
      createdAt: "2026-10-23T10:00:00.000Z",
      updatedAt: "2026-10-23T10:00:00.000Z",
    },
  ],
  once: true,
  maxRunsPerHour: 12,
} as ScheduledTaskEvents;

function draftWith(edit: (draft: EventTriggersDraft) => void): EventTriggersDraft {
  const draft = eventTriggersDraftFrom(savedEvents);
  edit(draft);
  return draft;
}

describe("event trigger drafts and requests", () => {
  test("a saved automation's events round-trip through the draft unchanged", () => {
    const draft = eventTriggersDraftFrom(savedEvents);
    expect(draft.once).toBe(true);
    expect(draft.maxRunsPerHour).toBe(12);
    expect(draft.triggers[0]?.conditions.map((condition) => condition.value)).toEqual([
      "acme/api",
      "false",
      "bug, p1",
      "",
    ]);
    expect(eventTriggersInputFrom(draft)).toEqual({
      triggers: [
        {
          sourceId: SOURCE_ID,
          eventTypes: ["pull_request.opened", "pull_request.reopened"],
          conditions: [
            { field: "data.repository", op: "equals", value: "acme/api" },
            { field: "data.draft", op: "equals", value: false },
            { field: "data.labels", op: "in", value: ["bug", "p1"] },
            { field: "data.assignee", op: "exists" },
          ],
          includeOwnEvents: false,
        },
      ],
      maxRunsPerHour: 12,
      once: true,
    });
  });

  test("an automation without events starts from the default run policy", () => {
    expect(eventTriggersDraftFrom(null)).toEqual({
      triggers: [],
      once: false,
      maxRunsPerHour: DEFAULT_EVENT_RUNS_PER_HOUR,
    });
  });

  test("MCP subscription settings are edited as JSON and sent only when filled in", () => {
    const trigger = newEventTriggerDraft(MCP_SOURCE_ID);
    trigger.eventTypes = ["order.created"];
    trigger.argumentsText = '{\n  "region": "eu"\n}';
    const filled = eventTriggersInputFrom({ ...emptyEventTriggersDraft(), triggers: [trigger] });
    expect(filled.triggers[0]?.arguments).toEqual({ region: "eu" });
    trigger.argumentsText = "   ";
    const empty = eventTriggersInputFrom({ ...emptyEventTriggersDraft(), triggers: [trigger] });
    expect(empty.triggers[0]).not.toHaveProperty("arguments");
  });

  test("without triggers, run policy edits do not count as a change", () => {
    const left = emptyEventTriggersDraft();
    const right = { ...emptyEventTriggersDraft(), once: true, maxRunsPerHour: 5 };
    expect(sameEventTriggers(left, right)).toBe(true);
    expect(
      sameEventTriggers(
        eventTriggersDraftFrom(savedEvents),
        draftWith(() => undefined),
      ),
    ).toBe(true);
    expect(
      sameEventTriggers(
        eventTriggersDraftFrom(savedEvents),
        draftWith((draft) => {
          draft.maxRunsPerHour = 13;
        }),
      ),
    ).toBe(false);
  });
});

describe("event trigger validation", () => {
  test("a complete draft has no issues", () => {
    const issues = validateEventTriggers(t, eventTriggersDraftFrom(savedEvents), sources);
    expect(hasEventTriggerIssues(issues)).toBe(false);
  });

  test("each trigger says what is missing in the product's words", () => {
    const unpicked = newEventTriggerDraft();
    const gone = newEventTriggerDraft("5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a");
    gone.eventTypes = ["push"];
    const issues = validateEventTriggers(
      t,
      { ...emptyEventTriggersDraft(), triggers: [unpicked, gone] },
      sources,
    );
    expect(issues.triggers[unpicked.key]).toEqual({
      source: "Choose where the events come from.",
      eventTypes: "Pick at least one event.",
    });
    expect(issues.triggers[gone.key]).toEqual({
      source: "This source is gone or you can no longer use it.",
    });
  });

  test("an MCP trigger listens to one event, and others to a bounded list", () => {
    const mcp = newEventTriggerDraft(MCP_SOURCE_ID);
    mcp.eventTypes = ["order.created", "order.paid"];
    const many = newEventTriggerDraft(SOURCE_ID);
    many.eventTypes = Array.from(
      { length: EVENT_TRIGGER_TYPES_MAX + 1 },
      (_, index) => `e${index}`,
    );
    const issues = validateEventTriggers(
      t,
      { ...emptyEventTriggersDraft(), triggers: [mcp, many] },
      sources,
    );
    expect(issues.triggers[mcp.key]?.eventTypes).toContain("listens to one event");
    expect(issues.triggers[many.key]?.eventTypes).toBe(
      `Pick at most ${EVENT_TRIGGER_TYPES_MAX} events.`,
    );
  });

  test("settings must be a JSON object and conditions must be complete", () => {
    const trigger = newEventTriggerDraft(SOURCE_ID);
    trigger.eventTypes = ["push"];
    trigger.argumentsText = "[1, 2]";
    const unnamed = newEventConditionDraft();
    const unknownField = { ...newEventConditionDraft("repository"), value: "acme/api" };
    const noValue = newEventConditionDraft("data.ref");
    const noList = { ...newEventConditionDraft("data.labels"), op: "in" as const };
    const noValueNeeded = { ...newEventConditionDraft("data.assignee"), op: "exists" as const };
    trigger.conditions = [unnamed, unknownField, noValue, noList, noValueNeeded];
    const issues = validateEventTriggers(
      t,
      { ...emptyEventTriggersDraft(), triggers: [trigger] },
      sources,
    ).triggers[trigger.key];
    expect(issues?.arguments).toBe("Write the settings as a JSON object.");
    expect(issues?.conditions).toEqual({
      [unnamed.key]: "Name the field to check.",
      [unknownField.key]:
        "Check type, subject, summary, url, actor.kind, actor.name or a data. field.",
      [noValue.key]: "Enter a value.",
      [noList.key]: "Enter values separated by commas.",
    });
  });

  test("the storm guard takes a whole number of runs within the deployment's range", () => {
    for (const maxRunsPerHour of [0, 1.5, MAX_EVENT_RUNS_PER_HOUR + 1, Number.NaN]) {
      const issues = validateEventTriggers(
        t,
        { ...emptyEventTriggersDraft(), maxRunsPerHour },
        sources,
      );
      expect(issues.maxRunsPerHour).toBe(
        `Enter a whole number from 1 to ${MAX_EVENT_RUNS_PER_HOUR}.`,
      );
    }
    expect(
      validateEventTriggers(t, { ...emptyEventTriggersDraft(), maxRunsPerHour: 1 }, sources)
        .maxRunsPerHour,
    ).toBeUndefined();
  });

  test("event types have no spaces and a bounded length", () => {
    expect(eventTypeIssue(t, "")).toBe("Enter an event type.");
    expect(eventTypeIssue(t, "pull request")).toBe("Event types have no spaces.");
    expect(eventTypeIssue(t, "x".repeat(201))).toBe("That event type is too long.");
    expect(eventTypeIssue(t, "pull_request.*")).toBeNull();
  });
});

describe("event trigger words", () => {
  test("types read as a short phrase with wildcards spelled out", () => {
    expect(eventTypesLabel(t, [])).toBe("No events picked");
    expect(eventTypesLabel(t, ["*"])).toBe("Every event");
    expect(eventTypesLabel(t, ["pull_request.*", "issues.opened"])).toBe(
      "Every pull_request event or issues.opened",
    );
    expect(eventTypesLabel(t, ["a", "b", "c"])).toBe("a and 2 more");
  });

  test("conditions read as one only-when clause", () => {
    expect(eventConditionsLabel(t, [])).toBeNull();
    expect(
      eventConditionsLabel(t, [{ field: "data.labels", op: "in", value: ["bug", "p1"] }]),
    ).toBe("only when data.labels is one of bug, p1");
    expect(eventConditionsLabel(t, [{ field: "data.assignee", op: "not_exists" }])).toBe(
      "only when data.assignee is not set",
    );
    expect(eventConditionsLabel(t, savedEvents.triggers[0]!.conditions)).toBe(
      "only when 4 conditions hold",
    );
  });

  test("a trigger on a source the viewer can't see still reads cleanly", () => {
    const hidden = { sourceId: "hidden", eventTypes: ["push"], conditions: [] };
    expect(eventTriggerWords(t, hidden, sources)).toEqual({
      source: "A source you can't see",
      events: "push",
      conditions: null,
      short: "push from a source you can't see",
    });
    expect(eventTriggersShortLabel(t, [], sources)).toBeNull();
    expect(eventTriggersShortLabel(t, [savedEvents.triggers[0]!, hidden], sources)).toBe(
      "pull_request.opened or pull_request.reopened from Acme GitHub · 1 more",
    );
  });

  test("condition fields suggest the picked types' own fields first, each once", () => {
    const descriptors: EventTypeDescriptor[] = [
      {
        type: "pull_request.opened",
        description: "A pull request was opened",
        fields: [
          { field: "data.repository", description: "owner/name" },
          { field: "subject", description: "The pull request" },
        ],
        argumentsSchema: null,
        available: true,
        unavailableReason: null,
        unavailableReasonCode: null,
        unavailableReasonDetail: null,
      },
      {
        type: "issues.opened",
        description: "An issue was opened",
        fields: [{ field: "data.labels", description: "Labels" }],
        argumentsSchema: null,
        available: true,
        unavailableReason: null,
        unavailableReasonCode: null,
        unavailableReasonDetail: null,
      },
    ];
    const fields = eventConditionFieldSuggestions(t, ["pull_request.opened"], descriptors).map(
      (entry) => entry.field,
    );
    expect(fields).toEqual([
      "data.repository",
      "subject",
      "summary",
      "actor.name",
      "actor.kind",
      "url",
    ]);
  });
});

describe("event sources", () => {
  test("Linear and Sentry are webhooks people pick by app name", () => {
    expect(eventSourceChoiceOf({ kind: "webhook", adapter: "linear" })).toBe("linear");
    expect(eventSourceChoiceOf({ kind: "webhook", adapter: "standard" })).toBe("webhook");
    expect(eventSourceChoiceOf({ kind: "gmail", adapter: null })).toBe("gmail");
    expect(eventSourceKindLabel(t, { kind: "webhook", adapter: "sentry" })).toBe("Sentry webhook");
    expect(eventSourceKindLabel(t, { kind: "webhook", adapter: "standard" })).toBe("Webhook");
    expect(eventSourceKindLabel(t, { kind: "mcp", adapter: null })).toBe("MCP server");
    expect(eventSourceProviderDomain({ kind: "github", adapter: null })).toBe("github.com");
    expect(eventSourceProviderDomain({ kind: "webhook", adapter: "standard" })).toBeNull();
    expect(eventSourceSubjectOfChoice(t, "linear")).toEqual({
      kind: "webhook",
      adapter: "linear",
      name: "Linear",
      mcp: null,
    });
    expect(eventSourceAddLabel(t, "webhook")).toBe("Add a webhook");
    expect(eventSourceAddLabel(t, "github")).toBe("Add GitHub");
    expect(isEventSourceChoice("sentry")).toBe(true);
    expect(isEventSourceChoice("zapier")).toBe(false);
  });

  test("a healthy source shows no badge; a held one says why", () => {
    expect(eventSourceStatusBadge(t, { status: "active", statusReason: null })).toBeNull();
    expect(
      eventSourceStatusBadge(t, { status: "blocked", statusReason: "Paste the secret." }),
    ).toEqual({ status: "needs_you", label: "Needs attention", reason: "Paste the secret." });
    expect(eventSourceStatusBadge(t, { status: "disabled", statusReason: null })?.label).toBe(
      "Off",
    );
  });

  test("a held reason with a known code is worded here, naming the source", () => {
    expect(
      eventSourceStatusBadge(t, {
        status: "blocked",
        statusReason: "Reconnect Orders MCP to keep its events coming",
        statusReasonCode: "reconnect",
        statusReasonDetail: null,
        name: "Orders",
      })?.reason,
    ).toBe("Reconnect Orders to keep its events coming.");
    expect(
      eventStatusReasonText(
        t,
        { text: "server sentence", code: "forbidden", detail: "Only admins may subscribe" },
        "Orders",
      ),
    ).toBe(
      "Orders doesn't let your account receive these events with these settings. It said: Only admins may subscribe",
    );
    expect(
      eventStatusReasonText(t, {
        text: "server sentence",
        code: "github_event_not_subscribed",
        detail: "pull_request",
      }),
    ).toBe(
      "The GitHub App isn't subscribed to \"pull_request\" events. Turn them on in the App's Permissions & events settings.",
    );
    expect(eventStatusReasonText(t, { text: "Turned off", code: "turned_off" })).toBe(
      "Turned off.",
    );
  });

  test("a held reason shows the server's sentence when it can't be worded here", () => {
    // A code from a newer server.
    expect(
      eventStatusReasonText(t, { text: "Orders is moving house", code: "moving_house" }, "Orders"),
    ).toBe("Orders is moving house");
    // An older server, with no code.
    expect(eventStatusReasonText(t, { text: "Paste the secret.", code: null }, "Orders")).toBe(
      "Paste the secret.",
    );
    // A reason that names the source, without a name to put in it.
    expect(eventStatusReasonText(t, { text: "Reconnect Orders MCP", code: "reconnect" })).toBe(
      "Reconnect Orders MCP",
    );
    // A reason that needs its detail, without one.
    expect(
      eventStatusReasonText(
        t,
        { text: "Signs in as someone else", code: "account_changed" },
        "Gmail",
      ),
    ).toBe("Signs in as someone else");
  });

  test("a held reason speaks the host's language", () => {
    const nb = createOpenGeniText({
      locale: "nb",
      productName: "Assistent",
      messages: {
        "automations.statusReason.callbackUnreachable":
          "{source} når ikke webhook-adressen til {product}.",
        "automations.statusReason.withDetail": "{reason} Svar: {detail}",
      },
    });
    expect(
      eventStatusReasonText(
        nb,
        {
          text: "Orders can't reach Opengeni's webhook address (timeout)",
          code: "callback_unreachable",
          detail: "timeout",
        },
        "Orders",
      ),
    ).toBe("Orders når ikke webhook-adressen til Assistent. Svar: timeout");
  });

  test("only pasted Linear and Sentry webhooks explain where the URL and secret go", () => {
    expect(pastedWebhookSetup(t, { kind: "webhook", adapter: "linear" })?.secretName).toBe(
      "signing secret",
    );
    expect(pastedWebhookSetup(t, { kind: "webhook", adapter: "sentry" })?.secretName).toBe(
      "client secret",
    );
    expect(pastedWebhookSetup(t, { kind: "webhook", adapter: "standard" })).toBeNull();
    expect(pastedWebhookSetup(t, { kind: "github", adapter: null })).toBeNull();
  });

  test("each choice becomes the request that adds it", () => {
    expect(
      createEventSourceRequest(t, {
        choice: "linear",
        name: "  ",
        visibility: "workspace",
        signingSecret: " lin_wh_secret ",
      }),
    ).toEqual({
      kind: "webhook",
      adapter: "linear",
      name: "Linear",
      visibility: "workspace",
      signingSecret: "lin_wh_secret",
    });
    expect(
      createEventSourceRequest(t, { choice: "sentry", name: "Errors", visibility: "private" }),
    ).toEqual({ kind: "webhook", adapter: "sentry", name: "Errors", visibility: "private" });
    expect(
      createEventSourceRequest(t, {
        choice: "webhook",
        name: "Deploys",
        visibility: "workspace",
        signingSecret: "ignored",
      }),
    ).toEqual({ kind: "webhook", adapter: "standard", name: "Deploys", visibility: "workspace" });
    expect(
      createEventSourceRequest(t, {
        choice: "mcp",
        name: "",
        visibility: "private",
        mcpServerId: "orders",
        connectionId: "conn-1",
      }),
    ).toEqual({ kind: "mcp", serverId: "orders", connectionId: "conn-1" });
    expect(
      createEventSourceRequest(t, { choice: "gmail", name: "", visibility: "private" }),
    ).toEqual({
      kind: "gmail",
    });
    expect(
      createEventSourceRequest(t, { choice: "github", name: "Repos", visibility: "workspace" }),
    ).toEqual({ kind: "github", name: "Repos" });
  });

  test("deliveries, sizes and actors read in plain words", () => {
    expect(deliveryEventsLabel(t, { eventIds: [] })).toBe("No events");
    expect(deliveryEventsLabel(t, { eventIds: ["a"] })).toBe("1 event");
    expect(deliveryEventsLabel(t, { eventIds: ["a", "b"] })).toBe("2 events");
    expect(deliveryTitle(t, { eventIds: [], eventTypes: [] })).toBe("No events");
    expect(deliveryTitle(t, { eventIds: ["a"], eventTypes: ["push"] })).toBe("push");
    expect(
      deliveryTitle(t, {
        eventIds: ["a", "b"],
        eventTypes: ["issues.opened", "issue_comment.created"],
      }),
    ).toBe("issues.opened and issue_comment.created");
    expect(
      deliveryTitle(t, {
        eventIds: ["a", "b", "c"],
        eventTypes: ["push", "check_run.completed", "release.published"],
      }),
    ).toBe("push and 2 more");
    // A server that does not name the types still gets a count.
    expect(deliveryTitle(t, { eventIds: ["a", "b"] })).toBe("2 events");
    expect(byteSizeLabel(t, 512)).toBe("512 B");
    expect(byteSizeLabel(t, 1536)).toBe("1.5 KB");
    expect(byteSizeLabel(t, 20 * 1024)).toBe("20 KB");
    expect(byteSizeLabel(t, 3 * 1024 * 1024)).toBe("3.0 MB");
    expect(eventActorLabel(t, { kind: "opengeni", name: null })).toBe("Opengeni");
    expect(eventActorLabel(t, { kind: "opengeni", name: "Reviewer" })).toBe("Reviewer (Opengeni)");
    expect(eventActorLabel(t, { kind: "bot", name: "dependabot" })).toBe("dependabot (bot)");
    expect(eventActorLabel(t, { kind: "bot", name: null })).toBe("A bot");
    expect(eventActorLabel(t, { kind: "person", name: "Ada" })).toBe("Ada");
    expect(eventActorLabel(t, { kind: "unknown", name: null })).toBeNull();
  });
});
