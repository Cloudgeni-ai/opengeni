import {
  DirectModelProviderMetadata,
  directModelBaseUrl,
  directModelConnectionSpec,
  type DirectModelProvider,
} from "@opengeni/contracts";
import type { ConnectionMetadata } from "@opengeni/sdk";
import { OpenGeniApiError, type OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { useRef, useState } from "react";
import { toast } from "sonner";

import type { ProviderConnectState } from "@/components/ai-gateway-connection";
import { ORGANIZATION_PROVIDER_META } from "@/components/models/provider-metadata";
import { providerRefusalText } from "@/components/organization-model-provider-connection";
import { ProviderTile } from "@opengeni/react/app/components/models/provider-mark";
import {
  beginIntegrationConnect,
  integrationConnectErrorOutcome,
  modelConnectionClass,
} from "@opengeni/react/app/lib/integration-connect-analytics";
import {
  invalidateModelSettingsQueries,
  MODEL_SETTINGS_STALE_TIME_MS,
  useSharedQuery,
} from "@opengeni/react/app/lib/shared-query";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConfirmDialog } from "@opengeni/react/ui/confirm-dialog";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { ListRow } from "@opengeni/react/ui/list-row";

import type { ConnectCompatibleEndpoint } from "./organization-compatible-endpoints";

/* ----------------------------------------------------------------------------
   A workspace's own model keys: OpenAI, Azure OpenAI and custom
   OpenAI-compatible endpoints a workspace's admins connected for that
   workspace alone. They are connected from Connect provider with the same
   steps as the organization's (ProviderConnectPage and
   CompatibleEndpointConnectPage); only where the key lives differs. Each key
   serves one model, is checked with a short test request before it is saved,
   and is listed with the workspace's other accounts.
   -------------------------------------------------------------------------- */

/** The workspace's own model keys, metadata only. */
export function useWorkspaceModelKeys(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  enabled: boolean,
) {
  const query = useSharedQuery(
    client,
    ["model-settings", "direct-connections", workspaceId],
    () => client.listConnections(workspaceId),
    { staleTimeMs: MODEL_SETTINGS_STALE_TIME_MS, enabled },
  );
  return {
    keys: (query.data ?? []).filter((row) => directModelConnectionSpec(row)),
    loading: enabled && query.data === undefined && !query.error,
  };
}

/** How a workspace key is named in its row: "Azure OpenAI", or a custom endpoint's name. */
function modelKeyTitle(connection: ConnectionMetadata): string {
  const spec = directModelConnectionSpec(connection);
  if (spec?.provider === "openai") return ORGANIZATION_PROVIDER_META.openai.title;
  if (spec?.provider === "azure_openai") return ORGANIZATION_PROVIDER_META.azure_openai.title;
  const label = connection.metadata.credentialLabel;
  return typeof label === "string" && label ? label : connection.providerDomain;
}

/** Save a workspace key after the API's short test request; returns the connection. */
async function createWorkspaceModelKey(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  config: DirectModelProviderMetadata,
  apiKey: string,
  operationId: string,
): Promise<ConnectionMetadata> {
  const providerDomain = new URL(directModelBaseUrl(config)).hostname;
  const create = () =>
    client.createConnection(workspaceId, {
      providerDomain,
      kind: "api_key",
      subjectId: null,
      credential: { apiKey },
      grantedScopes: [],
      metadata: {
        credentialRole: `direct_${config.provider}`,
        credentialLabel:
          config.provider === "openai_compatible"
            ? (config.label ?? providerDomain)
            : config.provider === "openai"
              ? "OpenAI"
              : "Azure OpenAI",
        directModelProvider: config,
      },
      operationId,
      verifyModelAccess: true,
    });
  let connection: ConnectionMetadata;
  try {
    connection = await create();
  } catch (error) {
    // Its operation id makes asking again safe when the answer was lost.
    if (!(error instanceof OpenGeniApiError) || !error.outcomeUnknown) throw error;
    connection = await create();
  }
  await invalidateModelSettingsQueries(client);
  return connection;
}

/**
 * The workspace side of an OpenAI or Azure OpenAI connect step: the same
 * fields as the organization's, saved as this workspace's own key.
 */
