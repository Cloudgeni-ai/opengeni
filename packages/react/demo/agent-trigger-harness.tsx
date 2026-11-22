// An agent's real Add trigger dialog (AgentTriggerDialog), to preview its
// steps. A synthetic client answers the reads and writes, so nothing reaches
// an API: Linear, Sentry and Tailscale webhooks are created waiting for their
// secret, and saving a secret only marks it set.
//   ?theme=light|dark
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { useMemoryNavigation } from "@opengeni/react/app/embed/memory-navigation";
import { AgentTriggerDialog } from "@opengeni/react/app/components/agents/agent-trigger-dialog";
import "./agent-settings.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";

const AGENT = {
  id: "33333333-4444-4555-8666-777777777777",
  name: "Bug fixer",
  visibility: "workspace",
} as never;

type Source = Record<string, unknown> & { id: string };

function previewClient() {
  const sources = new Map<string, Source>();
  const methods: Record<string, (...args: never[]) => Promise<unknown>> = {
    async listEventSources() {
      return [...sources.values()];
    },
    async listReadyEventSources() {
      return [];
    },
    async listEventSourceTypes() {
      return [];
    },
    async createEventSource(_workspaceId: string, request: Record<string, unknown>) {
      const id = crypto.randomUUID();
      const pasted = request.kind === "webhook" && request.adapter === "custom";
      const source: Source = {
        id,
        workspaceId: WORKSPACE_ID,
        kind: request.kind,
        adapter: request.adapter ?? null,
        format: request.format ?? null,
        name: request.name ?? String(request.kind),
        visibility: request.visibility ?? "workspace",
        status: pasted ? "blocked" : "active",
        statusReasonCode: pasted ? "awaiting_secret" : null,
        statusReason: pasted ? "Paste the signing secret." : null,
        awaitingSigningSecret: pasted,
        mcp: null,
        webhookUrl:
          request.kind === "webhook" ? `https://api.opengeni.ai/v1/hooks/${id.slice(0, 8)}` : null,
      };
      sources.set(id, source);
      return { source };
    },
    async updateEventSource(_workspaceId: string, sourceId: string) {
      const updated = {
        ...sources.get(sourceId)!,
        status: "active",
        statusReasonCode: null,
        statusReason: null,
        awaitingSigningSecret: false,
      };
      sources.set(sourceId, updated);
      return updated;
    },
    async listAgentChats() {
      return { sessions: [], nextCursor: null };
    },
  };
  return new Proxy(methods, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key === "catalogAssetUrl") return (path: string) => path;
      if (key === "then") return undefined;
      return async () => [];
    },
  });
}

function Preview() {
  const client = useMemo(() => previewClient(), []);
  const [open, setOpen] = useState(true);
  const navigation = useMemoryNavigation({
    initialPath: `/workspaces/${WORKSPACE_ID}/agents`,
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
              permissions: ["sessions:read", "sessions:control", "automations:manage"],
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
        clientConfig: { eventTriggers: { enabled: true } },
        githubStatus: { status: "connected" },
        githubRepos: [],
        managedSelfContext: null,
        workspaceDefaultToolIds: [],
        toolMcpServers: [],
        workspaceCapabilityCatalog: [],
        captureWorkspaceInvocation: () => ({}),
        ownsWorkspaceInvocation: () => true,
      }) as never,
    [client],
  );
  return (
    <OpenGeniProvider client={client as never} workspaceId={WORKSPACE_ID}>
      <AppHostProvider
        host={{ api: { apiBaseUrl: "https://app.opengeni.ai" } as never, navigation }}
      >
        <AppContext.Provider value={context}>
          <div className="og-root min-h-screen bg-og-bg text-og-fg">
            <AgentTriggerDialog
              agent={AGENT}
              workspaceId={WORKSPACE_ID}
              open={open}
              onOpenChange={setOpen}
              onCreated={() => setOpen(false)}
              onOpenFullForm={() => undefined}
              onAddSource={() => undefined}
            />
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
