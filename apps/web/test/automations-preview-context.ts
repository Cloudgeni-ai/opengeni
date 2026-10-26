// Deterministic data for the Automations preview: schedules and event
// automations, their event sources, deliveries and events. Writes change the
// in-memory data; nothing reaches a real API. `?events=0` previews a
// deployment without event triggers. Calls the preview does not model resolve
// to an empty list and are recorded in `window.automationsPreviewUnmodeled`.
import {
  InboundEventSummary,
  ScheduledTask as ScheduledTaskSchema,
  ScheduledTaskRun as ScheduledTaskRunSchema,
} from "@opengeni/contracts";
import type {
  EventDelivery,
  EventSource,
  EventTrigger,
  EventTypeDescriptor,
  InboundEvent,
  ReadyEventSource,
  ScheduledTask,
  ScheduledTaskRun,
  WorkspaceAutomationTemplate,
} from "@opengeni/sdk";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
/** A chat with no automations yet, for the Automations panel in a chat. */
export const chatSessionId = "c4a70000-0000-4000-8000-000000000001";
/** An MCP server the host offers before the viewer has a source for it. */
export const projectsServer = { serverId: "projects", name: "Projects" };
export const projectId = "9e0c4b1a-2f3d-4e5f-8a6b-7c8d9e0f1a2b";
const viewer = "viewer-subject";
const params = new URLSearchParams(location.search);
const eventsEnabled = params.get("events") !== "0";
/** `custom=1` adds two custom webhook sources; off by default so pickers keep their short list. */
const customSources = params.get("custom") === "1";
const HOUR = 3_600_000;
const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
const uuid = (group: string, index: number) =>
  `${group}-0000-4000-8000-${String(index).padStart(12, "0")}`;

/* Event sources. */

function source(index: number, fields: Partial<EventSource>): EventSource {
  return {
    id: uuid("5ce00000", index),
    workspaceId,
    kind: "webhook",
    adapter: null,
    format: null,
    name: "Source",
    ownerSubjectId: null,
    visibility: "workspace",
    status: "active",
    statusReason: null,
    statusReasonCode: null,
    statusReasonDetail: null,
    webhookUrl: null,
    awaitingSigningSecret: false,
    mcp: null,
    lastDeliveryAt: at(0.2),
    createdAt: at(24 * 20),
    updatedAt: at(24),
    viewerAccess: "manage",
    ...fields,
  } as EventSource;
}

const github = source(1, { kind: "github", name: "Acme on GitHub" });
const slack = source(2, { kind: "slack", name: "Acme Slack", lastDeliveryAt: at(3) });
const linear = source(3, {
  kind: "webhook",
  adapter: "linear",
  name: "Linear",
  status: "blocked",
  statusReason: "Paste the signing secret Linear shows for this webhook.",
  statusReasonCode: "awaiting_secret",
  awaitingSigningSecret: true,
  webhookUrl: "https://app.opengeni.ai/v1/webhooks/events/5ce00000-0000-4000-8000-000000000003",
  lastDeliveryAt: null,
});
const gmail = source(4, {
  kind: "gmail",
  name: "ada@acme.dev",
  ownerSubjectId: viewer,
  visibility: "private",
  lastDeliveryAt: at(1),
});
const deploys = source(5, {
  kind: "webhook",
  adapter: "standard",
  name: "Deploy pipeline",
  webhookUrl: "https://app.opengeni.ai/v1/webhooks/events/5ce00000-0000-4000-8000-000000000005",
  lastDeliveryAt: at(26),
});
const orders = source(6, {
  kind: "mcp",
  name: "Orders",
  ownerSubjectId: viewer,
  visibility: "private",
  mcp: { serverId: "orders", connectionId: null } as EventSource["mcp"],
  lastDeliveryAt: at(0.5),
});
const tailnet = source(7, {
  kind: "webhook",
  adapter: "custom",
  format: {
    preset: "tailscale",
    signature: {
      scheme: "timestamped_hmac_sha256",
      header: "Tailscale-Webhook-Signature",
      toleranceSeconds: 300,
    },
    batch: {},
    type: { path: "type" },
    summary: "message",
  },
  name: "Tailnet",
  ownerSubjectId: viewer,
  visibility: "private",
  status: "blocked",
  statusReason:
    "Paste the webhook's signing secret, the one the app shows or the one you set there. Until then its deliveries are refused.",
  statusReasonCode: "awaiting_secret",
  awaitingSigningSecret: true,
  webhookUrl: "https://app.opengeni.ai/v1/webhooks/events/5ce00000-0000-4000-8000-000000000007",
  lastDeliveryAt: null,
});
const builds = source(8, {
  kind: "webhook",
  adapter: "custom",
  format: {
    signature: {
      scheme: "hmac_sha256",
      header: "X-Signature",
      encoding: "hex",
      prefix: "sha256=",
    },
    type: { header: "X-Event" },
  },
  name: "Build server",
  ownerSubjectId: viewer,
  visibility: "private",
  status: "blocked",
  statusReason:
    "Paste the webhook's signing secret, the one the app shows or the one you set there. Until then its deliveries are refused.",
  statusReasonCode: "awaiting_secret",
  awaitingSigningSecret: true,
  webhookUrl: "https://app.opengeni.ai/v1/webhooks/events/5ce00000-0000-4000-8000-000000000008",
  lastDeliveryAt: null,
});
const sources: EventSource[] = eventsEnabled
  ? [github, slack, linear, gmail, deploys, orders, ...(customSources ? [tailnet, builds] : [])]
  : [];

