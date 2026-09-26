import React from "react";
import { createRoot } from "react-dom/client";
import type { AuthNeededItem } from "@opengeni/react";

import { SessionCapabilityCard } from "../../../src/components/capabilities/session-capability-card";
import "../../../src/styles.css";

const item = {
  id: "sample-github-request",
  kind: "auth-needed",
  providerDomain: "github.com",
  serverId: "opengeni",
  reason: "missing_connection",
  capability: {
    id: "api:github-app",
    kind: "api",
    name: "GitHub App",
    action: "connect",
    rationale: "Connect your GitHub account and choose the repositories this workspace can access.",
    requiredVariables: [],
  },
} as AuthNeededItem;

function Preview() {
  return (
    <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="mb-6 text-xs text-fg-muted">Sample conversation · production connection card</p>
        <div className="mb-8 flex justify-end">
          <p className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
            I want to connect a GitHub repo
          </p>
        </div>
        <p className="mb-4 text-sm text-fg-muted">Connect your GitHub account to continue.</p>
        <SessionCapabilityCard item={item} workspaceId="sample" sessionId="sample-session" />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);