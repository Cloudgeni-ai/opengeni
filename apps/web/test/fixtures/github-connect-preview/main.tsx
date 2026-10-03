import React from "react";
import { createRoot } from "react-dom/client";
import type { AuthNeededItem } from "@opengeni/react";

import { SessionCapabilityCard } from "../../../src/components/capabilities/session-capability-card";
import "../../../src/styles.css";
import { scenario, useSessionResources } from "./context";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "light" ? "light" : "dark";
// The app shell scrolls inside its panes; this preview scrolls the page.
for (const element of [document.documentElement, document.body]) {
  element.style.overflow = "auto";
  element.style.height = "auto";
}

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
    rationale: "Connect the product repository so I can open a pull request with the fix.",
    requiredVariables: [],
  },
} as AuthNeededItem;

function Preview() {
  const resources = useSessionResources();
  return (
    <main data-scenario={scenario} className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-3xl">
        <p className="mb-6 text-xs text-fg-muted">Sample conversation · production connection card</p>
        <div className="mb-8 flex justify-end">
          <p className="rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm">
            Fix the flaky checkout test and open a PR
          </p>
        </div>
        <p className="mb-4 text-sm text-fg-muted">
          I need access to the repository to clone it and open a pull request.
        </p>
        <SessionCapabilityCard
          item={item}
          workspaceId="sample"
          sessionId="sample-session"
          resources={resources as never}
          onConfigured={async () => {}}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
