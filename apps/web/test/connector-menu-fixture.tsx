// Uses the production menu with in-memory selections; never contacts a provider.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerMobilePlus } from "@/components/composer-mobile-plus";
import type { SessionToolSelection } from "@/components/pickers";
import type { McpServerOption } from "@/lib/session-tools";
import "@/styles.css";
import linearLogo from "../../../data/catalog/logos/linear-app-4b4a9f349c60.png";
import slackLogo from "../../../data/catalog/logos/slack-com-5a15dccc0dc0.jpg";

const initial: McpServerOption[] = [
  { id: "files", name: "Files" },
  { id: "docs", name: "Documents" },
  {
    id: "linear",
    name: "Linear",
    logoSrc: linearLogo,
    detail: "Personal account",
    connectionStatus: "reconnect",
  },
  {
    id: "slack",
    name: "Slack",
    logoSrc: slackLogo,
    detail: "Workspace connection",
    connectionStatus: "ready",
  },
  { id: "grafana-production", name: "Grafana · Production", connectionStatus: "ready" },
  { id: "grafana-staging", name: "Grafana · Staging", connectionStatus: "ready" },
];
function Preview() {
  const [servers, setServers] = useState(initial);
  const [selection, setSelection] = useState<SessionToolSelection>({
    mcpServerIds: new Set(initial.map((s) => s.id)),
    firstPartyToolIds: new Set(["session_get", "memory_search"]),
  });
  const [status, setStatus] = useState("Preview connections use sample data.");
  return (
    <main className="min-h-screen bg-bg px-6 text-fg">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6">
        <div>
          <p className="text-xs text-fg-subtle">Interactive preview</p>
          <h1 className="mt-2 text-xl font-semibold">Connectors, close to the conversation.</h1>
        </div>
        <p className="text-sm text-fg-muted">
          Open +, then Connectors. Switches affect this sample conversation. Reconnect simulates the
          return from authentication.
        </p>
        <div
          className="rounded-2xl border border-border bg-surface p-4 shadow-sm"
          data-og-composer-id="preview"
        >
          <textarea
            aria-label="Message"
            placeholder="What should the agent do?"
            className="h-24 w-full resize-none bg-transparent text-sm outline-none"
          />
          <div className="flex items-center gap-3">
            <ComposerMobilePlus
              fileUploadsEnabled={false}
              servers={servers}
              firstPartyTools={[]}
              selection={selection}
              onToolSelectionChange={setSelection}
              connectorActions={{
                onBrowse: () => setStatus("Browse opens the connector catalog in the app."),
                onManage: () => setStatus("Manage opens connection settings in the app."),
                onReconnect: (id) => {
                  setServers((current) =>
                    current.map((s) => (s.id === id ? { ...s, connectionStatus: "ready" } : s)),
                  );
                  setStatus("Linear reconnected (simulated).");
                },
              }}
            />
            <span className="text-xs text-fg-muted">OpenGeni</span>
          </div>
        </div>
        <p role="status" className="text-xs text-fg-subtle">
          {status}
        </p>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
