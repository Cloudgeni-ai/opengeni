import { useState, type ReactNode } from "react";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { AppContext } from "@opengeni/react/app/app-context";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { ThisComputerCard } from "@opengeni/react/this-computer";
import { SessionIntegrationCapabilityCard, type AuthNeededItem } from "@opengeni/react";

import { KitSection, StateCell, StatesGrid } from "../kit";
import { ChatFrame, lead, showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   Connect and setup cards: what the person sees in chat when the agent needs
   an account, a key, a custom server or GitHub before it can carry on. The
   real console card renders against a fake workspace catalog.
   -------------------------------------------------------------------------- */

const CATALOG = [
  CapabilityCatalogItem.parse({
    id: "mcp:linear",
    kind: "mcp",
    source: "public_registry",
    name: "Linear",
    description: "Read and update issues, projects and cycles in Linear.",
    providerDomain: "linear.app",
    mcpUrl: "https://mcp.linear.app/mcp",
    authKind: "oauth2",
    runtime: { available: true, mcpServerId: "linear" },
  }),
  CapabilityCatalogItem.parse({
    id: "mcp:acme-crm",
    kind: "mcp",
    source: "manual",
    name: "Acme CRM",
    description: "Look up customers, deals and notes in Acme CRM.",
    providerDomain: "acme.example.com",
    mcpUrl: "https://acme.example.com/mcp",
    authKind: "api_key",
    runtime: { available: true, mcpServerId: "acme-crm" },
  }),
];

/** Every unknown list call resolves to an empty list that also has empty pages. */
function emptyList(): unknown {
  return Object.assign([], { items: [], definitions: [], integrations: [], machines: [] });
}

/** The marketplace plugin the plugin card offers: two Skills and an MCP server. */
const PLUGIN = {
  id: "anthropic:sentry",
  provider: "anthropic",
  name: "sentry",
  displayName: "Sentry",
  description: "Find, triage and explain production errors from Sentry.",
  category: "Monitoring",
  sourceUrl: "https://github.com/example/plugins/tree/main/sentry",
  logoUrl: null,
  author: { name: "Sentry" },
  skills: [
    {
      name: "triage-errors",
      description: "Group the newest errors and say which one to fix first.",
      sourceUrl: "https://github.com/example/plugins/tree/main/sentry/skills/triage-errors",
    },
    {
      name: "explain-issue",
      description: "Explain one Sentry issue with its stack trace and recent changes.",
      sourceUrl: "https://github.com/example/plugins/tree/main/sentry/skills/explain-issue",
    },
  ],
  mcpServers: [
    {
      name: "sentry",
      transport: "http",
      endpoint: "https://mcp.sentry.dev/mcp",
      requiresConfiguration: false,
    },
  ],
};

const client = new Proxy(
  {
    catalogAssetUrl: () => null,
    connectTransport: () => ({}),
    listCapabilities: async () => ({ items: CATALOG.map((item) => ({ ...item, enabled: false })) }),
    discoverPlugins: async () => ({ items: [PLUGIN], nextCursor: null }),
    listInstalledPlugins: async () => ({ plugins: [] }),
    previewPlugin: async () => {
      throw new Error("The UI kit doesn't install plugins.");
    },
    inspectMcpAuthentication: async () => ({ kind: "none" }),
    getGitHubApp: async () => ({
      status: "unbound",
      configured: true,
      linkUrl: "https://example.com/github/connect",
    }),
    getSession: async () => ({
      id: "session-kit",
      workspaceId: "ws-kit",
      tenancy: { visibility: "workspace", authorityEpoch: 1 },
      tools: [],
      toolPolicy: { mode: "explicit" },
      firstPartyMcpTools: [],
      toolPolicyVersion: 1,
    }),
    updateSessionToolPolicy: async () => ({ firstPartyMcpTools: [] }),
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "then") return undefined;
      return async () => emptyList();
    },
  },
);

const context = new Proxy(
  {
    client,
    workspaceCapabilityCatalog: CATALOG,
    githubStatus: { status: "unbound" },
    githubRepos: [],
    githubCatalogReady: true,
    githubStatusFailed: false,
    repoBusy: false,
    personalGitHubBusy: false,
    workspaces: [],
    accessContext: {
      subjectId: "kit-person",
      workspaceGrants: [
        {
          workspaceId: "ws-kit",
          permissions: [
            "connections:read",
            "connections:write",
            "capabilities:manage",
            "sessions:read",
            "sessions:control",
          ],
        },
      ],
    },
    captureWorkspaceInvocation: () => ({ revision: 1 }),
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return async () => {};
    },
  },
);

