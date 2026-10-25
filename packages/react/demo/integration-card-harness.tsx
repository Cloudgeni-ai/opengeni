// Integration Connect card preview: the console's real SessionCapabilityCard
// inside the real MessageTimeline, for the turn where a person asks for their
// Hotmail and the agent posts the Outlook Mail card. Connect and integration
// state come from a synthetic client, so nothing reaches an API or Microsoft.
//   ?state=suggested|sign-in|admin-approval|personal-unavailable|connected   ?theme=light|dark
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectAttempt, ConnectProvider, ConnectTransport } from "@opengeni/connect";
import type { SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, OpenGeniProvider, type AuthNeededItem } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "session-hotmail";
const CAPABILITY_ID = "api:integration:microsoft-outlook-mail";
const params = new URLSearchParams(window.location.search);
const state = params.get("state") ?? "suggested";
const dark = params.get("theme") === "dark";
const APPROVAL_URL =
  "https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=00000000-0000-0000-0000-000000000000&scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.ReadWrite";

const attempt = (overrides: Partial<ConnectAttempt>): ConnectAttempt => ({
  id: "attempt-preview",
  workspaceId: WORKSPACE_ID,
  providerId: "microsoft-outlook-mail",
  ownership: "personal",
  revision: 2,
  state: "requires_user_action",
  nextAction: { type: "none" },
  credentialsCommitted: false,
  integrationInstalled: false,
  completionRequirement: "integration",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  installationTarget: { instanceKey: "account-preview", displayName: "Outlook Mail" },
  ...overrides,
});

// Recovered setup, as after the person closed the sign-in window or Microsoft
// sent them back saying an administrator must approve the app.
const recovered: ConnectAttempt | null =
  state === "sign-in"
    ? attempt({
        nextAction: {
          type: "authorize",
          url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        },
      })
    : state === "admin-approval"
      ? attempt({
          state: "failed",
          error: {
            code: "admin_consent_required",
            message: `Your organization requires a Microsoft 365 administrator to approve this app first. Send your administrator this approval link: ${APPROVAL_URL} After they approve, connect again.`,
            retryable: true,
          },
        })
      : null;
if (recovered)
  sessionStorage.setItem(
    `opengeni:session-integration-connect:${WORKSPACE_ID}:${SESSION_ID}:${CAPABILITY_ID}`,
    recovered.id,
  );

const provider = (id: string, readiness: ConnectProvider["readiness"]) =>
  ({
    id,
    label: id,
    family: "microsoft",
    readiness,
    // "personal-unavailable": this app cannot connect a personal account (for
    // example a shared service identity); the card never falls back to a
    // workspace account.
    ownership: state === "personal-unavailable" ? ["workspace"] : ["workspace", "personal"],
    setup: ["oauth"],
  }) as ConnectProvider;

const transport: ConnectTransport = {
  catalog: async () => [
    provider("microsoft-outlook-mail", "available"),
    provider("mcp-install", "available"),
  ],
  accounts: async () => [],
  pending: async () => [],
  begin: async () =>
    attempt({
      revision: 1,
      nextAction: { type: "authorize", url: "https://login.microsoftonline.com/common/oauth2" },
    }),
  get: async () => recovered ?? attempt({}),
  advance: async () => recovered ?? attempt({}),
  cancel: async () => attempt({ state: "cancelled" }),
  disconnect: async () => {},
};

class PreviewClient extends MockOpenGeniClient {
  connectTransport() {
    return transport as never;
  }
  async listApiIntegrations() {
    return {
      integrations:
        state === "connected"
          ? [
              {
                definitionId: "microsoft-outlook-mail",
                connected: true,
                ownership: "personal",
                serverId: "api-outlook",
              },
            ]
          : [],
    } as never;
  }
}

function events(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-hotmail";
  log.push("user.message", { text: "Can you read my newest Hotmail emails?" });
  log.tool(
    {
      name: "capability_catalog_search",
      id: "call-search",
      arguments: { query: "Hotmail email" },
      output: { matches: [{ capabilityId: CAPABILITY_ID, name: "Outlook Mail" }] },
    },
    turn,
  );
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "microsoft.com",
      reason: "missing_connection",
      capability: {
        id: CAPABILITY_ID,
        name: "Outlook Mail",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Connect your Outlook or Hotmail inbox so I can read your newest emails.",
        requiredVariables: [],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    { text: "Connect your mailbox with the card above and I'll read your newest emails." },
    turn,
  );
  log.push("turn.completed", {}, turn);
  return log.events;
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          subjectId: "user:kari",
          workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: ["sessions:control"] }],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "personal" }],
        workspaceCapabilityCatalog: [],
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{
          api: { apiBaseUrl: "https://app.opengeni.ai" } as never,
          navigation: undefined as never,
        }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root h-screen overflow-auto bg-bg text-fg">
            <main className="mx-auto max-w-[760px] px-4 py-8" data-shot="">
              <MessageTimeline
                events={events()}
                renderAuthNeeded={(item: AuthNeededItem) => (
                  <SessionCapabilityCard
                    item={item}
                    workspaceId={WORKSPACE_ID}
                    sessionId={SESSION_ID}
                  />
                )}
              />
            </main>
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
