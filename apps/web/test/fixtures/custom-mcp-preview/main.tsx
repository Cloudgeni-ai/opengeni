import React from "react";
import { createRoot } from "react-dom/client";
import type { AuthNeededItem } from "@opengeni/react";
import { SessionCapabilityCard } from "../../../src/components/capabilities/session-capability-card";
import "../../../src/styles.css";

const item = {
  id: "sample-custom-mcp",
  kind: "auth-needed",
  source: "capability",
  serverId: "opengeni",
  providerDomain: "mcp.records.example",
  reason: "missing_connection",
  setupRequest: {
    kind: "mcp",
    name: "Records MCP",
    endpointUrl: "https://mcp.records.example/mcp",
    rationale: "Connect your records server to find the documents you asked about.",
  },
} as AuthNeededItem;

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
    <div className="mx-auto max-w-3xl">
      <p className="mb-6 text-xs text-fg-muted">Sample conversation · production connection card</p>
      <div className="mb-8 flex justify-end">
        <p className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
          Find my documents using our Records MCP server.
        </p>
      </div>
      <SessionCapabilityCard item={item} workspaceId="sample" sessionId="sample-session" />
    </div>
  </main>,
);