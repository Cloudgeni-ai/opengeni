import type { ReactNode } from "react";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import { AppContext } from "@opengeni/react/app/app-context";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import type { AuthNeededItem } from "@opengeni/react";

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

const client = new Proxy(
  {
    catalogAssetUrl: () => null,
    connectTransport: () => ({}),
    listCapabilities: async () => ({ items: CATALOG.map((item) => ({ ...item, enabled: false })) }),
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
  kind: "mcp" | "api",
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
        {showPart("kinds") ? (
          <StatesGrid title="Kinds" columns={2}>
            {Object.entries(CARDS).map(([key, card]) => (
              <StateCell key={key} label={card.label} align="stretch">
                <Card item={card.item} />
              </StateCell>
            ))}
          </StatesGrid>
        ) : null}
      </KitSection>
    </Provider>
  );
}