/** MCP servers the viewer is signed in to that offer events, by server id. */
const readyServers: Record<string, string> = { support: "Support desk" };

/** What the viewer can use without setting it up and hasn't added yet. */
function readySources(): ReadyEventSource[] {
  if (!eventsEnabled) return [];
  const servers = Object.entries(readyServers)
    .filter(([serverId]) => !sources.some((item) => item.mcp?.serverId === serverId))
    .map(([serverId, name]) => ({ key: `mcp-server:${serverId}`, kind: "mcp" as const, name }));
  const workspace = sources.some((item) => item.kind === "workspace")
    ? []
    : [{ key: "workspace", kind: "workspace" as const, name: "This workspace" }];
  return [...servers, ...workspace];
}

function descriptor(type: string, description: string, fields: string[] = []): EventTypeDescriptor {
  return {
    type,
    description,
    fields: fields.map((field) => ({ field, description: field.replace("data.", "") })),
    argumentsSchema: null,
    available: true,
    unavailableReason: null,
    unavailableReasonCode: null,
    unavailableReasonDetail: null,
  };
}
const eventTypes: Record<string, EventTypeDescriptor[]> = {
  [github.id]: [
    descriptor("pull_request.opened", "A pull request was opened", [
      "data.repository",
      "data.draft",
      "data.base",
    ]),
    descriptor("pull_request.synchronize", "New commits were pushed to a pull request", [
      "data.repository",
    ]),
    descriptor("issues.opened", "An issue was opened", ["data.repository", "data.labels"]),
    descriptor("check_suite.completed", "A check suite finished", ["data.conclusion"]),
    descriptor("push", "Commits were pushed", ["data.repository", "data.ref"]),
  ],
  [slack.id]: [
    descriptor("app_mention", "Someone mentioned the Opengeni bot", ["data.channel"]),
    descriptor("message.channels", "A message in a channel the bot is in", ["data.channel"]),
  ],
  [linear.id]: [
    descriptor("Issue.create", "An issue was created", ["data.team", "data.priority"]),
    descriptor("Comment.create", "A comment was added", ["data.issue"]),
  ],
  [gmail.id]: [
    descriptor("message.received", "A new message arrived", ["data.from", "data.subject"]),
  ],
  [deploys.id]: [],
  [orders.id]: [
    {
      ...descriptor("order.created", "A new order was placed", ["data.region", "data.total"]),
      argumentsSchema: { type: "object", properties: { region: { type: "string" } } },
    },
  ],
};
const projectEventTypes: EventTypeDescriptor[] = [
  {
    ...descriptor("project.updated", "A project changed", ["data.status", "data.budget"]),
    argumentsSchema: {
      type: "object",
      properties: {
        projectId: {
          type: "string",
          format: "uuid",
          title: "Project",
          description: "The project to watch.",
        },
        change: {
          oneOf: [
            { const: "any", title: "Any change" },
            { const: "status", title: "Status changes" },
            { const: "budget", title: "Budget changes" },
          ],
          description: "Which changes count.",
        },
        includeArchived: { type: "boolean", title: "Include archived projects" },
      },
      required: ["projectId"],
    },
  },
  descriptor("project.commented", "Someone commented on a project", ["data.author"]),
];