export function useWorkspaceModelKeyConnect({
  client,
  workspaceId,
  provider,
  canManage,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  provider: Extract<DirectModelProvider, "openai" | "azure_openai">;
  canManage: boolean;
}): ProviderConnectState {
  const operation = useRef<{ signature: string; id: string } | null>(null);
  const meta = ORGANIZATION_PROVIDER_META[provider];
  return {
    config: meta,
    organization: false,
    accessTarget: { client, workspaceId, kind: provider, connectionId: "", enabled: false },
    // A workspace can hold several keys; each connect step adds one.
    connected: false,
    canManageConnection: canManage,
    signInMethods: ["api_key"],
    refreshConnection: () => invalidateModelSettingsQueries(client),
    async saveKey(apiKey, options) {
      const key = apiKey.trim();
      const config = DirectModelProviderMetadata.safeParse({
        provider,
        model: options?.models?.[0],
        ...(provider === "azure_openai" ? { endpoint: options?.endpoint } : {}),
      });
      if (!key || !config.success) return false;
      const signature = JSON.stringify([key, config.data]);
      if (operation.current?.signature !== signature)
        operation.current = { signature, id: crypto.randomUUID() };
      const journey = beginIntegrationConnect(modelConnectionClass(provider) ?? "other", "api_key");
      try {
        await createWorkspaceModelKey(client, workspaceId, config.data, key, operation.current.id);
        journey.finish("connected");
        operation.current = null;
        toast.success(`${meta.title} connected`);
        return true;
      } catch (error) {
        journey.finish(integrationConnectErrorOutcome(error));
        if (options?.reportError) options.reportError(providerRefusalText(error));
        else toast.error(`Couldn't connect ${meta.title}`, { description: userErrorText(error) });
        return false;
      }
    },
  };
}

/** Connect a custom endpoint as one workspace's own key. */
export function workspaceEndpointConnect(
  client: OpenGeniBrowserClient,
  workspaceId: string,
): ConnectCompatibleEndpoint {
  return async (request, operationId) => {
    const config = DirectModelProviderMetadata.parse({
      provider: "openai_compatible",
      baseUrl: request.baseUrl,
      model: request.model,
      api: request.api,
      ...(request.label ? { label: request.label } : {}),
    });
    const connection = await createWorkspaceModelKey(
      client,
      workspaceId,
      config,
      request.apiKey,
      operationId,
    );
    return { id: connection.id, title: modelKeyTitle(connection) };
  };
}

/**
 * One row per workspace key, with the workspace's other accounts: its
 * provider, who uses it and the model it serves. Disconnecting asks first;
 * changing a key or model is connecting again, since each key serves one model.
 */
export function WorkspaceModelKeyRows({
  client,
  workspaceId,
  keys,
  scope,
  canManage,
  onChange,
}: {
  client: OpenGeniBrowserClient;
  workspaceId: string;
  keys: readonly ConnectionMetadata[];
  /** Who uses the key: "Everyone in Design". */
  scope: string;
  canManage: boolean;
  onChange: () => void;
}) {
  const [disconnecting, setDisconnecting] = useState<ConnectionMetadata | null>(null);
  return (
    <>
      {keys.map((connection) => {
        const spec = directModelConnectionSpec(connection)!;
        return (
          <ListRow
            key={connection.id}
            leading={<ProviderTile provider={spec.provider} size="lg" />}
            title={modelKeyTitle(connection)}
            meta={[scope, "API key", spec.model]}
            menu={
              canManage ? (
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDisconnecting(connection)}
                >
                  Disconnect
                </DropdownMenuItem>
              ) : undefined
            }
          />
        );
      })}
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        title={disconnecting ? `Disconnect ${modelKeyTitle(disconnecting)}?` : ""}
        description="Its model leaves this workspace’s model menu and its key is deleted. To use it again, connect it again."
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={async () => {
          if (!disconnecting) return;
          try {
            await client.deleteConnection(workspaceId, disconnecting.id);
          } catch (error) {
            toast.error(userErrorText(error, "Couldn't disconnect"));
            return false;
          }
          await invalidateModelSettingsQueries(client);
          onChange();
        }}
      />
    </>
  );
}
