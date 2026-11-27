import { useMemo, useState, type ReactNode } from "react";
import type { AgentTemplate, SetupReadiness } from "@opengeni/sdk";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { Button } from "@opengeni/react/ui/button";
import { EnablePage } from "../../../components/enable/enable-page";
import { GetStartedPage } from "../../../components/get-started/get-started-page";
import { OnboardingUseCaseStep } from "../../../components/onboarding/use-case-step";
import { KitCanvas, KitSection } from "../kit";

/*
 * DEV only. The production Get started showcase, Enable page and first-run
 * question over an in-memory client. Which connections are on is a fixture
 * choice; nothing is written anywhere.
 */

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

type State = "showcase" | "enable-nothing" | "enable-ready" | "enable-ask-admin" | "onboarding";

const STATES: { value: State; label: string }[] = [
  { value: "showcase", label: "Get started" },
  { value: "enable-nothing", label: "Enable: nothing connected" },
  { value: "enable-ready", label: "Enable: ready" },
  { value: "enable-ask-admin", label: "Enable: ask an admin" },
  { value: "onboarding", label: "First run" },
];

const SETUP_NONE = {
  connections: [],
  repository: null,
  worksWellWith: null,
  wontDoWithoutAsking: [],
  firstMessage: null,
  firstJob: null,
};

const TEMPLATES = [
  {
    key: "dependency-updater",
    name: "Dependency updater",
    description: "Batches patch and minor upgrades into one pull request a week.",
    suggestedTriggers: [{ name: "Every Monday morning", oneClick: true }],
    setup: {
      connections: [
        {
          provider: "github.com",
          name: "GitHub",
          required: true,
          why: "Reads the repository and opens the upgrade pull request.",
        },
      ],
      repository: "required",
      worksWellWith: "pr-reviewer",
      wontDoWithoutAsking: [
        {
          text: "Merge a pull request",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
        {
          text: "Upgrade a major version",
          permission: "block",
          connector: "github.com",
          tools: ["merge_pull_request"],
        },
      ],
      firstMessage: "Say hello.",
      firstJob: "Open this week's upgrade pull request now.",
    },
  },
  {
    key: "pr-reviewer",
    name: "PR reviewer",
    description: "Reviews pull requests.",
    suggestedTriggers: [{ name: "When a pull request opens", oneClick: true }],
    setup: {
      ...SETUP_NONE,
      connections: [
        { provider: "github.com", name: "GitHub", required: true, why: "Reads pull requests." },
      ],
    },
  },
  {
    key: "triage",
    name: "Triage",
    description: "Sorts new issues.",
    suggestedTriggers: [{ name: "When a Linear issue is created" }],
    setup: {
      ...SETUP_NONE,
      connections: [
        { provider: "linear.app", name: "Linear", required: false, why: "Labels Linear issues." },
      ],
    },
  },
  {
    key: "product-analyst",
    name: "Product analyst",
    description: "Writes a weekly report.",
    suggestedTriggers: [{ name: "Every Monday morning", oneClick: true }],
    setup: {
      ...SETUP_NONE,
      connections: [
        { provider: "posthog.com", name: "PostHog", required: true, why: "Reads analytics." },
      ],
    },
  },
] as unknown as AgentTemplate[];

function readiness(connected: boolean, canConnect = true): SetupReadiness {
  return {
    ready: connected,
    reason: connected
      ? null
      : canConnect
        ? "Connect GitHub to turn this on."
        : "An admin needs to connect GitHub.",
    connections: [
      {
        provider: "github.com",
        name: "GitHub",
        mcpUrl: null,
        required: true,
        why: "Reads the repository and opens the upgrade pull request.",
        connected,
        canConnect,
        catalogItemId: "github",
        connectVia: null,
      },
      {
        provider: "slack.com",
        name: "Slack",
        mcpUrl: null,
        required: false,
        why: "Posts a line when the pull request is up.",
        connected: false,
        canConnect: true,
        catalogItemId: "slack",
        connectVia: null,
      },
    ],
    missing: connected
      ? []
      : [{ kind: "connection", provider: "github.com", name: "GitHub", reason: "" }],
    requiredConnected: connected ? 1 : 0,
    requiredTotal: 1,
  };
}

function fixtureClient(state: State) {
  const client = {
    listAgentTemplates: async () => TEMPLATES,
    getAgentTemplateReadiness: async () =>
      readiness(state === "enable-ready", state !== "enable-ask-admin"),
    requestSetupConnection: async () => ({ status: "requested", adminsAsked: 2 }),
    listAgents: async () => [],
    listScheduledTasks: async () => [],
  };
  return new Proxy(client as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return async () => (key.startsWith("list") ? Object.assign([], { items: [] }) : {});
    },
  });
}

function Provider({ state, children }: { state: State; children: ReactNode }) {
  const value = useMemo(
    () => ({
      client: fixtureClient(state),
      githubStatus: { status: "bound" },
      accessContext: {
        subjectId: "kit-person",
        workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: ["sessions:create"] }],
        accountGrants: [],
      },
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

export default function EnableSection() {
  const initial = new URLSearchParams(window.location.search).get("state");
  const [state, setState] = useState<State>(
    STATES.some((entry) => entry.value === initial) ? (initial as State) : "showcase",
  );
  return (
    <KitSection sectionKey="page-enable">
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
      <KitCanvas className="min-h-[640px]" padding={false}>
        <div data-kit-enable-state={state}>
          <Provider key={state} state={state}>
            {state === "showcase" ? (
              <GetStartedPage workspaceId={WORKSPACE_ID} />
            ) : state === "onboarding" ? (
              <OnboardingUseCaseStep onChoose={() => undefined} />
            ) : (
              <EnablePage
                workspaceId={WORKSPACE_ID}
                subject={{ kind: "agent", templateKey: "dependency-updater" }}
                back={{ label: "Agents", onClick: () => undefined }}
              />
            )}
          </Provider>
        </div>
      </KitCanvas>
    </KitSection>
  );
}