function notice(id: string, extra: Partial<AuthNeededItem>): AuthNeededItem {
  return {
    kind: "auth-needed",
    id,
    turnId: "turn-kit",
    serverId: "opengeni",
    providerDomain: "example.com",
    connectionId: null,
    reason: "missing_connection",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    occurredAt: "2026-10-26T10:00:00.000Z",
    ...extra,
  } as AuthNeededItem;
}

function capability(
  id: string,
  name: string,
  kind: "mcp" | "api" | "plugin",
  rationale: string,
): AuthNeededItem["capability"] {
  return {
    id,
    name,
    kind,
    source: "manual",
    action: "connect",
    rationale,
    requiredVariables: [],
  } as unknown as AuthNeededItem["capability"];
}

const CARDS: Record<string, { label: string; item: AuthNeededItem; ask: [string, string] }> = {
  oauth: {
    label: "Sign-in connector (Linear)",
    item: notice("linear", {
      providerDomain: "linear.app",
      capability: capability(
        "mcp:linear",
        "Linear",
        "mcp",
        "Connect Linear so I can file the three bugs from this thread.",
      ),
    }),
    ask: [
      "File the bugs from this thread in Linear.",
      "I need access to Linear first. Connect it below and I'll carry on.",
    ],
  },
  apiKey: {
    label: "API-key connector",
    item: notice("acme", {
      providerDomain: "acme.example.com",
      capability: capability(
        "mcp:acme-crm",
        "Acme CRM",
        "mcp",
        "Add your Acme CRM key so I can look up the customer's open deals.",
      ),
    }),
    ask: [
      "What deals does Northwind have open?",
      "Acme CRM isn't connected yet. Add a key below and I'll look it up.",
    ],
  },
  custom: {
    label: "Custom server the agent found",
    item: notice("custom", {
      providerDomain: "tools.example.com",
      setupRequest: {
        name: "Example Tools",
        endpointUrl: "https://tools.example.com/mcp",
        rationale: "The Example Tools docs list this server for reading build status.",
      },
    } as Partial<AuthNeededItem>),
    ask: [
      "Can you check our build status in Example Tools?",
      "Example Tools has an MCP server. Add it below and I'll check the builds.",
    ],
  },
  github: {
    label: "GitHub",
    item: notice("github", {
      providerDomain: "github.com",
      capability: capability(
        "api:github-app",
        "GitHub",
        "api",
        "Connect GitHub so I can open the pull request.",
      ),
    }),
    ask: ["Open a PR with the fix.", "I need GitHub access for this repository. Connect it below."],
  },
  plugin: {
    label: "Plugin (Skills and an MCP server)",
    item: notice("plugin", {
      providerDomain: "sentry.io",
      capability: capability(
        "plugin:marketplace/anthropic/sentry",
        "Sentry",
        "plugin",
        "Install the Sentry plugin so I can triage this morning's errors.",
      ),
    }),
    ask: [
      "Set yourself up to triage our Sentry errors.",
      "There's a Sentry plugin with triage Skills and its MCP server. Install it below.",
    ],
  },
};

function Card({ item }: { item: AuthNeededItem }) {
  return (
    <SessionCapabilityCard
      item={item}
      workspaceId="ws-kit"
      sessionId="session-kit"
      visibility="workspace"
      resources={[]}
      sendContext={() => ({}) as never}
    />
  );
}

function Provider({ children }: { children: ReactNode }) {
  return <AppContext.Provider value={context as never}>{children}</AppContext.Provider>;
}

/* ----------------------------------------------------------------------------
   Live sign-in steps: a reviewed integration's card against a fake Connect
   backend. Press Connect to see the card wait for its sign-in window, then
   Cancel or Reopen window. "fails" reports an error on its first poll.
   -------------------------------------------------------------------------- */

