import type {
  ConnectionMetadata,
  CreateConnectionRequest,
  WorkspaceGatewayCustomModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import { AiGatewayConnectionCardWithClient } from "../src/components/ai-gateway-connection";
import "../src/styles.css";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-08-27T12:00:00.000Z";

function customModel(id: string, upstreamModelId: string): WorkspaceGatewayCustomModel {
  return { id, upstreamModelId, label: null, createdAt: timestamp, updatedAt: timestamp };
}

function connectedGateway(status: ConnectionMetadata["status"] = "active"): ConnectionMetadata {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId,
    subjectId: null,
    providerDomain: "ai-gateway.vercel.sh",
    kind: "api_key",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: status === "active" ? 1 : 2,
    metadata: {
      credentialRole: "vercel_ai_gateway",
      credentialLabel: "Vercel AI Gateway",
    },
    createdBySubjectId: "user:fixture-admin",
    updatedBySubjectId: "user:fixture-admin",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const initialModels = [
  customModel("44444444-4444-4444-8444-444444444444", "anthropic/claude-sonnet-4.6"),
  customModel("55555555-5555-4555-8555-555555555555", "deepseek/deepseek-v3.2"),
];

function Fixture() {
  const [receipt, setReceipt] = useState<Record<string, unknown>>({ action: "ready" });
  const clientRef = useRef<OpenGeniBrowserClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = {
      listConnections: async () => [connectedGateway()],
      listWorkspaceGatewayCustomModels: async () => ({ models: initialModels }),
      createWorkspaceGatewayCustomModel: async (_workspaceId, request) => {
        const model = customModel(crypto.randomUUID(), request.upstreamModelId);
        setReceipt({ action: "create-model", upstreamModelId: request.upstreamModelId });
        return model;
      },
      deleteWorkspaceGatewayCustomModel: async (_workspaceId, customModelId) => {
        setReceipt({ action: "delete-model", customModelId });
      },
      createConnection: async (_workspaceId, request: CreateConnectionRequest) => {
        setReceipt({ action: "connect", providerDomain: request.providerDomain });
        return connectedGateway();
      },
      updateConnection: async (_workspaceId, connectionId) => {
        setReceipt({ action: "replace-key", connectionId });
        return connectedGateway();
      },
      deleteConnection: async (_workspaceId, connectionId) => {
        setReceipt({ action: "disconnect", connectionId });
        return connectedGateway("revoked");
      },
    } as unknown as OpenGeniBrowserClient;
  }

  return (
    <main className="mx-auto grid min-h-screen max-w-3xl content-start gap-6 bg-surface-1 p-4 text-fg sm:p-8">
      <header className="grid gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
          Workspace settings
        </p>
        <h1 className="text-2xl font-semibold">AI model connections</h1>
        <p className="max-w-2xl text-sm text-fg-muted">
          Connect workspace-owned providers and curate the exact model slugs available to your team.
        </p>
      </header>
      <section aria-labelledby="gateway-heading" className="grid gap-2">
        <h2 id="gateway-heading" className="text-sm font-semibold">
          Vercel AI Gateway
        </h2>
        <AiGatewayConnectionCardWithClient
          client={clientRef.current}
          workspaceId={workspaceId}
          canManage
          onConnectionChange={() => setReceipt((current) => ({ ...current, changed: true }))}
        />
      </section>
      <output data-testid="operation-receipt" className="sr-only">
        {JSON.stringify(receipt)}
      </output>
      <Toaster richColors theme="light" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
