// MCP connect card preview: the console's real SessionCapabilityCard inside
// the real MessageTimeline, for the turn where the agent posts a connect card
// for a reviewed catalog service (Google Calendar) or for a server someone
// added by hand. Catalog and connection state come from a synthetic client,
// so nothing reaches an API or the service.
//   ?service=calendar|added   ?theme=light|dark
// Open the card's setup dialog with its button to see the dialog.
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectTransport } from "@opengeni/connect";
import type { CapabilityCatalogItem, SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, OpenGeniProvider, type AuthNeededItem } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "session-connect";
const params = new URLSearchParams(window.location.search);
const service = params.get("service") === "added" ? "added" : "calendar";
const dark = params.get("theme") === "dark";

const CALENDAR = {
  id: "mcp:catalog:google-calendar",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  name: "Google Calendar",
  enabled: false,
  stale: false,
  mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
  providerDomain: "calendarmcp.googleapis.com",
  description:
    "See what's on your calendar, check when you're free, and add, move or cancel events in your Google Calendar.",
  metadata: {
    defaultConnectionOwnership: "personal",
    presentation: {
      providerName: "Google",
      icon: "calendar",
      introduction: "Let agents work with the Google Calendar you choose.",
      capabilities: [
        {
          title: "Answer questions about your schedule",
          description: "See what's on today, tomorrow or any week, in your own time zone.",
        },
        {
          title: "Find free time",
          description: "Check when you, or people who share their calendar with you, are free.",
        },
        {
          title: "Add and change events",
          description:
            "Create, move, update or delete events. You choose which actions need approval.",
        },
      ],
      permissionSummary:
        "Google asks to see your list of calendars, see and edit events, and see when you are free or busy.",
    },
  },
} as unknown as CapabilityCatalogItem;

const ADDED = {
  id: "mcp:custom:tickets",
  kind: "mcp",
  source: "manual",
  authKind: "oauth2",
  name: "Tickets",
  enabled: false,
  stale: false,
  mcpUrl: "https://mcp.tickets.example.com/mcp",
  providerDomain: "mcp.tickets.example.com",
  description: "Read and update support tickets.",
  metadata: {},
} as unknown as CapabilityCatalogItem;

const item = service === "added" ? ADDED : CALENDAR;

// Nothing is pending and a connect never starts here: the preview shows the
// card and its setup dialog before the person presses Connect.
const transport = {
  catalog: async () => [],
  accounts: async () => [],
  pending: async () => [],
  begin: async () => {
    throw new Error("Connecting is not part of this preview");
  },
  get: async () => {
    throw new Error("No attempt in this preview");
  },
  advance: async () => {
    throw new Error("No attempt in this preview");
  },
  cancel: async () => {
    throw new Error("No attempt in this preview");
  },
  disconnect: async () => {},
} as unknown as ConnectTransport;

class PreviewClient extends MockOpenGeniClient {
  connectTransport() {
    return transport as never;
  }
  async listCapabilities() {
    return { items: [item] } as never;
  }
  async listConnections() {
    return [] as never;
  }
  async listOwnConnectionAccounts() {
    return [] as never;
  }
  async listWorkspaceMembers() {
    return [] as never;
  }
  async downloadCatalogAsset(): Promise<Blob> {
    throw new Error("No catalog assets in this preview");
  }
}

function events(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-connect";
  log.push("user.message", {
    text: service === "added" ? "Close the ticket about the login bug." : "Am I free on Friday?",
  });
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: item.providerDomain,
      reason: "missing_connection",
      capability: {
        id: item.id,
        name: item.name,
        kind: "mcp",
        source: item.source,
        action: "connect",
        rationale:
          service === "added"
            ? "Connect Tickets so I can close the ticket."
            : "Connect your Google Calendar so I can check Friday.",
        requiredVariables: [],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    { text: "Connect it with the card above and I'll carry on." },
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
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              permissions: [
                "sessions:control",
                "workspace:admin",
                "connections:write",
                "capabilities:write",
              ],
            },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "team" }],
        workspaceCapabilityCatalog: [item],
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
                renderAuthNeeded={(entry: AuthNeededItem) => (
                  <SessionCapabilityCard
                    item={entry}
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