function signInClient(definitionId: string, mode: "waits" | "fails") {
  let revision = 0;
  let current: Record<string, unknown> | null = null;
  const attempt = (overrides: Record<string, unknown>) => {
    revision += 1;
    current = {
      id: `attempt-${definitionId}`,
      workspaceId: "ws-kit",
      providerId: definitionId,
      ownership: "personal",
      revision,
      state: "requires_user_action",
      nextAction: { type: "none" },
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "integration",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      ...overrides,
    };
    return structuredClone(current);
  };
  const transport = {
    catalog: async () => [
      {
        id: definitionId,
        label: definitionId,
        family: "microsoft",
        readiness: "available",
        ownership: ["personal"],
        setup: ["oauth"],
      },
    ],
    accounts: async () => [],
    pending: async () => [],
    begin: async () =>
      attempt({
        nextAction: { type: "authorize", url: "https://login.example.com/authorize?state=kit" },
      }),
    recover: async () => structuredClone(current),
    get: async () => {
      if (mode === "fails") throw new Error("kit: sign-in failed");
      return structuredClone(current);
    },
    advance: async () => structuredClone(current),
    cancel: async () => attempt({ state: "cancelled", nextAction: { type: "none" } }),
    disconnect: async () => {},
  };
  return {
    connectTransport: () => transport,
    listApiIntegrations: async () => ({ integrations: [] }),
    getSession: async () => ({ id: "session-kit", tools: [], toolPolicy: { mode: "default" } }),
    updateSessionToolPolicy: async () => ({}),
    continueAfterCapabilitySetup: async () => ({ outcome: "queued", updateId: "kit" }),
  };
}

const SIGN_IN = [
  {
    label: "Waiting for sign-in (press Connect)",
    definitionId: "microsoft-outlook-mail",
    name: "Outlook Mail",
    mode: "waits" as const,
    rationale: "Saving the draft to your Outlook needs your mailbox.",
  },
  {
    label: "Cancelled (press Connect, then Cancel)",
    definitionId: "microsoft-outlook-calendar",
    name: "Outlook Calendar",
    mode: "waits" as const,
    rationale: "Booking the review meeting needs your Outlook calendar.",
  },
  {
    label: "Sign-in could not continue (press Connect)",
    definitionId: "microsoft-onedrive",
    name: "OneDrive",
    mode: "fails" as const,
    rationale: "Opening the quarterly report needs your OneDrive.",
  },
];

function SignInCard({ entry }: { entry: (typeof SIGN_IN)[number] }) {
  const [fake] = useState(() => signInClient(entry.definitionId, entry.mode));
  return (
    <SessionIntegrationCapabilityCard
      client={fake as never}
      workspaceId="ws-kit"
      sessionId="session-kit"
      capabilityId={`api:integration:${entry.definitionId}`}
      name={entry.name}
      rationale={entry.rationale}
      returnUrl="https://app.example.com/chat"
    />
  );
}

export default function ChatConnectSection() {
  const oauth = CARDS.oauth!;
  return (
    <Provider>
      <KitSection sectionKey="chat-connect">
        {showPart("chat") ? (
          <StatesGrid title="In a chat" columns={1}>
            <StateCell label={oauth.label} align="stretch">
              <ChatFrame events={lead(...oauth.ask)} status="idle" height={520}>
                <Card item={oauth.item} />
              </ChatFrame>
            </StateCell>
          </StatesGrid>
        ) : null}
        {showPart("signin") ? (
          <StatesGrid title="Sign-in steps" columns={1}>
            {SIGN_IN.map((entry) => (
              <StateCell key={entry.definitionId} label={entry.label} align="stretch">
                <SignInCard entry={entry} />
              </StateCell>
            ))}
          </StatesGrid>
        ) : null}
        {showPart("kinds") ? (
          <StatesGrid title="Kinds" columns={2}>
            {Object.entries(CARDS).map(([key, card]) => (
              <StateCell key={key} label={card.label} align="stretch">
                <Card item={card.item} />
              </StateCell>
            ))}
            <StateCell label="This computer (web, app not installed)" align="stretch">
              <ThisComputerCard
                rationale="Let me use your computer so I can open the spreadsheet in Excel."
                productName="Opengeni"
                machines={[]}
                downloadUrl="#download"
              />
            </StateCell>
          </StatesGrid>
        ) : null}
      </KitSection>
    </Provider>
  );
}
