import { useMemo, useState, type ReactNode } from "react";
import type { Agent, AgentTemplate } from "@opengeni/sdk";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AgentPage } from "@opengeni/react/app/components/agents/agent-page";
import { AgentsPage } from "@opengeni/react/app/components/agents/agents-page";
import { ReadyMadeAgentPreview } from "@opengeni/react/app/components/agents/ready-made-agent-preview";
import { Button } from "@opengeni/react/ui/button";
import { KitCanvas, KitSection } from "../kit";

/*
 * DEV only. The production Agents list, a ready-made agent's preview, an
 * agent's page (the job card) and its Add trigger, over an in-memory client:
 * agents, templates, triggers, last runs and the server's readiness check are
 * fixtures. Add trigger opens from the agent page's When it works.
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

type View = "list" | "preview" | "agent";

const VIEWS: { value: View; label: string }[] = [
  { value: "list", label: "Agents list" },
  { value: "preview", label: "Ready-made preview" },
  { value: "agent", label: "Agent page" },
];

const github = (why: string, required = true) => ({
  provider: "github.com",
  name: "GitHub",
  required,
  why,
});

function template(patch: Record<string, unknown>): AgentTemplate {
  return {
    avatar: null,
    instructions: "",
    memoryEnabled: true,
    toolPermissions: [],
    skills: [],
    suggestedTriggers: [],
    setup: null,
    ...patch,
  } as unknown as AgentTemplate;
}

const PR_OPENS = {
  source: { kind: "github" },
  eventTypes: ["pull_request.opened", "pull_request.ready_for_review"],
  conditions: [{ field: "data.pull_request.draft", op: "equals", value: false }],
};

const TEMPLATES = [
  template({
    key: "pr-reviewer",
    name: "PR reviewer",
    description: "Reviews pull requests when they open and posts one clear review.",
    suggestedTriggers: [
      {
        name: "When a pull request opens",
        instructions: "Review it.",
        schedule: null,
        triggers: [PR_OPENS],
      },
    ],
    setup: {
      connections: [github("Reads pull requests and posts reviews.")],
      repository: "optional",
      worksWellWith: "bug-fixer",
      wontDoWithoutAsking: [
        {
          text: "Approve or merge a pull request",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
        {
          text: "Push to someone else's branch",
          permission: "ask",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
      ],
      firstMessage: null,
      firstJob: null,
    },
  }),
  template({
    key: "bug-fixer",
    name: "Bug fixer",
    description: "Fixes issues labelled bug and opens a pull request with the fix.",
    suggestedTriggers: [
      {
        name: "When an issue is labelled bug",
        instructions: "Fix it.",
        schedule: null,
        triggers: [
          {
            source: { kind: "github" },
            eventTypes: ["issues.labeled"],
            conditions: [{ field: "data.label", op: "equals", value: "bug" }],
          },
        ],
      },
    ],
    setup: {
      connections: [github("Reads issues and opens pull requests.")],
      repository: "required",
      worksWellWith: null,
      wontDoWithoutAsking: [
        {
          text: "Merge its own pull request",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
      ],
      firstMessage: null,
      firstJob: null,
    },
  }),
  template({
    key: "dependency-updater",
    name: "Dependency updater",
    description: "Updates dependencies every week and opens one pull request.",
    suggestedTriggers: [
      {
        name: "Every Monday morning",
        instructions: "Update dependencies.",
        schedule: { type: "calendar", hour: 9, minute: 30, daysOfWeek: ["MONDAY"] },
        triggers: [],
      },
    ],
    setup: {
      connections: [github("Opens the update pull request.")],
      repository: "required",
      worksWellWith: "pr-reviewer",
      wontDoWithoutAsking: [
        {
          text: "Merge the update",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
      ],
      firstMessage: null,
      firstJob: null,
    },
  }),
  template({
    key: "product-analyst",
    name: "Product analyst",
    description: "Reads your product analytics in PostHog and sends a short weekly report.",
    suggestedTriggers: [
      {
        name: "Every Monday morning",
        instructions: "Write the weekly report.",
        schedule: { type: "calendar", hour: 9, minute: 0, daysOfWeek: ["MONDAY"] },
        triggers: [],
      },
    ],
    setup: {
      connections: [
        {
          provider: "posthog.com",
          name: "PostHog",
          required: true,
          why: "Reads your product analytics.",
        },
        { provider: "slack.com", name: "Slack", required: false, why: "Posts the report." },
      ],
      repository: null,
      worksWellWith: null,
      wontDoWithoutAsking: [
        {
          text: "Change feature flags or experiments",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
        {
          text: "Change tracking",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
      ],
      firstMessage: null,
      firstJob: null,
    },
  }),
];

function agent(patch: Partial<Agent>): Agent {
  return {
    workspaceId: WORKSPACE_ID,
    description: "",
    avatar: null,
    visibility: "workspace",
    ownerSubjectId: null,
    editAccess: "everyone",
    origin: "app",
    sourceSessionId: null,
    createdBySubjectId: "kit-person",
    revision: 1,
    hasFirstMessage: false,
    memory: { enabled: true, collectionId: null, scope: "workspace", reviewFirst: false },
    toolPermissions: [],
    skills: [],
    templateKey: null,
    slack: [],
    viewer: { canEdit: true, canManage: true, canManageSlack: true, canOpenInSlack: true },
    version: 1,
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60 * 24),
    instructions: "",
    firstMessage: "",
    revisionCreatedBySubjectId: "kit-person",
    revisionCreatedAt: ago(60 * 24),
    ...patch,
  } as Agent;
}

const REVIEWER = agent({
  id: "22222222-2222-4222-8222-000000000001",
  name: "PR reviewer",
  description: "Reviews pull requests when they open and posts one clear review.",
  templateKey: "pr-reviewer",
});
const ANALYST = agent({
  id: "22222222-2222-4222-8222-000000000002",
  name: "Product analyst",
  description: "Reads your product analytics in PostHog and sends a short weekly report.",
  templateKey: "product-analyst",
});
const FIXER = agent({
  id: "22222222-2222-4222-8222-000000000003",
  name: "Bug fixer",
  description: "Fixes issues labelled bug and opens a pull request with the fix.",
  templateKey: "bug-fixer",
});
const RELEASE = agent({
  id: "22222222-2222-4222-8222-000000000004",
  name: "Release manager",
  description: "Plans and checks our weekly releases.",
  slack: [{ connectionId: "c", slackTeamId: "T1", slackTeamName: "Acme" }] as never,
});
const AGENTS = [REVIEWER, FIXER, ANALYST, RELEASE];

const GITHUB_SOURCE = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId: WORKSPACE_ID,
  kind: "github",
  adapter: null,
  format: null,
  name: "Platform GitHub",
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
  createdAt: ago(60 * 24 * 30),
  updatedAt: ago(60 * 24 * 30),
};

const task = (patch: Record<string, unknown>): Record<string, unknown> => ({
  status: "active",
  visibility: "workspace",
  creatorLocked: false,
  schedule: { type: "manual" },
  events: null,
  createdBy: null,
  ...patch,
});

const TASKS = [
  task({
    id: "44444444-4444-4444-8444-000000000001",
    name: "PR reviewer: When a pull request opens",
    ownerSubjectId: "kit-person",
    events: {
      triggers: [
        {
          sourceId: GITHUB_SOURCE.id,
          eventTypes: PR_OPENS.eventTypes,
          conditions: [
            ...PR_OPENS.conditions,
            { field: "data.repository.full_name", op: "in", value: ["platform/api"] },
          ],
        },
      ],
    },
    agentConfig: { agentId: REVIEWER.id },
  }),
  task({
    id: "44444444-4444-4444-8444-000000000002",
    name: "PR reviewer: Every Monday",
    ownerSubjectId: "kit-ada",
    schedule: {
      type: "calendar",
      hour: 9,
      minute: 0,
      daysOfWeek: ["MONDAY"],
      timeZone: "Europe/Oslo",
    },
    agentConfig: {
      agentId: REVIEWER.id,
      resources: [
        { kind: "repository", uri: "https://github.com/platform/web.git", provider: "github" },
      ],
    },
  }),
  task({
    id: "44444444-4444-4444-8444-000000000003",
    name: "Bug fixer: When an issue is labelled bug",
    ownerSubjectId: "kit-person",
    events: {
      triggers: [
        {
          sourceId: GITHUB_SOURCE.id,
          eventTypes: ["issues.labeled"],
          conditions: [{ field: "data.label", op: "equals", value: "bug" }],
        },
      ],
    },
    agentConfig: { agentId: FIXER.id },
  }),
  task({
    id: "44444444-4444-4444-8444-000000000004",
    name: "Product analyst: Every Monday",
    status: "paused",
    ownerSubjectId: "kit-person",
    schedule: { type: "calendar", hour: 9, minute: 0, daysOfWeek: ["MONDAY"] },
    agentConfig: { agentId: ANALYST.id },
  }),
  task({
    id: "44444444-4444-4444-8444-000000000005",
    name: "Morning digest",
    ownerSubjectId: "kit-person",
    schedule: { type: "calendar", hour: 8, minute: 0, daysOfWeek: ["MONDAY"] },
    agentConfig: {},
  }),
];

const LAST_RUNS: Record<string, string> = {
  "44444444-4444-4444-8444-000000000001": ago(42),
  "44444444-4444-4444-8444-000000000003": ago(3),
};

const CHATS: Record<string, { minutes: number; title: string; running?: boolean }[]> = {
  [REVIEWER.id]: [
    { minutes: 42, title: "Review: Add retry to webhook delivery" },
    { minutes: 60 * 5, title: "Review: Move billing jobs to the queue" },
    { minutes: 60 * 26, title: "Review: Sidebar order" },
  ],
  [FIXER.id]: [{ minutes: 3, title: "Fix: Export fails on empty tables", running: true }],
  [RELEASE.id]: [{ minutes: 60 * 48, title: "Release checklist for 26 Nov" }],
};

const readiness = (missing: boolean, connections: Record<string, unknown>[]) => ({
  ready: !missing,
  reason: missing ? "Connect PostHog to turn this on." : null,
  connections: connections.map((connection) => ({
    mcpUrl: null,
    canConnect: true,
    catalogItemId: null,
    ...connection,
  })),
  missing: missing
    ? [
        {
          kind: "connection",
          provider: "posthog.com",
          name: "PostHog",
          reason: "Connect PostHog to turn this on.",
        },
      ]
    : [],
  requiredConnected: missing ? 0 : 1,
  requiredTotal: 1,
});

const GITHUB_READY = readiness(false, [
  { ...github("Reads pull requests and posts reviews."), connected: true },
]);
const ANALYST_READINESS = readiness(true, [
  {
    provider: "posthog.com",
    name: "PostHog",
    required: true,
    why: "Reads your product analytics.",
    connected: false,
  },
  {
    provider: "slack.com",
    name: "Slack",
    required: false,
    why: "Posts the report.",
    connected: true,
  },
]);

const EVENT_TYPES = ["opened", "ready_for_review", "closed"].map((action) => ({
  type: `pull_request.${action}`,
  description: `A pull request was ${action.replace(/_/gu, " ")}.`,
  fields: [],
  argumentsSchema: null,
  available: true,
  unavailableReason: null,
  unavailableReasonCode: null,
  unavailableReasonDetail: null,
}));

const REPOSITORIES = ["platform/api", "platform/web"].map((fullName, index) => ({
  id: 1000 + index,
  fullName,
  name: fullName.split("/")[1],
  owner: "platform",
  private: true,
  defaultBranch: "main",
  cloneUrl: `https://github.com/${fullName}.git`,
  installationId: 77,
}));

function fixtureClient() {
  const tasks = [...TASKS];
  const client = {
    listAgents: async () => AGENTS,
    getAgent: async (_workspaceId: string, id: string) => AGENTS.find((entry) => entry.id === id),
    listAgentTemplates: async () => TEMPLATES,
    getAgentReadiness: async (_workspaceId: string, id: string) =>
      id === ANALYST.id ? ANALYST_READINESS : GITHUB_READY,
    listAgentReadiness: async () =>
      AGENTS.map((entry) => ({
        agentId: entry.id,
        readiness: entry.id === ANALYST.id ? ANALYST_READINESS : GITHUB_READY,
      })),
    getAgentTemplateReadiness: async (_workspaceId: string, key: string) =>
      key === "product-analyst" ? ANALYST_READINESS : GITHUB_READY,
    listScheduledTasks: async (_workspaceId: string, request: { agentId?: string } = {}) =>
      request.agentId
        ? tasks.filter(
            (entry) => (entry.agentConfig as { agentId?: string }).agentId === request.agentId,
          )
        : tasks,
    listScheduledTaskRuns: async (_workspaceId: string, id: string) =>
      LAST_RUNS[id] ? [{ id: `run-${id}`, scheduledTaskId: id, firedAt: LAST_RUNS[id] }] : [],
    listEventSources: async () => [GITHUB_SOURCE],
    listReadyEventSources: async () => [],
    listEventSourceTypes: async () => EVENT_TYPES,
    listWorkspaceMembers: async () => [
      { subjectId: "kit-person", subjectLabel: "Maja Lund" },
      { subjectId: "kit-ada", subjectLabel: "Ada Berg" },
    ],
    listAgentChats: async (_workspaceId: string, id: string) => ({
      chats: (CHATS[id] ?? []).map((chat, index) => ({
        sessionId: `55555555-5555-4555-8555-${String(index).padStart(11, "0")}${id.slice(-1)}`,
        title: chat.title,
        visibility: "workspace",
        createdBySubjectId: "kit-person",
        source: "app",
        slack: null,
        createdAt: ago(chat.minutes),
        updatedAt: ago(chat.minutes),
      })),
      nextCursor: null,
    }),
    getSession: async (_workspaceId: string, sessionId: string) => ({
      id: sessionId,
      status: sessionId.endsWith("3") ? "running" : "idle",
    }),
    getAgentLearningSettings: async () => ({
      settings: {},
      version: 1,
      ownerKey: `workspace:${WORKSPACE_ID}`,
    }),
    getSessionTenancyCreateCapabilities: async () => ({
      activated: true,
      canCreatePrivate: true,
      reason: "available",
      defaultVisibility: "private",
    }),
    getGitHubApp: async () => ({ status: "bound" }),
    catalogAssetUrl: (path: string) => path,
    createAgentFromTemplate: async () => {
      throw new Error("Fixture: adding is not simulated here.");
    },
  };
  return new Proxy(client as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return async () => (key.startsWith("list") ? Object.assign([], { items: [], rigs: [] }) : {});
    },
  });
}

function Provider({ children }: { children: ReactNode }) {
  const value = useMemo(
    () => ({
      client: fixtureClient(),
      clientConfig: {
        eventTriggers: { enabled: true },
        mcpServers: [],
        defaultSandboxBackend: "none",
      },
      model: "default",
      reasoningEffort: "medium",
      managedSelfContext: null,
      githubRepos: REPOSITORIES,
      githubStatus: { status: "bound" },
      workspaceCapabilityCatalog: [],
      accessContext: {
        subjectId: "kit-person",
        subjectLabel: "Maja Lund",
        workspaceGrants: [
          {
            workspaceId: WORKSPACE_ID,
            subjectId: "kit-person",
            permissions: ["sessions:read", "sessions:create", "scheduled_tasks:manage"],
          },
        ],
        accountGrants: [],
      },
      selectedCapabilityToolIds: new Set<string>(),
      workspaceDefaultToolIds: [],
      toolMcpServers: [],
      workspaces: [{ id: WORKSPACE_ID, name: "Platform", kind: "shared", settings: {} }],
    }),
    [],
  );
  return (
    <OpenGeniProvider client={value.client as never} workspaceId={WORKSPACE_ID}>
      <AppContext.Provider value={value as never}>{children}</AppContext.Provider>
    </OpenGeniProvider>
  );
}

export default function AgentsJobCardSection() {
  const initial = new URLSearchParams(window.location.search).get("view");
  const [view, setView] = useState<View>(
    VIEWS.some((entry) => entry.value === initial) ? (initial as View) : "list",
  );
  return (
    <KitSection sectionKey="page-agents-job-card">
      <div className="flex flex-wrap items-center gap-2">
        {VIEWS.map((entry) => (
          <Button
            key={entry.value}
            size="sm"
            variant={entry.value === view ? "default" : "outline"}
            onClick={() => setView(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <KitCanvas className="min-h-[720px]">
        <div className="mx-auto max-w-[1040px]" data-kit-agents-view={view}>
          <Provider key={view}>
            {view === "list" ? (
              <AgentsPage workspaceId={WORKSPACE_ID} />
            ) : view === "preview" ? (
              <ReadyMadeAgentPreview
                workspaceId={WORKSPACE_ID}
                templateKey="product-analyst"
                onBack={() => setView("list")}
                onAdded={() => setView("agent")}
              />
            ) : (
              <AgentPage workspaceId={WORKSPACE_ID} agentId={REVIEWER.id} />
            )}
          </Provider>
        </div>
      </KitCanvas>
    </KitSection>
  );
}
