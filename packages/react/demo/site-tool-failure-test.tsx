// Preview harness: the Opengeni frame's real messages when a Site's tool call
// stops, over a sample Site. Catalog and connection come from a synthetic
// client, so nothing reaches an API or Microsoft.
//   ?state=connect|reconnect|denied|retry|not_available|unknown   ?theme=light|dark
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectTransport } from "@opengeni/connect";
import type { CapabilityCatalogItem } from "@opengeni/sdk";
import { siteToolFailureMessage, type SiteToolFailure } from "@opengeni/sdk/site";
import { OpenGeniProvider } from "@opengeni/react";
import { AppContext } from "@opengeni/react/app/app-context";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { SiteToolConnect, SiteToolRecover } from "../src/app/lib/site-tool-consent-dialog";
import { PortalContainerProvider } from "../src/ui/portal-container";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const CONNECTION_ID = "0b9b8d5e-6f0f-4b8e-9d55-2d6c8a4c1f10";
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "retry";
const dark = params.get("theme") === "dark";
document.documentElement.dataset.ogTheme = dark ? "dark" : "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const DYNAMICS = {
  id: "cap-microsoft-dynamics-sample",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  name: "Microsoft Dynamics",
  enabled: true,
  stale: false,
  mcpUrl: "https://sample.crm.dynamics.com/api/mcp",
  providerDomain: "sample.crm.dynamics.com",
  description: "Read and update records in your Dynamics 365 environment.",
  metadata: { defaultConnectionOwnership: "personal" },
} as unknown as CapabilityCatalogItem;
const ACCOUNT = {
  id: CONNECTION_ID,
  providerDomain: DYNAMICS.providerDomain,
  kind: "oauth2",
  status: "needs_reauthorization",
  subjectScope: "user",
  metadata: { accountLabel: "ada@sample.example" },
};

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
    return { items: [DYNAMICS] } as never;
  }
  async listConnections() {
    return (state === "reconnect" ? [ACCOUNT] : []) as never;
  }
  async listOwnConnectionAccounts() {
    return (state === "reconnect" ? [ACCOUNT] : []) as never;
  }
  async listWorkspaceMembers() {
    return [] as never;
  }
  async downloadCatalogAsset(): Promise<Blob> {
    throw new Error("No catalog assets in this preview");
  }
}

const system = "Microsoft Dynamics";
const failure = (code: SiteToolFailure["code"], retryable: boolean): SiteToolFailure => ({
  code,
  system,
  message:
    code === "site_tool_not_available_for_viewer"
      ? "This Site uses an account that isn't yours, so it can't run this for you."
      : siteToolFailureMessage(code, system),
  reconnect:
    code === "site_tool_reconnect_required"
      ? { connectionId: CONNECTION_ID, capabilityId: DYNAMICS.id, name: system, shared: false }
      : null,
  retryable,
  detail:
    code === "site_tool_permission_denied"
      ? "Dataverse returned 403: Principal user is missing prvReadAccount privilege."
      : "API 404: tool_unavailable Reference: req_sample.",
  sourceCode: code === "site_tool_permission_denied" ? "provider_permission_denied" : "not_found",
});
const FAILURES: Record<string, SiteToolFailure> = {
  reconnect: failure("site_tool_reconnect_required", false),
  denied: failure("site_tool_permission_denied", false),
  retry: failure("site_tool_unavailable", true),
  not_available: failure("site_tool_not_available_for_viewer", false),
  unknown: failure("site_tool_outcome_unknown", false),
};

function Harness() {
  const client = useMemo(() => new PreviewClient(), []);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const signal = useMemo(() => new AbortController().signal, []);
  const context = useMemo(
    () =>
      ({
        client,
        accessContext: {
          subjectId: "user:ada",
          workspaceGrants: [
            { workspaceId: WORKSPACE_ID, permissions: ["sessions:control", "connections:write"] },
          ],
        },
        workspaces: [{ id: WORKSPACE_ID, kind: "team" }],
        workspaceCapabilityCatalog: [DYNAMICS],
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
          <div className="og-root min-h-screen bg-og-bg text-og-fg">
            {/* Sample Site content behind the Opengeni frame's message. */}
            <main className="mx-auto max-w-2xl px-6 py-10">
              <p className="text-og-xs text-og-fg-muted">Sample Site</p>
              <h1 className="mt-1 text-og-md font-semibold">Sales pipeline</h1>
              <p className="mt-3 text-og-sm text-og-fg-muted">
                {answer ?? "Loading opportunities from Microsoft Dynamics…"}
              </p>
            </main>
            <div ref={setLayer} />
            {layer && answer === null ? (
              <PortalContainerProvider container={layer}>
                {state === "connect" ? (
                  <SiteToolConnect
                    request={{
                      connect: {
                        capabilityId: DYNAMICS.id,
                        name: system,
                        providerDomain: DYNAMICS.providerDomain!,
                      },
                      signal,
                      workspaceId: WORKSPACE_ID,
                    }}
                    onDone={(ok) => setAnswer(`connected: ${ok}`)}
                  />
                ) : (
                  <SiteToolRecover
                    request={{
                      failure: FAILURES[state] ?? FAILURES.retry!,
                      signal,
                      workspaceId: WORKSPACE_ID,
                    }}
                    onDone={(again) => setAnswer(`again: ${again}`)}
                  />
                )}
              </PortalContainerProvider>
            ) : null}
          </div>
        </AppContext.Provider>
      </AppHostProvider>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