/** What a "This workspace" source offers: its meetings and other recordings. */
const recordingFields = [
  "data.title",
  "data.purpose",
  "data.recordingId",
  "data.visibility",
  "data.recordedByYou",
];
const workspaceEventTypes: EventTypeDescriptor[] = [
  descriptor("recording.started", "A recording started", recordingFields),
  descriptor("recording.finished", "A recording finished", recordingFields),
  descriptor(
    "recording.transcript.ready",
    "A recording's transcript is ready to read",
    recordingFields,
  ),
  descriptor("recording.deleted", "A recording was deleted", recordingFields),
];

/* Templates saved in the workspace. */

function savedTemplate(
  index: number,
  fields: Partial<WorkspaceAutomationTemplate>,
): WorkspaceAutomationTemplate {
  return {
    id: uuid("7e3a0000", index),
    workspaceId,
    name: "Template",
    description: "",
    instructions: "Do the thing.",
    schedule: null,
    triggers: [],
    maxRunsPerHour: null,
    createdBySubjectId: viewer,
    viewerAccess: "manage",
    createdAt: at(24 * 3),
    updatedAt: at(24 * 3),
    ...fields,
  };
}

/** One template the viewer saved, one a teammate did; `?templates=0` has none. */
export const releaseNotesTemplateId = uuid("7e3a0000", 1);
const templates: WorkspaceAutomationTemplate[] =
  params.get("templates") === "0"
    ? []
    : [
        savedTemplate(1, {
          name: "Release notes",
          description: "Drafts the notes for each release from the merged pull requests.",
          instructions:
            "Draft release notes from the pull requests merged since the last release. Group them by feature, fix and internal change, and link each one.",
          triggers: eventsEnabled
            ? [
                {
                  source: { kind: "github", sourceId: github.id },
                  eventTypes: ["push"],
                  conditions: [{ field: "data.ref", op: "equals", value: "refs/heads/main" }],
                  includeOwnEvents: false,
                },
              ]
            : [],
        }),
        savedTemplate(2, {
          name: "Friday wrap-up",
          description: "What shipped this week, for the team channel.",
          instructions: "Summarize what the team shipped this week and what is still open.",
          schedule: { type: "calendar", hour: 15, minute: 0, daysOfWeek: ["FRIDAY"] },
          createdBySubjectId: "teammate-subject",
          viewerAccess: "use",
        }),
      ];

/* Automations. */

function trigger(index: number, fields: Partial<EventTrigger>): EventTrigger {
  return {
    id: uuid("7a160000", index),
    sourceId: github.id,
    sourceKind: "github",
    eventTypes: [],
    conditions: [],
    includeOwnEvents: false,
    arguments: null,
    status: "active",
    statusReason: null,
    statusReasonCode: null,
    statusReasonDetail: null,
    createdAt: at(24 * 5),
    updatedAt: at(24 * 5),
    ...fields,
  };
}

function task(
  index: number,
  name: string,
  status: ScheduledTask["status"],
  schedule: ScheduledTask["schedule"],
  fields: Partial<ScheduledTask> = {},
): ScheduledTask {
  const id = uuid("00000000", index);
  return ScheduledTaskSchema.parse({
    id,
    accountId: "44444444-4444-4444-8444-444444444444",
    workspaceId,
    name,
    ownerSubjectId: viewer,
    visibility: "workspace",
    status,
    schedule,
    temporalScheduleId: id,
    runMode: "new_session_per_run",
    overlapPolicy: "allow_concurrent",
    action: { kind: "agent_turn" },
    agentConfig: {
      prompt: "Review the pull request and leave comments on anything risky.",
      resources: [],
      metadata: {},
    },
    authorityRevision: 1,
    executionDigest: "0".repeat(64),
    targetSessionId: null,
    reusableSessionId: null,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    metadata: {},
    createdAt: at(24 * 30),
    updatedAt: at(1),
    ...fields,
  });
}

