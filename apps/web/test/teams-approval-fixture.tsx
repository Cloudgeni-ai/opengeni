import { useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeConnectSetup } from "@opengeni/react/app/components/capabilities/native-connect-setup";
import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";
import "@/styles.css";
const required = new URLSearchParams(location.search).get("required") !== "false";
const attempt: ConnectAttempt = {
  id: "approval",
  workspaceId: "fixture",
  providerId: "microsoft-teams",
  ownership: "personal",
  revision: 1,
  state: "failed",
  nextAction: { type: "none" },
  credentialsCommitted: false,
  integrationInstalled: false,
  completionRequirement: "connection",
  expiresAt: "2030-01-01T00:00:00Z",
  error: {
    code: required ? "admin_consent_required" : "provider_denied",
    retryable: true,
    message:
      "Approval: https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=fixture&scope=offline_access",
  },
};
let begins = 0;
const transport: ConnectTransport = {
  catalog: async () => [],
  accounts: async () => [],
  pending: async () => [],
  begin: async (_workspaceId, input) => {
    document.body.dataset.idempotencyKey = input.idempotencyKey;
    begins++;
    document.body.dataset.begins = String(begins);
    return attempt;
  },
  get: async () => attempt,
  advance: async () => attempt,
  cancel: async () => attempt,
  disconnect: async () => {},
};
const request = {
  scope: { workspaceId: "fixture", transport },
  providerId: "microsoft-teams",
  ownership: "personal" as const,
  returnUrl: location.href,
  idempotencyKey: "fixture",
  displayName: "Microsoft Teams",
};
function Fixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Connect Teams</button>
      {open && (
        <NativeConnectSetup
          transport={transport}
          workspaceId="fixture"
          request={request}
          onClose={() => {
            setOpen(false);
            document.body.dataset.closed = "true";
          }}
          onComplete={() => {}}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
