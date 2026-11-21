import { useMemo, useState, type ReactNode } from "react";
import { OpenGeniApiError, type Agent, type AgentTemplate } from "@opengeni/sdk";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AgentStartsWhen } from "@opengeni/react/app/components/agents/agent-setup-sections";
import { Button } from "@opengeni/react/ui/button";
import { ScheduleFormPage } from "../../../components/schedules/schedule-form-page";
import { KitCanvas, KitSection } from "../kit";

/*
 * DEV only. The production Starts when section of an agent's page and its Add
 * trigger dialog, over an in-memory client: which sources exist, whether
 * GitHub is connected and whether a shared automation may be added are
 * fixture choices. "Before" is the full New automation form Add trigger used
 * to open.
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

type State = "connected" | "no-source" | "not-allowed" | "before";

const STATES: { value: State; label: string }[] = [
  { value: "connected", label: "GitHub connected" },
  { value: "no-source", label: "GitHub not connected" },
  { value: "not-allowed", label: "Shared not allowed" },
  { value: "before", label: "Before: full form" },
];

const TEMPLATE = {
  key: "pr-reviewer",
  name: "PR reviewer",
  description: "Reviews pull requests when they open.",
  avatar: null,
  instructions: "Review pull requests.",
  memoryEnabled: true,
  toolPermissions: [],
  skills: [],
  suggestedTriggers: [
    {
      name: "When a pull request opens",
      instructions: "A pull request was opened or marked ready for review. Review it.",
      schedule: null,
      triggers: [
        {
          source: { kind: "github" },
          eventTypes: ["pull_request.opened", "pull_request.ready_for_review"],
          conditions: [{ field: "data.pull_request.draft", op: "equals", value: false }],
        },
      ],
    },
  ],
} as unknown as AgentTemplate;

const AGENT = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: WORKSPACE_ID,
  name: "PR reviewer",
  description: "Reviews pull requests when they open.",
  avatar: null,
  visibility: "workspace",
  ownerSubjectId: null,
  templateKey: "pr-reviewer",
  viewer: { canEdit: true, canManageSlack: true, canOpenInSlack: true },
  version: 1,
} as unknown as Agent;

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
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

const LINEAR_SOURCE = {
  ...GITHUB_SOURCE,
  id: "44444444-4444-4444-8444-444444444444",
  kind: "webhook",
  adapter: "custom",
  format: { preset: "linear" },
  name: "Product Linear",
};

const EVENT_TYPES = ["opened", "ready_for_review", "closed", "synchronize"].map((action) => ({
  type: `pull_request.${action}`,
  description: `A pull request was ${action.replace(/_/gu, " ")}.`,
  fields: [{ field: "data.pull_request.draft", description: "Whether it is a draft." }],
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

function fixtureClient(state: State) {
  const tasks: unknown[] = [];
  const client = {
    listScheduledTasks: async () => tasks,
    listEventSources: async () => (state === "no-source" ? [] : [GITHUB_SOURCE, LINEAR_SOURCE]),
    listReadyEventSources: async () => [],
    listEventSourceTypes: async () => EVENT_TYPES,
    getAgent: async () => AGENT,
    getAgentTemplate: async () => TEMPLATE,
    getAgentLearningSettings: async () => ({
      settings: {},
      version: 1,
      ownerKey: `workspace:${WORKSPACE_ID}`,
    }),
    listSessions: async () => [],
    getSessionTenancyCreateCapabilities: async () => ({
      activated: true,
      canCreatePrivate: true,
      reason: "available",
      defaultVisibility: "private",
    }),
    createEventSource: async (_workspaceId: string, request: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      return {
        source: {
          ...GITHUB_SOURCE,
          id,
          kind: request.kind,
          adapter: request.adapter ?? null,
          name: request.name ?? "Webhook",
          webhookUrl:
            request.kind === "webhook"
              ? `https://app.opengeni.ai/v1/hooks/${id.slice(0, 8)}`
              : null,
        },
        ...(request.kind === "webhook" ? { signingSecret: "whsec_5f2c9a1e7b" } : {}),
      };
    },
    listAgentTemplates: async () => [TEMPLATE],
    catalogAssetUrl: (path: string) => path,
    createScheduledTask: async (_workspaceId: string, request: Record<string, unknown>) => {
      if (state === "not-allowed") {
        throw new OpenGeniApiError(
          403,
          JSON.stringify({ code: "forbidden", message: "missing permission: schedules:manage" }),
          { mutation: true },
        );
      }
      const task = {
        id: crypto.randomUUID(),
        status: "active",
        ...request,
        events: request.events ?? null,
        agentConfig: request.agentConfig,
      };
      tasks.push(task);
      return task;
    },
    pauseScheduledTask: async () => tasks[0],
    resumeScheduledTask: async () => tasks[0],
    deleteScheduledTask: async () => ({ deleted: true }),
  };
  // The full form reads more than the dialog; anything else answers empty.
  return new Proxy(client as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "then") return undefined;
      // A list reads as empty whether it answers an array, `{ items }` or `{ rigs }`.
      return async () => (key.startsWith("list") ? Object.assign([], { items: [], rigs: [] }) : {});
    },
  });
}

function Provider({ state, children }: { state: State; children: ReactNode }) {
  const value = useMemo(
    () => ({
      client: fixtureClient(state),
      clientConfig: {
        eventTriggers: { enabled: true },
        mcpServers: [],
        defaultSandboxBackend: "none",
      },
      model: "default",
      reasoningEffort: "medium",
      managedSelfContext: null,
      githubRepos: REPOSITORIES,
      githubStatus: { status: state === "no-source" ? "unbound" : "bound" },
      workspaceCapabilityCatalog: [],
      accessContext: {
        subjectId: "kit-person",
        workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: ["schedules:manage"] }],
        accountGrants: [],
      },
      selectedCapabilityToolIds: new Set<string>(),
      workspaceDefaultToolIds: [],
      toolMcpServers: [],
      workspaces: [{ id: WORKSPACE_ID, name: "Platform", kind: "shared", settings: {} }],
    }),
    [state],
  );
  return (
    <OpenGeniProvider client={value.client as never} workspaceId={WORKSPACE_ID}>
      <AppContext.Provider value={value as never}>{children}</AppContext.Provider>
    </OpenGeniProvider>
  );
}

export default function AgentTriggerSection() {
  const initial = new URLSearchParams(window.location.search).get("state");
  const [state, setState] = useState<State>(
    STATES.some((entry) => entry.value === initial) ? (initial as State) : "connected",
  );
  return (
    <KitSection sectionKey="page-agent-trigger">
      <div className="flex flex-wrap items-center gap-2">
        {STATES.map((entry) => (
          <Button
            key={entry.value}
            size="sm"
            variant={entry.value === state ? "default" : "outline"}
            onClick={() => setState(entry.value)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <KitCanvas className="min-h-[640px]">
        <div className="mx-auto max-w-[760px]">
          <Provider key={state} state={state}>
            {state === "before" ? (
              <ScheduleFormPage
                workspaceId={WORKSPACE_ID}
                mode={{ kind: "create", agentId: AGENT.id }}
              />
            ) : (
              <AgentStartsWhen agent={AGENT} workspaceId={WORKSPACE_ID} />
            )}
          </Provider>
        </div>
      </KitCanvas>
    </KitSection>
  );
}