const manual = { type: "manual" } as const;
const daily = (hour: number, minute: number) =>
  ({ type: "calendar", timeZone: "Europe/Oslo", hour, minute }) as const;

const prReview = task(1, "Review new pull requests", "active", manual, {
  events: {
    triggers: [
      trigger(1, {
        eventTypes: ["pull_request.opened", "pull_request.synchronize"],
        conditions: [
          { field: "data.repository", op: "equals", value: "acme/api" },
          { field: "data.draft", op: "equals", value: false },
        ],
      }),
    ],
    maxRunsPerHour: 30,
    once: false,
    completedAt: null,
    throttledSince: at(0.3),
  },
});
const triage = task(2, "Triage new Linear issues", "active", daily(8, 0), {
  agentConfig: {
    prompt: "Label new issues, find duplicates and assign an owner.",
    resources: [],
    metadata: {},
  },
  events: {
    triggers: [
      trigger(2, {
        sourceId: linear.id,
        sourceKind: "webhook",
        eventTypes: ["Issue.create"],
        status: "blocked",
        statusReason: "Linear needs its signing secret before events can arrive.",
      }),
    ],
    maxRunsPerHour: 30,
    once: false,
    completedAt: null,
    throttledSince: null,
  },
});
const deployWatch = task(3, "Tell me when the deploy finishes", "active", manual, {
  runMode: "existing_session",
  targetSessionId: "22222222-2222-4222-8222-222222222222",
  agentConfig: { prompt: "Check the deploy and summarise it.", resources: [], metadata: {} },
  events: {
    triggers: [
      trigger(3, {
        sourceId: deploys.id,
        sourceKind: "webhook",
        eventTypes: ["deploy.finished"],
        conditions: [{ field: "data.environment", op: "equals", value: "production" }],
      }),
    ],
    maxRunsPerHour: 30,
    once: true,
    completedAt: null,
    throttledSince: null,
  },
} as Partial<ScheduledTask>);
const finishedOnce = task(4, "Answer the first order from Norway", "active", manual, {
  events: {
    triggers: [
      trigger(4, {
        sourceId: orders.id,
        sourceKind: "mcp",
        eventTypes: ["order.created"],
        arguments: { region: "no" },
      }),
    ],
    maxRunsPerHour: 30,
    once: true,
    completedAt: at(5),
    throttledSince: null,
  },
});
const morningBrief = task(5, "Morning inbox brief", "active", daily(7, 30));
const weeklyReport = task(6, "Weekly product metrics report", "paused", {
  type: "calendar",
  timeZone: "Europe/Oslo",
  hour: 9,
  minute: 0,
  daysOfWeek: ["MONDAY"],
});

const tasks: ScheduledTask[] = eventsEnabled
  ? [prReview, triage, deployWatch, finishedOnce, morningBrief, weeklyReport]
  : [morningBrief, weeklyReport];

/* Events, deliveries and runs. */

function inbound(index: number, fields: Partial<InboundEvent>): InboundEvent {
  return {
    id: uuid("e0e00000", index),
    sourceId: github.id,
    sourceKind: "github",
    type: "pull_request.opened",
    occurredAt: at(index * 0.4),
    receivedAt: at(index * 0.4),
    subject: `acme/api#${420 + index}`,
    summary: `Pull request #${420 + index} opened: Make retries idempotent`,
    url: `https://github.com/acme/api/pull/${420 + index}`,
    actor: { kind: "person", name: "ada" },
    data: { repository: "acme/api", draft: false, base: "main" },
    dataTruncated: false,
    gapBefore: false,
    ...fields,
  };
}
const events: InboundEvent[] = [
  inbound(1, {}),
  inbound(2, {
    type: "pull_request.synchronize",
    summary: "New commits on #418: Split the billing worker",
    subject: "acme/api#418",
    actor: { kind: "opengeni", name: "Opengeni" },
  }),
  inbound(3, {
    type: "issues.opened",
    summary: "Issue #77 opened: Webhook retries arrive out of order",
    subject: "acme/api#77",
    gapBefore: true,
  }),
];

