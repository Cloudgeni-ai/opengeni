import { OpenGeniClient } from "@opengeni/sdk";
import { OpenGeniProvider } from "@opengeni/react";
import { ComputerViewer } from "@opengeni/react/interaction";
import { createRoot } from "react-dom/client";
import { createDemoComputerWebSocketFactory } from "./fake-computer";
import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
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
    ? createDemoComputerWebSocketFactory((computerSessionId, targetId) =>
        client.demoComputerFrameTarget(computerSessionId, targetId),
      )
    : undefined;

createRoot(document.getElementById("root")!).render(
  <OpenGeniProvider client={client} workspaceId={workspaceId}>
    <main className="og-root flex h-dvh min-h-0 flex-col bg-og-bg text-og-fg">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-og-border px-4">
        <div className="min-w-0">
          <p className="truncate text-og-sm font-semibold">ComputerSession reference</p>
          <p className="truncate text-og-xs text-og-fg-subtle">
            Public SDK + React surface · {mode}
          </p>
        </div>
        <span className="rounded-og-sm border border-og-border px-2 py-1 font-og-mono text-og-xs text-og-fg-muted">
          {sessionId}
        </span>
      </header>
      <ComputerViewer
        sessionId={sessionId}
        {...(webSocketFactory ? { webSocketFactory } : {})}
        className="min-h-0 flex-1"
      />
    </main>
  </OpenGeniProvider>,
);
