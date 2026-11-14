// Connect card with connect-time inputs: the console's real SessionCapabilityCard
// inside the real MessageTimeline, for the turn where the agent posts the card
// of an integration that needs a value before sign-in (Microsoft Dynamics: the
// environment's address). Catalog state comes from a synthetic client, so
// nothing reaches an API or the service.
//   ?theme=light|dark   ?prefill=1 (the agent filled in an address)
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import type { CapabilityCatalogItem, SessionEvent } from "@opengeni/sdk";
import { MessageTimeline, OpenGeniProvider, type AuthNeededItem } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SessionCapabilityCard } from "@opengeni/react/app/components/capabilities/session-capability-card";
import { EventLog } from "./timeline-fixtures";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "session-connect-inputs";
const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const prefill = params.get("prefill") === "1";

class PreviewClient extends MockOpenGeniClient {
  async listCapabilities() {
    return { items: [] as CapabilityCatalogItem[] } as never;
  }
  async createCapability(): Promise<never> {
    throw new Error("Connecting is not part of this preview");
  }
}

function events(): SessionEvent[] {
  const log = new EventLog();
  const turn = "turn-connect-inputs";
  log.push("user.message", { text: "Which of my Dynamics opportunities close this month?" });
  log.push(
    "tool.auth_needed",
    {
      serverId: "opengeni",
      toolName: "capability_authorization_request",
      providerDomain: "dynamics.com",
      reason: "missing_connection",
      capability: {
        id: "api:microsoft-dynamics",
        name: "Microsoft Dynamics",
        kind: "api",
        source: "built_in",
        action: "connect",
        rationale: "Connect Microsoft Dynamics so the agent can use it for this task.",
        requiredVariables: [],
        inputs: [
          {
            id: "endpointUrl",
            label: "Environment address",
            placeholder: "https://contoso.crm4.dynamics.com",
            ...(prefill ? { value: "https://fabrikam.crm4.dynamics.com" } : {}),
          },
        ],
      },
    },
    turn,
  );
  log.push(
    "agent.message.completed",
    {
      text: "Enter your Dynamics environment's address on the card above and sign in. I'll list the opportunities then.",
    },
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
              permissions: ["sessions:control", "connections:write", "connections:read"],
            },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "team" }],
        workspaceCapabilityCatalog: [],
        refreshWorkspaceMcpServers: async () => {},
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