function delivery(index: number, fields: Partial<EventDelivery>): EventDelivery {
  return {
    id: uuid("de100000", index),
    sourceId: github.id,
    receivedAt: at(index * 0.4),
    status: "accepted",
    reason: null,
    eventIds: [uuid("e0e00000", index)],
    eventTypes: ["pull_request.opened"],
    bodyBytes: 18_432 + index * 311,
    bodyRetained: true,
    duplicateCount: 0,
    replayOfDeliveryId: null,
    ...fields,
  };
}
const deliveries: EventDelivery[] = [
  delivery(1, {}),
  delivery(2, { duplicateCount: 2, eventTypes: ["pull_request.synchronize"] }),
  delivery(3, {
    eventIds: [uuid("e0e00000", 3), uuid("e0e00000", 13)],
    eventTypes: ["issues.opened", "issue_comment.created"],
  }),
  delivery(4, {
    status: "ignored",
    reason: "No automation listens for ping.",
    eventIds: [],
    eventTypes: [],
  }),
  delivery(5, {
    status: "rejected",
    reason: "The signature did not match the source's secret.",
    eventIds: [],
    eventTypes: [],
    bodyRetained: false,
  }),
];

function run(
  taskId: string,
  index: number,
  hoursAgo: number,
  status: ScheduledTaskRun["status"],
  fields: Partial<ScheduledTaskRun> = {},
): ScheduledTaskRun {
  return ScheduledTaskRunSchema.parse({
    id: uuid(`a${String(index).padStart(7, "0")}`, index),
    accountId: "44444444-4444-4444-8444-444444444444",
    workspaceId,
    taskId,
    taskAuthorityRevision: 1,
    taskExecutionDigest: null,
    status,
    triggerType: "scheduled",
    scheduledAt: null,
    firedAt: at(hoursAgo),
    sessionId: "33333333-3333-4333-8333-333333333333",
    triggerEventId: null,
    actionKind: "agent_turn",
    knowledgeSyncRunId: null,
    knowledgeSummary: null,
    completedAt: status === "dispatched" ? null : at(hoursAgo - 0.1),
    error: status === "failed" ? "The agent stopped before finishing." : null,
    createdAt: at(hoursAgo),
    updatedAt: at(hoursAgo),
    ...fields,
  });
}
const eventRun = (taskId: string, index: number, hoursAgo: number, count: number) =>
  run(taskId, index, hoursAgo, "succeeded", {
    triggerType: "event",
    eventOccurrence: {
      triggerIds: [uuid("7a160000", 1)],
      eventCount: count,
      events: events.slice(0, Math.min(count, 3)).map((event) => InboundEventSummary.parse(event)),
    },
  } as Partial<ScheduledTaskRun>);
const runs: Record<string, ScheduledTaskRun[]> = {
  [prReview.id]: [
    eventRun(prReview.id, 1, 0.2, 1),
    eventRun(prReview.id, 2, 0.6, 7),
    eventRun(prReview.id, 3, 2, 1),
  ],
  [finishedOnce.id]: [eventRun(finishedOnce.id, 4, 5, 1)],
  [morningBrief.id]: [run(morningBrief.id, 5, 3, "succeeded")],
  [weeklyReport.id]: [run(weeklyReport.id, 6, 24 * 4, "failed")],
};

/* Client. */

declare global {
  interface Window {
    automationsPreviewUnmodeled: string[];
  }
}
window.automationsPreviewUnmodeled = [];
const wait = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

function findTask(id: string): ScheduledTask {
  const found = tasks.find((candidate) => candidate.id === id);
  if (!found) throw new Error("This automation is gone.");
  return found;
}
function findSource(id: string): EventSource {
  const found = sources.find((candidate) => candidate.id === id);
  if (!found) throw new Error("This event source is gone.");
  return found;
}

