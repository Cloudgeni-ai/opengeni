import { createRoot } from "react-dom/client";
import type { SandboxRecoveryProjection } from "@opengeni/sdk";
import { SandboxRecoveryActions } from "../src/components/session/sandbox-recovery-actions";
import { Button } from "@opengeni/react/ui/button";
import type { SandboxRecoveryClient } from "../src/lib/sandbox-recovery";
import "../src/styles.css";

// Real production controls/styles with synthetic failed-restore evidence.
const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const sessionId = crypto.randomUUID();
let projection: SandboxRecoveryProjection = {
  version: 1,
  status: "eligible",
  reason: null,
  checkpoint: null,
  operationId: null,
  target: {
    sessionId,
    sandboxGroupId: crypto.randomUUID(),
    leaseId: crypto.randomUUID(),
    routeEpoch: 0,
    authorityEpoch: 1,
    leaseEpoch: 3,
    workspaceGeneration: 7,
    archiveGeneration: 7,
    revision: "wa1:retained",
    restoreStatus: "unrecoverable",
    restoreCompletedAt: null,
  },
  retryAvailable: true,
  freshWorkspaceAvailable: true,
  groupSessionCount: 3,
};
const client: SandboxRecoveryClient = {
  getSandboxRecovery: async () => structuredClone(projection),
  recoverSandbox: async (_workspaceId, _sessionId, request) => {
    if (params.has("unknown")) throw new TypeError("response connection lost");
    projection = {
      version: 1,
      status: "restored",
      reason:
        "action" in request && request.action === "continue_fresh"
          ? "fresh_workspace_selected"
          : "archive_retry_selected",
      checkpoint: null,
      operationId: request.operationId,
    };
    return { outcome: "accepted", operationId: request.operationId, recovery: projection };
  },
};
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-2xl p-4 sm:p-8">
    <h1 className="text-lg font-semibold text-fg">Website maintenance</h1>
    <p className="mt-6 text-sm text-fg-muted">
      The message could not run because its workspace could not be restored.
    </p>
    <SandboxRecoveryActions
      client={client}
      workspaceId={crypto.randomUUID()}
      sessionId={sessionId}
      canControl
      structuralFailure
      retryActions={<Button size="sm">Retry message</Button>}
    />
  </main>,
);
