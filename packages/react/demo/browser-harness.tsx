import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniProvider } from "@opengeni/react";
import { BrowserViewer } from "@opengeni/react/interaction";
import { createRoot } from "react-dom/client";
import { createDemoBrowserWebSocketFactory } from "./fake-browser";
import { DEMO_BROWSER_SESSION_ID, MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import "./styles.css";

const MOCK_WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "live" ? "live" : "mock";
const workspaceId = params.get("workspaceId") ?? MOCK_WORKSPACE_ID;
const sessionId = params.get("sessionId") ?? MANAGER_SESSION_ID;
const client =
  mode === "live"
    ? new OpenGeniClient({
        baseUrl: "/demo-api",
        fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
      })
    : new MockOpenGeniClient();
const webSocketFactory =
  client instanceof MockOpenGeniClient
    ? createDemoBrowserWebSocketFactory((browserSessionId, targetId) =>
        client.demoBrowserFrameTarget(browserSessionId, targetId),
      )
    : undefined;

async function renderHarness() {
  if (client instanceof MockOpenGeniClient && params.get("lost") === "1") {
    const session = await client.getBrowserSession(workspaceId, DEMO_BROWSER_SESSION_ID);
    client.listBrowserSessions = async () => ({
      revision: 1,
      sessions: [{ ...session, lifecycle: "lost", failureCode: "provider_deadline_rotation" }],
    });
  }
  if (client instanceof MockOpenGeniClient && params.get("controlFailure") === "1") {
    // Keep the independent frame channel healthy to reproduce stale "Live"
    // status when a controller rejects clicks or typing.
    client.actInBrowser = async () => {
      throw new OpenGeniApiError(503, "Browser control temporarily unavailable");
    };
  }
  // Reproduce narrow docks and human handoff banners without a live sandbox.
  if (client instanceof MockOpenGeniClient && params.get("handoff") === "1") {
    const session = await client.getBrowserSession(workspaceId, DEMO_BROWSER_SESSION_ID);
    const { targets } = await client.listBrowserTargets(workspaceId, session.id);
    const target = targets[0]!;
    await client.createInteractionIntervention(workspaceId, {
      operationId: crypto.randomUUID(),
      resourceKind: "browser_session",
      resourceId: session.id,
      targetId: target.id,
      expectedControllerGeneration: target.controllerGeneration,
      expectedTargetGeneration: target.targetGeneration,
      expectedDocumentGeneration: target.documentGeneration,
      kind: "manual_login",
      reason:
        "Sign into your account, completing any verification in the browser. The agent will verify access afterward without posting.",
    });
  }
  createRoot(document.getElementById("root")!).render(
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <main
        data-og-theme={params.get("theme") === "light" ? "light" : "dark"}
        style={{ maxWidth: params.get("width") ? Number(params.get("width")) : undefined }}
        className="og-root mx-auto flex h-dvh min-h-0 flex-col bg-og-bg text-og-fg"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-og-border px-4">
          <div className="min-w-0">
            <p className="truncate text-og-sm font-semibold">BrowserSession reference</p>
            <p className="truncate text-og-xs text-og-fg-subtle">
              Public SDK + React surface · {mode}
            </p>
          </div>
          <span className="min-w-0 max-w-1/2 truncate rounded-og-sm border border-og-border px-2 py-1 font-og-mono text-og-xs text-og-fg-muted">
            {sessionId}
          </span>
        </header>
        <BrowserViewer
          sessionId={sessionId}
          {...(webSocketFactory ? { webSocketFactory } : {})}
          className="min-h-0 flex-1"
        />
      </main>
    </OpenGeniProvider>,
  );
}
void renderHarness();
