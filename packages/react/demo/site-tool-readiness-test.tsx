// Preview harness: a sample Site in the real Site frame asks `site.tools.$readiness`
// what each of its actions needs for this viewer and draws one button per
// state. A synthetic bridge answers, so nothing reaches an API or provider.
// "Connect" on the host flips one state and fires `$onReadinessChange`.
//   ?theme=light|dark
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ToolGatewaySiteReadinessTool } from "@opengeni/sdk";
import {
  PublishedHtmlArtifactFrame,
  type PublishedHtmlArtifactToolBridge,
} from "../src/components/artifacts/published-html-artifact-frame";
import "./styles.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.dataset.ogTheme = dark ? "dark" : "light";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const target = (toolName: string) => ({ identity: { serverId: "crm", toolName } });
const own = { connector: "CRM", account: "ada@example.com", shared: false };
const shared = { connector: "CRM", account: "ops@example.com", shared: true };
function sample(connected: boolean): ToolGatewaySiteReadinessTool[] {
  return [
    {
      target: target("list_records"),
      state: "ready",
      confirm: "never",
      runsAs: own,
      connector: "CRM",
    },
    {
      target: target("update_record"),
      state: "confirm",
      confirm: "always",
      runsAs: shared,
      connector: "CRM",
    },
    {
      target: target("assign_record"),
      state: "choose_account",
      confirm: "maybe",
      runsAs: null,
      connector: "CRM",
    },
    connected
      ? {
          target: target("create_invoice"),
          state: "ready",
          confirm: "maybe",
          runsAs: own,
          connector: "Billing",
        }
      : {
          target: target("create_invoice"),
          state: "connect",
          confirm: "never",
          runsAs: null,
          connector: "Billing",
        },
    {
      target: target("send_reminder"),
      state: "reconnect",
      confirm: "never",
      runsAs: own,
      connector: "Mail",
    },
    {
      target: target("delete_record"),
      state: "blocked",
      confirm: "never",
      runsAs: own,
      connector: "CRM",
    },
    {
      target: target("approve_quote"),
      state: "open_in_opengeni",
      confirm: "always",
      runsAs: null,
      connector: "CRM",
    },
    {
      target: target("export_all"),
      state: "unavailable",
      confirm: "never",
      runsAs: null,
      connector: null,
    },
  ];
}

// The Site: ordinary HTML and the Opengeni Site client. Its buttons follow
// readiness instead of failing on click.
const SITE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root { color-scheme: ${dark ? "dark" : "light"}; font: 14px/1.4 system-ui, sans-serif; }
  body { margin: 0; padding: 20px; background: ${dark ? "#17181a" : "#fff"}; color: ${dark ? "#ececec" : "#1b1b1b"}; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid ${dark ? "#2a2b2e" : "#eee"}; }
  ul { list-style: none; margin: 0; padding: 0; }
  small { display: block; color: ${dark ? "#9a9a9a" : "#6b6b6b"}; }
  button { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid ${dark ? "#3a3b3e" : "#d0d0d0"}; background: ${dark ? "#222326" : "#f7f7f7"}; color: inherit; }
  button:disabled { opacity: .5; }
</style></head><body>
<h1>Records</h1><ul id="actions"></ul>
<script src="/__opengeni/site-tools/client.js"></script>
<script>
  const site = createOpenGeniSiteClient();
  const labels = { list_records: "List records", update_record: "Update record", assign_record: "Assign record",
    create_invoice: "Create invoice", send_reminder: "Send reminder", delete_record: "Delete record",
    approve_quote: "Approve quote", export_all: "Export everything" };
  const targets = Object.keys(labels).map((toolName) => ({ identity: { serverId: "crm", toolName } }));
  function view(tool) {
    const as = tool.runsAs ? tool.runsAs.account + (tool.runsAs.shared ? " · Shared" : "") : "";
    switch (tool.state) {
      case "ready": return { button: "Run", note: as };
      case "confirm": return { button: "Run", note: (as ? as + " · " : "") + "Asks first" };
      case "choose_account": return { button: "Run", note: "Choose an account" };
      case "connect": return { button: "Connect " + tool.connector, note: "" };
      case "reconnect": return { button: "Sign in to " + tool.connector + " again", note: as };
      case "blocked": return { button: "Run", disabled: true, note: "Blocked by your tool permissions" };
      case "open_in_opengeni": return { button: "Open in Opengeni", note: "Confirm there" };
      default: return { button: "Run", disabled: true, note: "Not available to you" };
    }
  }
  async function draw() {
    const { tools } = await site.tools.$readiness(targets);
    const list = document.getElementById("actions");
    list.replaceChildren(...tools.map((tool) => {
      const shown = view(tool);
      const row = document.createElement("li");
      const text = document.createElement("div");
      text.textContent = labels[tool.target.identity.toolName];
      const note = document.createElement("small");
      note.textContent = shown.note;
      text.append(note);
      const button = document.createElement("button");
      button.textContent = shown.button;
      button.disabled = Boolean(shown.disabled);
      button.dataset.state = tool.state;
      row.append(text, button);
      return row;
    }));
  }
  site.tools.$onReadinessChange(draw);
  draw();
</script></body></html>`;

function Harness() {
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(connected);
  const listeners = useRef(new Set<() => void>());
  const bridge = useMemo<PublishedHtmlArtifactToolBridge>(
    () => ({
      catalog: async () => {
        throw new Error("Not part of this preview");
      },
      call: async () => {
        throw new Error("Not part of this preview");
      },
      readiness: async () => ({ version: 1, tools: sample(connectedRef.current) }),
      subscribeReadiness: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [],
  );
  return (
    <div className="og-root min-h-screen bg-og-bg p-6 text-og-fg">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-og-xs text-og-fg-muted">Sample Site in the Opengeni frame</p>
          <button
            type="button"
            className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
            onClick={() => {
              connectedRef.current = !connectedRef.current;
              setConnected(connectedRef.current);
              for (const listener of listeners.current) listener();
            }}
          >
            {connected ? "Simulate: disconnect Billing" : "Simulate: connect Billing"}
          </button>
        </div>
        <PublishedHtmlArtifactFrame
          html={SITE}
          title="Sample Site"
          theme={dark ? "dark" : "light"}
          toolBridge={bridge}
          className="h-[520px] w-full rounded-og-md border border-og-border"
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