const modeled: Record<string, (...args: never[]) => unknown> = {
  listScheduledTasks: async (_workspace: string, options: { sessionId?: string } = {}) =>
    tasks
      .filter((item) => !options.sessionId || item.targetSessionId === options.sessionId)
      .map((item) => ({ ...item })),
  getScheduledTask: async (_workspace: string, id: string) => ({ ...findTask(id) }),
  listScheduledTaskAccessAttention: async () => [],
  listScheduledTaskRuns: async (_workspace: string, id: string) => runs[id] ?? [],
  pauseScheduledTask: async (_workspace: string, id: string) => {
    await wait();
    const found = findTask(id);
    found.status = "paused";
    return { ...found };
  },
  resumeScheduledTask: async (_workspace: string, id: string) => {
    await wait();
    const found = findTask(id);
    found.status = "active";
    if (found.events) found.events = { ...found.events, completedAt: null };
    return { ...found };
  },
  triggerScheduledTask: async (_workspace: string, id: string) => {
    await wait();
    return { ...findTask(id), updatedAt: new Date().toISOString() };
  },
  deleteScheduledTask: async () => undefined,
  createScheduledTask: async (
    _workspace: string,
    request: Partial<ScheduledTask> & {
      prompt?: string;
      events?: { triggers: Partial<EventTrigger>[]; once?: boolean; maxRunsPerHour?: number };
    },
  ) => {
    await wait();
    // The request's shape as the saved automation: a chat's prompt and stored triggers.
    const { prompt, events: input, ...fields } = request;
    const created = task(
      90 + tasks.length,
      request.name ?? "New automation",
      "active",
      request.schedule ?? manual,
      {
        ...fields,
        ...(prompt
          ? { runMode: "existing_session", agentConfig: { prompt, resources: [], metadata: {} } }
          : {}),
        ...(input
          ? {
              events: {
                triggers: input.triggers.map((entry, index) =>
                  trigger(80 + index, {
                    ...entry,
                    sourceKind: findSource(entry.sourceId ?? "").kind,
                  }),
                ),
                maxRunsPerHour: input.maxRunsPerHour ?? 30,
                once: input.once ?? false,
                completedAt: null,
                throttledSince: null,
              },
            }
          : {}),
      } as Partial<ScheduledTask>,
    );
    tasks.push(created);
    return created;
  },
  updateScheduledTask: async (_workspace: string, id: string, request: Partial<ScheduledTask>) => {
    await wait();
    Object.assign(findTask(id), request);
    return { ...findTask(id) };
  },
  listEventSources: async () => sources.map((item) => ({ ...item })),
  listReadyEventSources: async () => readySources(),
  getEventSource: async (_workspace: string, id: string) => ({ ...findSource(id) }),
  listEventSourceTypes: async (_workspace: string, id: string) => eventTypes[id] ?? [],
  listEventDeliveries: async (_workspace: string, id: string) => ({
    deliveries: id === github.id ? deliveries : [],
    nextCursor: null,
  }),
  listInboundEvents: async (_workspace: string, id: string) => ({
    events: id === github.id ? events : [],
    nextCursor: null,
  }),
  updateEventSource: async (_workspace: string, id: string, request: Partial<EventSource>) => {
    await wait();
    const found = findSource(id);
    Object.assign(found, request);
    if ("signingSecret" in request) {
      Object.assign(found, { awaitingSigningSecret: false, status: "active", statusReason: null });
    }
    return { ...found };
  },
  sendTestEvent: async () => {
    await wait();
    return { delivery: delivery(9, { receivedAt: new Date().toISOString() }) };
  },
  replayEventDelivery: async (_workspace: string, _source: string, id: string) => {
    await wait();
    return { delivery: delivery(10, { replayOfDeliveryId: id }) };
  },
  rotateEventSourceSecret: async () => ({ signingSecret: "whsec_previewSecretValue0123456789" }),
  listAutomationTemplates: async () => templates.map((item) => ({ ...item })),
  createAutomationTemplate: async (
    _workspace: string,
    request: Omit<WorkspaceAutomationTemplate, "id" | "workspaceId">,
  ) => {
    await wait();
    const created = savedTemplate(10 + templates.length, {
      ...request,
      maxRunsPerHour: request.maxRunsPerHour ?? null,
    });
    templates.push(created);
    return { ...created };
  },
  updateAutomationTemplate: async (
    _workspace: string,
    id: string,
    request: Partial<WorkspaceAutomationTemplate>,
  ) => {
    await wait();
    const found = templates.find((candidate) => candidate.id === id);
    if (!found) throw new Error("This template is gone.");
    Object.assign(found, request);
    return { ...found };
  },
  deleteAutomationTemplate: async (_workspace: string, id: string) => {
    await wait();
    const index = templates.findIndex((candidate) => candidate.id === id);
    if (index >= 0) templates.splice(index, 1);
  },
  createEventSource: async (
    _workspace: string,
    request: { kind: string; serverId?: string; name?: string },
  ) => {
    await wait();
    if (request.kind === "workspace") {
      const existing = sources.find((candidate) => candidate.kind === "workspace");
      if (existing) return { source: { ...existing } };
      const created = source(10 + sources.length, {
        kind: "workspace",
        name: request.name ?? "This workspace",
        ownerSubjectId: viewer,
        visibility: "private",
        lastDeliveryAt: null,
      });
      sources.push(created);
      eventTypes[created.id] = workspaceEventTypes;
      return { source: created };
    }
    if (request.kind === "mcp") {
      const created = source(10 + sources.length, {
        kind: "mcp",
        name:
          request.name ??
          (request.serverId ? readyServers[request.serverId] : undefined) ??
          request.serverId ??
          "MCP server",
        ownerSubjectId: viewer,
        visibility: "private",
        mcp: { serverId: request.serverId ?? "", connectionId: null } as EventSource["mcp"],
        lastDeliveryAt: null,
      });
      sources.push(created);
      eventTypes[created.id] = projectEventTypes;
      return { source: created };
    }
    return { source: deploys, signingSecret: "whsec_previewSecretValue0123456789" };
  },
  deleteEventSource: async () => undefined,
  catalogAssetUrl: (path: string) => path,
  getClientConfig: async () => ({}),
  getWorkspaceModelCatalog: async () => ({ models: [] }),
  getWorkspace: async (id: string) => ({ id, inferenceControl: { revision: 0 } }),
  streamWorkspaceInteractionRevisions: () => new Promise(() => undefined),
  streamWorkspaceControlEvents: () => new Promise(() => undefined),
  getSessionTenancyCreateCapabilities: async () => ({
    activated: true,
    canCreatePrivate: true,
    reason: "available",
    defaultVisibility: "workspace",
  }),
  getAgentLearningSettings: async () => ({
    settings: {},
    version: 1,
    ownerKey: `workspace:${workspaceId}`,
  }),
  listSessions: async () => [],
  getSession: async () => {
    throw new Error("not used");
  },
};

const client = new Proxy(modeled, {
  get(target, property) {
    if (typeof property !== "string") return undefined;
    if (property in target) return target[property];
    if (property === "then") return undefined;
    return async () => {
      window.automationsPreviewUnmodeled.push(property);
      return [];
    };
  },
});

const context = {
  client,
  clientConfig: {
    mcpServers: [],
    defaultSandboxBackend: "none",
    eventTriggers: { enabled: eventsEnabled },
  },
  workspaces: [],
  managedSelfContext: null,
  model: "example-model",
  reasoningEffort: "high",
  selectedCapabilityToolIds: new Set<string>(),
  workspaceDefaultToolIds: [] as string[],
  githubRepos: [],
  toolMcpServers: [],
  accessContext: {
    subjectId: viewer,
    workspaceGrants: [
      {
        workspaceId,
        permissions: ["scheduled_tasks:manage", "scheduled_tasks:run", "event_sources:manage"],
      },
    ],
  },
  workspaceCapabilityCatalog: [],
  captureWorkspaceInvocation: () => ({}),
  ownsWorkspaceInvocation: () => true,
};

export const previewClient = client;

export function useAppContext() {
  return context;
}
