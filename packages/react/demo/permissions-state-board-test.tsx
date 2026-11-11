import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  ConnectorToolPermission,
  ConnectorToolPermissionEntry,
  ConnectorToolPermissionsResponse,
} from "@opengeni/contracts";
import { OpenGeniApiError } from "@opengeni/sdk";
// @ts-expect-error -- dev-only: the demo Vite alias resolves this to the web app's source.
import { ConnectorToolPermissions } from "@/components/capabilities/connector-tool-permissions";
import { setDemoClient } from "./web-context-stub";
import "../../../apps/web/src/styles.css";
import "./approval-state-board.css";

// The real settings component, fed synthetic responses. Each scenario shows
// which setting decides a tool: recommendation, connector default, the tool's
// own choice, a per-action choice, or a conflict that blocks.
const tool = (
  name: string,
  title: string,
  group: ConnectorToolPermissionEntry["group"],
  permission: ConnectorToolPermission,
  source: NonNullable<ConnectorToolPermissionEntry["source"]>,
  extra: Partial<ConnectorToolPermissionEntry> = {},
): ConnectorToolPermissionEntry => ({
  name,
  title,
  group,
  permission,
  source,
  inherited: source === "recommended" || source === "connector_default",
  approvalRequired: permission === "ask",
  ...extra,
});
const base: ConnectorToolPermissionsResponse = {
  connectionId: "example-connection",
  serverId: "mail",
  defaultPermission: null,
  discoveryError: null,
  canManage: true,
  revision: "1",
  accountLabel: "Gmail · alex@example.test",
  tools: [
    tool("search_messages", "Search messages", "read", "allow", "recommended"),
    tool("read_message", "Read message", "read", "allow", "recommended"),
    tool("send_message", "Send email", "write", "ask", "recommended"),
    tool("trash_message", "Move to Trash", "write", "ask", "recommended"),
  ],
};
const scenarios: Array<[string, string, ConnectorToolPermissionsResponse | "denied" | "error"]> = [
  ["recommended", "Recommended choices", base],
  [
    "sources",
    "Every effective source",
    {
      ...base,
      defaultPermission: "ask",
      tools: [
        tool("search_messages", "Search messages", "read", "allow", "tool"),
        tool("read_message", "Read message", "read", "ask", "connector_default"),
        tool("send_message", "Send email", "write", "block", "conflict"),
        tool("trash_message", "Move to Trash", "write", "allow", "action"),
        tool("modify_messages", "Change labels", "write", "ask", "tool", {
          conditional: true,
          actionPermissions: [{ actionName: "add_star", permission: "allow" }],
        }),
        tool("create_draft", "Create draft", "write", "ask", "tool", {
          resetReason: "operation_changed",
        }),
      ],
    },
  ],
  ["readonly", "View only", { ...base, canManage: false }],
  [
    "discovery",
    "Tools unavailable",
    { ...base, tools: [], discoveryError: "Couldn't reach Gmail to list its tools." },
  ],
  ["denied", "No access", "denied"],
  ["error", "Load failure", "error"],
];

function Scenario({ data }: { data: ConnectorToolPermissionsResponse | "denied" | "error" }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setDemoClient({
      getConnectorToolPermissions: async () => {
        if (data === "denied") throw new OpenGeniApiError(403, "Access denied");
        if (data === "error") throw new Error("Synthetic unavailable");
        return structuredClone(data);
      },
      updateConnectorToolPermissions: async () => undefined,
    });
    setReady(true);
  }, [data]);
  return ready ? <ConnectorToolPermissions workspaceId="example" capabilityId="mail" /> : null;
}

function Board() {
  const params = new URLSearchParams(location.search);
  const id = params.get("case") ?? "sources";
  const scenario = scenarios.find(([key]) => key === id) ?? scenarios[1]!;
  const dark = params.get("theme") === "dark";
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <div className="og-root board-shell">
      <main className="board-focus" style={{ maxWidth: 560 }}>
        <nav className="board-nav" aria-label="Scenarios">
          {scenarios.map(([key, label]) => (
            <a key={key} href={`?case=${key}`}>
              {label}
            </a>
          ))}
        </nav>
        <h2>{scenario[1]}</h2>
        <Scenario key={scenario[0]} data={scenario[2]} />
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Board />);
