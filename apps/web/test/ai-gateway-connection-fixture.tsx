import type {
  ConnectionMetadata,
  CreateConnectionRequest,
  WorkspaceGatewayCustomModel,
} from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import {
  AiGatewayConnectionCardWithClient,
  OpenRouterConnectionCardWithClient,
} from "../src/components/ai-gateway-connection";
import "../src/styles.css";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-08-27T12:00:00.000Z";

function customModel(id: string, upstreamModelId: string): WorkspaceGatewayCustomModel {
  return {
    id,
    upstreamModelId,
    label: null,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function connectedProvider(
  provider: "gateway" | "openrouter",
  status: ConnectionMetadata["status"] = "active",
): ConnectionMetadata {
  const gateway = provider === "gateway";
  return {
    id: gateway ? "33333333-3333-4333-8333-333333333333" : "66666666-6666-4666-8666-666666666666",
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId,
    subjectId: null,
    providerDomain: gateway ? "ai-gateway.vercel.sh" : "openrouter.ai",
    kind: "api_key",
    status,
    grantedScopes: [],
    expiresAt: null,
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: status === "active" ? 1 : 2,
    metadata: gateway
      ? {
          credentialRole: "vercel_ai_gateway",
          credentialLabel: "Vercel AI Gateway",
        }
      : {
          credentialRole: "openrouter",
          credentialLabel: "OpenRouter",
        },
    createdBySubjectId: "user:fixture-admin",
    updatedBySubjectId: "user:fixture-admin",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const initialGatewayModels = [
  customModel("44444444-4444-4444-8444-444444444444", "anthropic/claude-sonnet-4.6"),
  customModel("55555555-5555-4555-8555-555555555555", "deepseek/deepseek-v3.2"),
];

const initialOpenRouterModels = [
  customModel("77777777-7777-4777-8777-777777777777", "google/gemini-2.5-pro"),
  customModel("88888888-8888-4888-8888-888888888888", "moonshotai/kimi-k2"),
];

function Fixture() {
  const [receipt, setReceipt] = useState<Record<string, unknown>>({ action: "ready" });
  const gatewayModelsRef = useRef([...initialGatewayModels]);
  const openRouterModelsRef = useRef([...initialOpenRouterModels]);
  const clientRef = useRef<OpenGeniBrowserClient | null>(null);
  if (!clientRef.current) {
    const createModel = async (
      provider: "gateway" | "openrouter",
      upstreamModelId: string,
      current: WorkspaceGatewayCustomModel[],
      commit: (models: WorkspaceGatewayCustomModel[]) => void,
    ): Promise<WorkspaceGatewayCustomModel> => {
      if (upstreamModelId.startsWith("fixture/deferred-")) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (
        upstreamModelId === "fixture/fail-add" ||
        upstreamModelId === "fixture/deferred-failure"
      ) {
        setReceipt({ action: "create-model-error", provider, upstreamModelId });
        throw new Error(`Fixture rejected this ${provider} model`);
      }
      const model = customModel(crypto.randomUUID(), upstreamModelId);
      commit([...current, model]);
      setReceipt({ action: "create-model", provider, upstreamModelId });
      return model;
    };

    clientRef.current = {
      listConnections: async () => [connectedProvider("gateway"), connectedProvider("openrouter")],
      listWorkspaceGatewayCustomModels: async () => ({ models: [...gatewayModelsRef.current] }),
      createWorkspaceGatewayCustomModel: async (_workspaceId, request) =>
        await createModel(
          "gateway",
          request.upstreamModelId,
          gatewayModelsRef.current,
          (models) => {
            gatewayModelsRef.current = models;
          },
        ),
      deleteWorkspaceGatewayCustomModel: async (_workspaceId, customModelId, request) => {
        gatewayModelsRef.current = gatewayModelsRef.current.filter(
          (model) => model.id !== customModelId,
        );
        setReceipt({
          action: "delete-model",
          provider: "gateway",
          customModelId,
          operationId: request.operationId,
        });
      },
      listWorkspaceOpenRouterCustomModels: async () => ({
        models: [...openRouterModelsRef.current],
      }),
      createWorkspaceOpenRouterCustomModel: async (_workspaceId, request) =>
        await createModel(
          "openrouter",
          request.upstreamModelId,
          openRouterModelsRef.current,
          (models) => {
            openRouterModelsRef.current = models;
          },
        ),
      deleteWorkspaceOpenRouterCustomModel: async (_workspaceId, customModelId, request) => {
        openRouterModelsRef.current = openRouterModelsRef.current.filter(
          (model) => model.id !== customModelId,
        );
        setReceipt({
          action: "delete-model",
          provider: "openrouter",
          customModelId,
          operationId: request.operationId,
        });
      },
      createConnection: async (_workspaceId, request: CreateConnectionRequest) => {
        const provider = request.providerDomain === "openrouter.ai" ? "openrouter" : "gateway";
        setReceipt({ action: "connect", provider, providerDomain: request.providerDomain });
        return connectedProvider(provider);
      },
      updateConnection: async (_workspaceId, connectionId) => {
        const provider = connectionId.startsWith("6666") ? "openrouter" : "gateway";
        setReceipt({ action: "replace-key", provider, connectionId });
        return connectedProvider(provider);
      },
      deleteConnection: async (_workspaceId, connectionId) => {
        const provider = connectionId.startsWith("6666") ? "openrouter" : "gateway";
        setReceipt({ action: "disconnect", provider, connectionId });
        return connectedProvider(provider, "revoked");
      },
    } as unknown as OpenGeniBrowserClient;
  }

  const connectionChanged = (provider: "gateway" | "openrouter") =>
    setReceipt((current) => ({ ...current, changed: true, provider }));

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
          canManageConnection
          canManageCustomModels
          onConnectionChange={() => connectionChanged("gateway")}
        />
      </section>
      <section aria-labelledby="openrouter-heading" className="grid gap-2">
        <h2 id="openrouter-heading" className="text-sm font-semibold">
          OpenRouter
        </h2>
        <OpenRouterConnectionCardWithClient
          client={clientRef.current}
          workspaceId={workspaceId}
          canManageConnection
          canManageCustomModels
          onConnectionChange={() => connectionChanged("openrouter")}
        />
      </section>
      <button type="button" aria-label="Fixture focus target" className="justify-self-start">
        Other workspace setting
      </button>
      <output data-testid="operation-receipt" className="sr-only">
        {JSON.stringify(receipt)}
      </output>
      <Toaster richColors theme="light" />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
