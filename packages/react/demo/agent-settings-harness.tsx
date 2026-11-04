// A chat's real Agent tab (AgentConfigurationPanel) in a dock-width column,
// to preview its settings. A synthetic client answers the reads and saves, so
// nothing reaches an API; the Work without me switch toggles locally.
//   ?unattended=on|off   ?theme=light|dark   ?width=<px>
import { allAgentCapabilities } from "@opengeni/contracts";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { AgentConfigurationPanel } from "@opengeni/react/app/components/session/agent-configuration-panel";
import { MockOpenGeniClient } from "./mock";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "22222222-3333-4444-8555-666666666666";
const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const width = Number(params.get("width") ?? "420");

function chat(unattended: boolean) {
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    title: "Nightly dependency audit",
    agent: {
      version: 1,
      from: "all",
      capabilities: allAgentCapabilities(),
      unavailable: [],
      identity: null,
      renderer: "markdown",
      source: "workspace_default",
    },
    toolPolicyVersion: 1,
    mcpServers: [],
    tools: [],
    firstPartyMcpTools: [],
    memoryScope: "workspace",
    metadata: {},
    unattended,
  } as never;
}

class PreviewClient extends MockOpenGeniClient {
  unattended = params.get("unattended") !== "off";
  async getAgentLearningSettings(_workspaceId: string, scope: string) {
    return {
      ownerKey: scope,
      contextKey: "defaults",
      version: 1,
      settings: { knowledge: "automatic", instructions: "review_first", skills: "review_first" },
    } as never;
  }
  async updateSessionUnattended(
    _workspaceId: string,
    _sessionId: string,
    request: { unattended: boolean },
  ) {
    this.unattended = request.unattended;
    return chat(request.unattended);
  }
}

function Preview() {
  const client = useMemo(() => new PreviewClient(), []);
  const [session, setSession] = useState(() => chat(client.unattended));
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/sessions/${SESSION_ID}`,
    consoleOrigin: window.location.origin,
    handles: () => true,
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          mode: "managed",
          subjectId: "user:kari",
          workspaceGrants: [
            {
              workspaceId: WORKSPACE_ID,
              subjectId: "user:kari",
              principalKind: "human_session",
              permissions: ["sessions:read", "sessions:control"],
            },
          ],
        },
        workspaces: [
          {
            id: WORKSPACE_ID,
            accountId: "account-preview",
            kind: "shared",
            name: "Acme",
            settings: {},
            agentInstructions: null,
          },
        ],
        clientConfig: {
          agentConfig: { enabled: true, defaultForNewSessions: true, capabilities: [] },
          sessionArchive: { enabled: true, idleDays: 30 },
        },
        managedSelfContext: null,
        workspaceDefaultToolIds: [],
        toolMcpServers: [],
        workspaceCapabilityCatalog: [],
        setSession: (update: (current: unknown) => unknown) =>
          setSession((current: never) => update(current) as never),
        captureWorkspaceInvocation: () => ({}),
        ownsWorkspaceInvocation: () => true,
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{
          api: { apiBaseUrl: "https://app.opengeni.ai" } as never,
          navigation,
        }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root min-h-screen bg-og-bg text-og-fg">
            <aside
              data-shot=""
              className="mx-auto h-[860px] border-x border-border bg-surface"
              style={{ width }}
            >
              <AgentConfigurationPanel session={session} onReloadSession={async () => {}} />
            </aside>
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
