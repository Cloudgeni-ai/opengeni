import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectAttempt, ConnectTransport } from "@opengeni/connect";
import {
  IdentityLinkAccounts,
  IdentityLinkConsent,
  DeviceAuthorization,
} from "@opengeni/react/connect";
import { NativeConnectSetup } from "../src/components/capabilities/native-connect-setup";
import "../src/styles.css";
import "@opengeni/react/connect.css";

const state = new URLSearchParams(location.search).get("state") ?? "preview";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const target = {
  instanceKey: "finance-calendar",
  displayName: "Finance team calendar",
  expectedInstanceVersion: 4,
};
let attempt: ConnectAttempt = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId,
  providerId: "fixture-calendar",
  ownership: "workspace",
  revision: 2,
  state: "preview",
  credentialsCommitted: true,
  integrationInstalled: false,
  completionRequirement: "integration",
  installationTarget: target,
  expiresAt: "2030-01-01T00:00:00Z",
  nextAction: {
    type: "preview",
    previewId: "preview",
    contentHash: "a".repeat(64),
    operations: [
      { id: "read", label: "List calendar events", kind: "read" },
      { id: "write", label: "Create calendar events", kind: "write" },
    ],
  },
};
const transport: ConnectTransport = {
  catalog: async () => [],
  accounts: async () => [],
  disconnect: async () => {},
  pending: async () => {
    if (state === "loading") return new Promise(() => {});
    if (state === "error") throw new Error("Fixture unavailable");
    return state === "pending" ? [attempt] : [];
  },
  begin: async (_workspace, input) => {
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "providerId",
            "ownership",
            "returnUrl",
            "idempotencyKey",
            "reconnectAccountId",
            "installationTarget",
          ].includes(key),
      )
    )
      throw new Error("Presentation state leaked into API request");
    return attempt;
  },
  get: async () => attempt,
  advance: async (_workspace, _id, input) => {
    if (
      input.action.type !== "install" ||
      input.action.operationIds.length !== 1 ||
      input.action.operationIds[0] !== "read"
    )
      throw new Error("Explicit read-only review required");
    attempt = {
      ...attempt,
      state: "complete",
      integrationInstalled: true,
      revision: 3,
      nextAction: { type: "none" },
    };
    return attempt;
  },
  cancel: async () => ({
    ...attempt,
    state: "cancelled",
    nextAction: { type: "none" },
    revision: 3,
  }),
};
if (state === "credentials")
  attempt = {
    ...attempt,
    state: "credential_input",
    credentialsCommitted: false,
    nextAction: {
      type: "credentials",
      fields: [
        { name: "url", label: "OpenAPI document URL", required: true, secret: false },
        {
          name: "connectionId",
          label: "Service account (optional for public services)",
          required: false,
          secret: false,
          options: Array.from({ length: 30 }, (_, index) => ({
            value: `fixture-${index}`,
            label: `Finance service account ${index + 1}`,
          })),
        },
      ],
    },
  };
const link = {
  id: "44444444-4444-4444-8444-444444444444",
  accountId: "11111111-1111-4111-8111-111111111111",
  externalIdentityId: "55555555-5555-4555-8555-555555555555",
  externalIdentity: { source: "Acme internal product", externalId: "product-user-123" },
  nativeSubjectId: "user:fixture",
  status: "active" as const,
  revision: 2,
  permissions: ["sessions:read" as const, "connections:read" as const],
  expiresAt: null,
};
const linkClient = {
  listIdentityLinks: async () => ({
    links:
      state === "empty"
        ? []
        : [
            link,
            { ...link, id: "66666666-6666-4666-8666-666666666666", status: "revoked" as const },
          ],
    nextCursor: null,
  }),
  revokeIdentityLink: async () => ({ ...link, status: "revoked" as const, revision: 3 }),
  previewIdentityLink: async () => ({
    link: { ...link, status: "pending" as const, revision: 1, nativeSubjectId: null },
    externalIdentity: { externalId: "product-user-123", source: "Acme internal product" },
    organizationId: link.accountId,
    nativeSubjectId: link.nativeSubjectId,
  }),
  confirmIdentityLink: async () => link,
};
function Fixture() {
  const [closed, setClosed] = useState(false);
  return (
    <main className="mx-auto max-w-3xl p-6 text-fg">
      <h1 className="mb-5 text-xl font-semibold">Product access and connection setup</h1>
      {state === "device" ? (
        <DeviceAuthorization
          userCode="XAI-1234"
          verificationUri="https://auth.x.ai/device"
          providerLabel="xAI"
        />
      ) : state === "links" || state === "empty" ? (
        <IdentityLinkAccounts client={linkClient} workspaceId={workspaceId} />
      ) : state === "consent" ? (
        <IdentityLinkConsent
          client={linkClient}
          workspaceId={workspaceId}
          linkId={link.id}
          challenge={"x".repeat(43)}
        />
      ) : closed ? (
        <p role="status">Account setup finished.</p>
      ) : (
        <NativeConnectSetup
          transport={transport}
          workspaceId={workspaceId}
          request={{
            scope: { workspaceId, transport },
            providerId: attempt.providerId,
            ownership: "workspace",
            returnUrl: location.href,
            idempotencyKey: "fixture-operation",
            installationTarget: target,
          }}
          onClose={() => setClosed(true)}
          onComplete={() => setClosed(true)}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
